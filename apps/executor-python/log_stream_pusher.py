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

    async def _flush_now(self) -> None:
        """Drain every pending chunk to the admin API.

        刻意**不**取消 ``self.timer``：本方法正是 timer 任务自身调用的目标，
        在方法内 cancel 自己会让紧随其后的 await 抛 CancelledError——而它是
        BaseException，不被 ``except Exception`` 捕获，于是 chunks 已经 clear()
        却一条都没发出去（静默丢日志）。timer 的取消只由 :meth:`flush` 负责。
        """
        async with self._flush_lock:
            async with self._lock:
                if not self.chunks:
                    return
                chunks_to_flush = self.chunks[:]
                self.chunks.clear()
                # R123：切片被取走，记账同步归零（失败重试不会重复计入）。
                self._buffered_bytes = 0

            all_pushed = True
            for chunk in chunks_to_flush:
                try:
                    await self._push_chunk(chunk)
                except Exception as err:
                    all_pushed = False
                    logger.debug(
                        f"[LogStreamPusher] Failed to push chunk for execution {self.execution_id}: {err}"
                    )
                    # Continue with next chunks despite failure
            # P3（A8 对齐 node）: 缓冲清空且全部推送成功 → 复位背压告警闸，
            # 让下一次独立的背压事件仍能产出一条 warn（而非本执行终身静默）。
            if all_pushed:
                self._backpressure_warned = False

    async def flush(self) -> None:
        """Cancel any pending timer, then drain every buffered line."""
        timer = self.timer
        self.timer = None
        if timer is not None and not timer.done():
            timer.cancel()
            # gather(return_exceptions=True)：等待取消落地，但**不**把
            # CancelledError 传播给调用方（调用方自己没有被取消）。
            await asyncio.gather(timer, return_exceptions=True)
        await self._flush_now()

    async def _push_chunk(self, chunk: dict) -> None:
        """Push a single chunk to the admin API."""
        url = build_admin_api_url(f"/executions/{self.execution_id}/logs")

        # 走共享连接池 + 401 自愈：执行器对 admin 的出站请求只应有这一条路径
        # （O-24 连接池、R11 stale-credential self-heal）。此前这里每次 flush
        # 都新建 AsyncClient（连接无法复用），且 token 取用漏了 await。
        from scheduler import get_http_client

        token = await get_current_token()
        if not token:
            logger.debug(
                f"[LogStreamPusher] No token available for execution {self.execution_id}"
            )
            return

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
            logger.debug(
                f"[LogStreamPusher] Admin API returned {response.status_code} for execution "
                f"{self.execution_id}: {response.text}"
            )

    async def final_flush(self) -> None:
        """Final flush before destruction. Ensures all remaining lines are sent."""
        # 收尾：把半行缓冲当作最后一行发出（子进程最后一行常无换行符）。
        if self._partial:
            tail = self._partial
            self._partial = ''
            await self.add_line(tail[:-1] if tail.endswith('\r') else tail)
        await self.flush()

    def get_current_line(self) -> int:
        """Get the current line number (useful for tracking progress)."""
        return self.current_line
