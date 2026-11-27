"""
RT-LOG: Asynchronous log stream pusher for Python executor.
Buffers log lines and pushes them to the admin API in chunks (1s or 100 lines).
Non-blocking: failures are logged but do not interrupt task execution.
"""
import asyncio
import logging
from typing import List

from admin_api import build_admin_api_url
from auth import get_current_token, request_with_self_heal

logger = logging.getLogger(__name__)

# R123（R94-A1 遗留）：**字节**级背压上限。
#
# 背景算式（改前的实测推导，见 R116 检查点）：条数上限 10 片 × 100 行 = 1000 行，
# 而单行上限是 execute.py:753 的 1 MB ⇒ 内存上界 1000 × 1 MB ≈ **1 GB/执行**，
# 单次 POST body 上界也是 100 × 1 MB ≈ **100 MB**。条数上限**不构成字节安全边界**。
#
# 触发条件（两个同时成立才算真问题）：①单行接近 1 MB（base64 / 单行 JSON dump 常见）；
# ②admin 侧一轮 flush 内持续慢（`_push_chunk` timeout=5s，一轮最多 片数×5s = 50s）。
# 条件不成立时缓冲在 20 MB 量级，无害 —— 所以这两个值取「远高于稳态、远低于病态」。
MAX_BUFFERED_BYTES = 10_000_000
# 单次 push 的字节上限：按 admin `appendLogChunk` 的体量取 1 MB/片。
MAX_BYTES_PER_CHUNK = 1_000_000

# R125：丢行必须在**流里留下可见的一行**。
#
# 此前丢行只在执行器本地日志里 warn 一次，而**实时视图里行号会直接从 1 跳到 900** ——
# 没有任何一行说明「中间丢了 900 行」。**一个静默的缺口，看起来就像一段正常的日志。**
#
# 刻意**不**复用 admin 的 `LOG_TRUNCATION_MARKER`（`/[\s*(?:logs\s+)?truncated\b/i`）：
# 那条正则在 admin 侧参与「终态回调是否用回调日志覆盖实时流」的判定（task.service.ts:5105/5122），
# 我们不想让执行器本地背压去影响那个决策。这里用一个只对人说话、不参与任何判定的文案。
MARKER_TEMPLATE = '... [{n} log lines dropped by local backpressure] ...'

# EN-03（与 executor-node log-stream-pusher.ts 对齐）：推送重试耗尽后的丢行
# marker。与背压 marker 走同一条通道（占用缺口行号、单行成片），但文案区分原因
# ——背压是「本机产出快于上报」，这里是「上报连续失败」。刻意不复用 admin 的
# LOG_TRUNCATION_MARKER，理由同 MARKER_TEMPLATE（不参与终态「回调覆盖实时流」判定）。
PUSH_FAILURE_MARKER_TEMPLATE = (
    '... [{n} log lines dropped after repeated push failures] ...'
)

# NOTOKEN（与 executor-node log-stream-pusher.ts 对齐）：无令牌导致无法上报的
# 行也走同一条 marker 通道。旧实现 `_push_chunk` 只 debug 一句就 return，
# `_flush_now` 把它当成功、清空缓冲并复位告警闸 —— 实时视图从此静默缺一段。
# 这里用独立文案区分「本机没拿到上报凭据」与背压/重试耗尽；仍刻意不使用
# admin 的 LOG_TRUNCATION_MARKER，避免影响终态回调覆盖实时流的判定。
NO_TOKEN_MARKER_TEMPLATE = (
    '... [{n} log lines dropped because executor token was unavailable] ...'
)


class NoTokenError(RuntimeError):
    """Internal signal: an admin push was attempted without a usable token."""


# EN-03：同一片最多尝试推送几次（含首次）。失败片会回填队首重发，但没有上限
# 就是无限重发（admin 长期不可用时缓冲永远清不掉、final_flush 永远发不完）。
# 3 次 ≈ 3×5s 超时窗口，与 node 侧 MAX_PUSH_ATTEMPTS 逐字同值。
MAX_PUSH_ATTEMPTS = 3


def _utf8_len(text: str) -> int:
    """`text` 的 UTF-8 字节数。ASCII 走 `len()`（零拷贝），非 ASCII 才 encode。"""
    try:
        return len(text) if text.isascii() else len(text.encode('utf-8'))
    except Exception:
        return len(text)


class LogStreamPusher:
    """Async log stream pusher for real-time log streaming."""

    def __init__(self, execution_id: str):
        self.execution_id = execution_id
        self.chunks: List[dict] = []
        self.current_line = 0
        self.timer: asyncio.Task | None = None
        self.flush_interval = 1.0  # 1 second
        self.max_lines_per_chunk = 100
        self.max_chunks_in_memory = 10  # Backpressure limit
        self._lock = asyncio.Lock()
        # RT-LOG 修复：串行化 flush——timer 触发的 flush 与 final_flush 可能
        # 并发（前者在网络上 await 时后者进入），两者都会 splice 同一份 chunks。
        self._flush_lock = asyncio.Lock()
        # 跨 chunk 的半行缓冲：子进程输出按任意字节边界分片，一行可能被劈成
        # 两个 chunk。不做缓冲就会把「一行」记成「两行」——行号与最终回调日志
        # 对不上，且空行会被整批丢弃。
        self._partial = ''
        # P3（executor 一致性审计，对齐 node log-stream-pusher.ts A8）: 背压
        # 丢行的可观测性——每个执行限 1 条 warn（防风暴刷屏：背压本身是持续
        # 状态，逐行 warn 反而淹没日志），进入背压状态置位，成功清空缓冲后
        # 复位，允许后续再次丢行时再次告警一次。
        self._backpressure_warned = False
        # R123：在飞缓冲的字节记账（与条数上限并存）。
        self._buffered_bytes = 0
        # R125：自上次 flush 起被丢掉的行数，以及**第一条被丢行**的行号（marker 占用它）。
        self._dropped_since_flush = 0
        self._first_dropped_line = None
        # EN-03：推送失败的可观测性——与背压同样「每执行限 1 条 warn」，全量推送
        # 成功后复位，令下一次独立故障仍能告警一次。
        self._push_failure_warned = False
        # EN-03：当前丢弃窗口里是否有「重试耗尽」造成的丢行（决定 marker 文案）。
        self._dropped_by_push_failure = False
        # NOTOKEN：同一丢弃窗口也可能由「拿不到令牌」造成；单独记账，避免
        # 把无凭据丢行误标成背压或 admin 连续失败。
        self._dropped_by_no_token = False
        self._no_token_warned = False

    def _marker_text(self) -> str:
        """按当前丢弃窗口的主因选 marker 文案（通道不变、原因可区分）。"""
        if self._dropped_by_no_token:
            template = NO_TOKEN_MARKER_TEMPLATE
        elif self._dropped_by_push_failure:
            template = PUSH_FAILURE_MARKER_TEMPLATE
        else:
            template = MARKER_TEMPLATE
        return template.format(n=self._dropped_since_flush)

    def _make_marker_chunk(self) -> dict:
        text = self._marker_text()
        # `isMarker` 只在本机流转，不会进入 POST body（_push_chunk 只取
        # fromLine/lines）；它让 marker 自身丢了之后不再递归生成新 marker。
        return {
            'fromLine': self._first_dropped_line,
            'lines': [text],
            'bytes': len(text),
            'isMarker': True,
        }

    def _clear_drop_accounting(self) -> None:
        self._dropped_since_flush = 0
        self._first_dropped_line = None
        self._dropped_by_push_failure = False
        self._dropped_by_no_token = False

    def _record_dropped_chunk(self, chunk: dict, reason: str) -> None:
        """把一整片计入丢行窗口；marker 片自身不再递归记账。"""
        if chunk.get('isMarker'):
            return
        if self._first_dropped_line is None:
            self._first_dropped_line = chunk['fromLine']
        self._dropped_since_flush += len(chunk['lines'])
        if reason == 'no_token':
            self._dropped_by_no_token = True
        else:
            self._dropped_by_push_failure = True

    async def _queue_marker_chunk(self, marker: dict) -> None:
        """把 marker 放回队首，供令牌恢复后的下一次 flush 补发。"""
        async with self._lock:
            self.chunks.insert(0, marker)
            self._buffered_bytes = sum(
                int(c.get('bytes', 0) or 0) for c in self.chunks
            )

    async def add_line(self, content: str) -> int:
        """Add a line to the buffer. Returns the line number assigned to this line."""
        async with self._lock:
            line_num = self.current_line
            self.current_line += 1

            line_bytes = _utf8_len(content)

            # Find the most recent chunk or create a new one.
            # R123：除条数外**还按字节**切片 —— 100 行 × 1 MB = 100 MB 的单个 POST 体，
            # 既超出 admin 合理载荷，也把「一次失败重试」的成本放大两个数量级。
            need_new_chunk = (
                not self.chunks
                or len(self.chunks[-1]['lines']) >= self.max_lines_per_chunk
                or self.chunks[-1].get('bytes', 0) + line_bytes > MAX_BYTES_PER_CHUNK
            )
            if need_new_chunk:
                chunk = {'fromLine': line_num, 'lines': [], 'bytes': 0}
                self.chunks.append(chunk)
            else:
                chunk = self.chunks[-1]

            chunk['lines'].append(content)
            chunk['bytes'] = chunk.get('bytes', 0) + line_bytes
            self._buffered_bytes += line_bytes

            # Backpressure: 条数 + 字节两个维度任一超限即丢最旧的切片（=**保留尾部**：
            # 执行失败的原因几乎总在最后几行）。先记账再判，才能让「单行就超预算」
            # 这种病态输入也被收住（否则它会绕过检查）。
            while self.chunks and (
                len(self.chunks) > self.max_chunks_in_memory
                or self._buffered_bytes > MAX_BUFFERED_BYTES
            ):
                dropped = self.chunks.pop(0)
                self._buffered_bytes -= dropped.get('bytes', 0)
                # R125：记下丢弃窗口的起点（marker 行占用「第一条被丢行」的行号，
                # 这样它落在缺口所在的位置，而不是堆到流末尾）。
                if self._first_dropped_line is None:
                    self._first_dropped_line = dropped.get('fromLine', 0)
                self._dropped_since_flush += len(dropped.get('lines', []))
                if self._buffered_bytes < 0:  # 记账保守兜底，绝不为负
                    self._buffered_bytes = 0
                # P3（A8 对齐 node）: 丢行从 debug 升级为 warn（每执行限
                # 1 条）。被丢弃的行不会再出现在实时流里（执行结束的回调
                # 日志不受影响，那走另一条持久化路径），属于「实时视图
                # 缺口」级别的信号，运维需要从日志里看到它发生。
                if not self._backpressure_warned:
                    self._backpressure_warned = True
                    logger.warning(
                        f"[LogStreamPusher] Backpressure: dropping buffered log lines for execution "
                        f"{self.execution_id} (admin API slower than producer; subsequent drops "
                        f"will not be logged again)"
                    )
                logger.debug(
                    f"[LogStreamPusher] Dropped {len(dropped['lines'])} lines due to backpressure "
                    f"for execution {self.execution_id}"
                )
            self._schedule_flush()

        return line_num

    async def add_output(self, output: str) -> None:
        """Feed a raw (possibly partial) stdout/stderr chunk.

        只按 ``\\n`` 切分并保留尾部半行，直到下一片补齐或 :meth:`final_flush`
        收尾——空行是**真实日志行**，必须与回调日志逐行对齐，不能过滤掉。
        """
        if not output:
            return
        text = self._partial + output
        segments = text.split('\n')
        self._partial = segments.pop()
        for segment in segments:
            await self.add_line(segment[:-1] if segment.endswith('\r') else segment)

    def _schedule_flush(self) -> None:
        """Schedule a flush if not already scheduled."""
        if self.timer is not None and not self.timer.done():
            return

        async def delayed_flush():
            try:
                await asyncio.sleep(self.flush_interval)
                await self._flush_now()
            except asyncio.CancelledError:
                raise
            except Exception as err:
                logger.debug(
                    f"[LogStreamPusher] Flush failed for execution {self.execution_id}: {err}"
                )

        self.timer = asyncio.create_task(delayed_flush())

    async def _flush_now(self, *, final: bool = False) -> None:
        """Drain every pending chunk to the admin API.

        刻意**不**取消 ``self.timer``：本方法正是 timer 任务自身调用的目标，
        在方法内 cancel 自己会让紧随其后的 await 抛 CancelledError——而它是
        BaseException，不被 ``except Exception`` 捕获，于是 chunks 已经 clear()
        却一条都没发出去（静默丢日志）。timer 的取消只由 :meth:`flush` 负责。
        """
        async with self._flush_lock:
            async with self._lock:
                # EN-03：缓冲已空但仍有丢弃记账时必须继续——「重试耗尽丢片」之后
                # 缓冲正好是空的，若按旧逻辑直接 return，这一段的缺口对实时视图
                # 完全不可见（对齐 node flushNow 的同一判断）。
                if not self.chunks and self._first_dropped_line is None:
                    return
                chunks_to_flush = self.chunks[:]
                self.chunks.clear()
                # R123：切片被取走，记账同步归零（失败重试不会重复计入）。
                self._buffered_bytes = 0

            # R125：先推**一行 marker**（占用第一条被丢行的行号），再推真实切片。
            # 单行成片是安全的：每片自带 fromLine，admin 按 fromLine+i 落库，
            # 所以插入这一行**不会**让后续切片的行号错位。
            if self._first_dropped_line is not None:
                marker = self._make_marker_chunk()
                self._clear_drop_accounting()
                chunks_to_flush.insert(0, marker)

            all_pushed = True
            pushed = 0
            try:
                i = 0
                while i < len(chunks_to_flush):
                    chunk = chunks_to_flush[i]
                    try:
                        await self._push_chunk(chunk)
                    except NoTokenError as err:
                        # NOTOKEN：无令牌不是普通网络失败，也没有 HTTP 请求发出。
                        # 单独计数、单独告警：恢复令牌后原片可立即补发，旧的重试
                        # 预算不被吃掉；到上限（或 final_flush）才丢片并留 marker。
                        all_pushed = False
                        token_failures = int(chunk.get('token_failures', 0)) + 1
                        chunk['token_failures'] = token_failures
                        if not self._no_token_warned:
                            self._no_token_warned = True
                            logger.warning(
                                f"[LogStreamPusher] No token available for execution "
                                f"{self.execution_id}; log chunk (fromLine "
                                f"{chunk['fromLine']}, {len(chunk['lines'])} lines) "
                                f"stays queued for up to {MAX_PUSH_ATTEMPTS} attempts "
                                f"(subsequent no-token failures stay at warn-once): {err}"
                            )
                        exhausted = final or token_failures >= MAX_PUSH_ATTEMPTS
                        if chunk.get('isMarker'):
                            # marker 本身丢掉时不能再生成 marker（否则无 token 时
                            # 每轮 flush 都多一个待重发片，永远清不完）。
                            if exhausted:
                                logger.warning(
                                    f"[LogStreamPusher] {chunk['lines'][0]} "
                                    f"(marker retained locally for execution "
                                    f"{self.execution_id}; no token available)"
                                )
                            else:
                                async with self._lock:
                                    self.chunks.insert(0, chunk)
                                    self._buffered_bytes = sum(
                                        int(c.get('bytes', 0) or 0)
                                        for c in self.chunks
                                    )
                            i += 1
                            pushed += 1
                            continue
                        if exhausted:
                            self._record_dropped_chunk(chunk, 'no_token')
                            i += 1
                            pushed += 1
                            continue
                        requeue = chunks_to_flush[i:]
                        async with self._lock:
                            self.chunks = requeue + self.chunks
                            self._buffered_bytes = sum(
                                int(c.get('bytes', 0) or 0) for c in self.chunks
                            )
                        break
                    except Exception as err:
                        all_pushed = False
                        # EN-03：失败片不再 debug 后静默丢弃——记录本片失败次数
                        # （跨 flush 保留），回填队首重发；到上限才丢弃并留 marker。
                        failures = int(chunk.get('failures', 0)) + 1
                        chunk['failures'] = failures
                        if not self._push_failure_warned:
                            self._push_failure_warned = True
                            logger.warning(
                                f"[LogStreamPusher] Failed to push log chunk "
                                f"(fromLine {chunk['fromLine']}, {len(chunk['lines'])} lines) "
                                f"for execution {self.execution_id}; will retry "
                                f"(up to {MAX_PUSH_ATTEMPTS} attempts, subsequent failures "
                                f"stay at warn-once): {err}"
                            )
                        if failures >= MAX_PUSH_ATTEMPTS:
                            # 到上限 → 丢弃这一片，但**不得静默**：计入丢弃窗口，
                            # 下一次 flush 在缺口行号上推一行 marker（与背压同通道）。
                            logger.warning(
                                f"[LogStreamPusher] Dropping log chunk "
                                f"(fromLine {chunk['fromLine']}, {len(chunk['lines'])} lines) "
                                f"for execution {self.execution_id} after "
                                f"{failures} failed push attempts"
                            )
                            if chunk.get('isMarker'):
                                logger.warning(
                                    f"[LogStreamPusher] {chunk['lines'][0]} "
                                    f"(marker retained locally for execution "
                                    f"{self.execution_id})"
                                )
                            else:
                                self._record_dropped_chunk(chunk, 'push_failure')
                            i += 1
                            pushed += 1
                            continue
                        # 未到上限 → 本片连同**尚未尝试**的后续片一起回填队首
                        # （顺序不变），下一轮 flush 从这一片开始重发。刻意不再
                        # 继续推后续片：① 失败时继续打 admin 雪上加霜；② 跳过
                        # 发后面的片会让到达顺序与行号相反、实时视图乱序。
                        requeue = chunks_to_flush[i:]
                        async with self._lock:
                            self.chunks = requeue + self.chunks
                            self._buffered_bytes = sum(
                                int(c.get('bytes', 0) or 0) for c in self.chunks
                            )
                        break
                    i += 1
                    pushed += 1
            except asyncio.CancelledError:
                # G2（审计轮 #15）：本协程通常就是 `self.timer`。外部 `flush()`
                # 会 cancel 它，而此刻 chunks 已从 self.chunks 摘走、只存在于
                # 这个局部列表里 —— 取消会让剩余分片随协程销毁，而 flush() 紧接着
                # 的 `_flush_now()` 看到缓冲已空直接返回：**尾部日志静默丢失且无
                # marker**（`_first_dropped_line` 只覆盖背压丢行，不覆盖这条路径）。
                # 既然被取消，就把没发出去的部分塞回缓冲队首，交给调用方那次
                # `_flush_now()` 继续发。
                remaining = chunks_to_flush[pushed:]
                if remaining:
                    async with self._lock:
                        self.chunks = remaining + self.chunks
                        self._buffered_bytes = sum(
                            int(c.get("bytes", 0) or 0) for c in self.chunks
                        )
                    logger.debug(
                        f"[LogStreamPusher] Flush cancelled for execution {self.execution_id}; "
                        f"requeued {len(remaining)} chunk(s) instead of dropping them"
                    )
                raise
            # NOTOKEN：final_flush 是本执行最后一次排空机会。若这一轮因无令牌
            # （或重试耗尽）仍留下丢行记账，就地写一条可见 marker，并把它放回
            # 队首——进程若在此后拿到令牌并被再次 flush，marker 仍可补发。
            if final and self._first_dropped_line is not None:
                marker = self._make_marker_chunk()
                logger.warning(
                    f"[LogStreamPusher] {marker['lines'][0]} "
                    f"(execution {self.execution_id} is finishing; marker retained locally)"
                )
                await self._queue_marker_chunk(marker)
                self._clear_drop_accounting()
            # P3（A8 对齐 node）: 缓冲清空且全部推送成功 → 复位背压告警闸与推送
            # 失败告警闸，让下一次独立的故障仍能产出一条 warn（而非终身静默）。
            if all_pushed:
                self._backpressure_warned = False
                self._push_failure_warned = False
                self._no_token_warned = False

    async def flush(self, *, final: bool = False) -> None:
        """Cancel any pending timer, then drain every buffered line."""
        timer = self.timer
        self.timer = None
        if timer is not None and not timer.done():
            timer.cancel()
            # gather(return_exceptions=True)：等待取消落地，但**不**把
            # CancelledError 传播给调用方（调用方自己没有被取消）。
            await asyncio.gather(timer, return_exceptions=True)
        await self._flush_now(final=final)

    async def _push_chunk(self, chunk: dict) -> None:
        """Push a single chunk to the admin API."""
        url = build_admin_api_url(f"/executions/{self.execution_id}/logs")

        # 走共享连接池 + 401 自愈：执行器对 admin 的出站请求只应有这一条路径
        # （O-24 连接池、R11 stale-credential self-heal）。此前这里每次 flush
        # 都新建 AsyncClient（连接无法复用），且 token 取用漏了 await。
        from scheduler import get_http_client

        token = await get_current_token()
        if not token:
            # NOTOKEN：抛内部信号而不是 return —— caller 才能区分「没有凭据」
            # 与「推送成功」，把原片回填或留 marker，而不是静默清缓冲。
            raise NoTokenError(
                f"执行 {self.execution_id} 暂无可用令牌"
            )

        response = await request_with_self_heal(
            get_http_client(),
            'post',
            url,
            token=token,
            json={
                'fromLine': chunk['fromLine'],
                'lines': chunk['lines'],
            },
            timeout=5.0,
        )

        if response.status_code not in (200, 201):
            # EN-03：4xx/5xx 不能再只 debug 后静默继续——必须向上抛，交给
            # `_flush_now` 计入失败次数、回填队首重发；到上限才丢弃并留 marker。
            # （网络异常本来就会从 request_with_self_heal 抛出，走同一条重试路径。）
            raise RuntimeError(
                f"[日志推送] 管理端返回状态码 {response.status_code} "
                f"for execution {self.execution_id}: {response.text}"
            )

    async def final_flush(self) -> None:
        """Final flush before destruction. Ensures all remaining lines are sent."""
        # 收尾：把半行缓冲当作最后一行发出（子进程最后一行常无换行符）。
        if self._partial:
            tail = self._partial
            self._partial = ''
            await self.add_line(tail[:-1] if tail.endswith('\r') else tail)
        await self.flush(final=True)

    def get_current_line(self) -> int:
        """Get the current line number (useful for tracking progress)."""
        return self.current_line
