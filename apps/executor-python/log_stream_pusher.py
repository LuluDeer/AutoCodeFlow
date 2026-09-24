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

    async def add_line(self, content: str) -> int:
        """Add a line to the buffer. Returns the line number assigned to this line."""
        async with self._lock:
            line_num = self.current_line
            self.current_line += 1

            # Find the most recent chunk or create a new one
            if not self.chunks or len(self.chunks[-1]['lines']) >= self.max_lines_per_chunk:
                chunk = {'fromLine': line_num, 'lines': []}
                self.chunks.append(chunk)

                # Backpressure: drop oldest chunks if we exceed memory limit
                if len(self.chunks) > self.max_chunks_in_memory:
                    dropped = self.chunks.pop(0)
                    logger.debug(
                        f"[LogStreamPusher] Dropped {len(dropped['lines'])} lines due to backpressure "
                        f"for execution {self.execution_id}"
                    )
            else:
                chunk = self.chunks[-1]

            chunk['lines'].append(content)
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

            for chunk in chunks_to_flush:
                try:
                    await self._push_chunk(chunk)
                except Exception as err:
                    logger.debug(
                        f"[LogStreamPusher] Failed to push chunk for execution {self.execution_id}: {err}"
                    )
                    # Continue with next chunks despite failure

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
