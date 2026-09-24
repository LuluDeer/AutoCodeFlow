import { logger } from './logger';
import { post } from './admin-client';

interface LogChunk {
  fromLine: number;
  lines: string[];
}

/**
 * RT-LOG: Asynchronous log stream pusher.
 * Buffers log lines and pushes them to the admin API in chunks (1s or 100 lines).
 * Non-blocking: failures are logged but do not interrupt task execution.
 */
export class LogStreamPusher {
  private chunks: LogChunk[] = [];
  private currentLine = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly FLUSH_INTERVAL = 1000; // 1 second
  private readonly MAX_LINES_PER_CHUNK = 100;
  private readonly MAX_CHUNKS_IN_MEMORY = 10; // Backpressure limit
  // 跨 chunk 的半行缓冲：子进程输出按任意字节边界分片，一行可能被劈成两个
  // chunk。不做缓冲就会把「一行」记成「两行」——行号与最终回调日志对不上。
  private partial = '';

  constructor(private executionId: string) {}

  /**
   * Add a line to the buffer. Returns the line number assigned to this line.
   */
  addLine(content: string): number {
    const lineNum = this.currentLine;
    this.currentLine++;

    // Find the most recent chunk or create a new one
    let chunk = this.chunks[this.chunks.length - 1];
    if (!chunk || chunk.lines.length >= this.MAX_LINES_PER_CHUNK) {
      chunk = { fromLine: lineNum, lines: [] };
      this.chunks.push(chunk);

      // Backpressure: drop oldest chunks if we exceed memory limit
      if (this.chunks.length > this.MAX_CHUNKS_IN_MEMORY) {
        const dropped = this.chunks.shift();
        if (dropped) {
          logger.debug(`[LogStreamPusher] Dropped ${dropped.lines.length} lines due to backpressure for execution ${this.executionId}`);
        }
      }
    }

    chunk.lines.push(content);
    this.scheduleFlush();
    return lineNum;
  }

  /**
   * Feed a raw (possibly partial) stdout/stderr chunk.
   *
   * 只按 `\n` 切分并保留尾部半行，直到下一片补齐或 `finalFlush` 收尾——
   * 空行是**真实日志行**，必须与回调日志逐行对齐，不能过滤掉。
   */
  addOutput(output: string): void {
    if (!output) return;
    const text = this.partial + output;
    const segments = text.split('\n');
    this.partial = segments.pop() ?? '';
    for (const segment of segments) {
      this.addLine(segment.endsWith('\r') ? segment.slice(0, -1) : segment);
    }
  }

  /**
   * Schedule a flush if not already scheduled.
   */
  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(err => {
        logger.debug(`[LogStreamPusher] Flush failed for execution ${this.executionId}: ${err}`);
      });
    }, this.FLUSH_INTERVAL);
  }

  /**
   * Flush all pending chunks to the admin API.
   */
  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.chunks.length === 0) return;

    const chunksToFlush = this.chunks.splice(0, this.chunks.length);

    for (const chunk of chunksToFlush) {
      try {
        await this.pushChunk(chunk);
      } catch (err) {
        logger.debug(`[LogStreamPusher] Failed to push chunk for execution ${this.executionId}: ${err}`);
        // Continue with next chunks despite failure
      }
    }
  }

  /**
   * Push a single chunk to the admin API.
   *
   * 走 `admin-client.post`（而非裸 fetch）：令牌获取、`X-Executor-Token`/
   * `Authorization` 双头、admin 信封拆包、多 admin failover、401 自愈重试
   * 全部由该模块统一提供——执行器对 admin 的出站请求只应有这一条路径
   * （NETOPT-G P1-1 同款纪律，见 admin-http-agent.ts 头注）。
   */
  private async pushChunk(chunk: LogChunk): Promise<void> {
    const path = `/api/executions/${encodeURIComponent(this.executionId)}/logs`;

    const response = await post<{ count: number }>(path, {
      fromLine: chunk.fromLine,
      lines: chunk.lines,
    });

    if (response.status !== 200 && response.status !== 201) {
      logger.debug(
        `[LogStreamPusher] Admin API returned ${response.status} for execution ${this.executionId}`,
      );
    }
  }

  /**
   * Final flush before destruction. Ensures all remaining lines are sent.
   */
  async finalFlush(): Promise<void> {
    // 收尾：把半行缓冲当作最后一行发出（子进程最后一行常无换行符）。
    if (this.partial) {
      const tail = this.partial;
      this.partial = '';
      this.addLine(tail.endsWith('\r') ? tail.slice(0, -1) : tail);
    }
    await this.flush();
  }

  /**
   * Get the current line number (useful for tracking progress).
   */
  getCurrentLine(): number {
    return this.currentLine;
  }
}
