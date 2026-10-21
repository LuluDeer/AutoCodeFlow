import { logger } from './logger';
import { post } from './admin-client';
import { executorAddressHeaderFor } from './callback';

/** 子进程的哪一路输出。stdout/stderr 是两条独立的管道（见 routes/execute.ts）。 */
export type LogStream = 'stdout' | 'stderr';

interface LogChunk {
  fromLine: number;
  lines: string[];
  /** 本片已占用的 UTF-8 字节数（切片与背压的字节闸依据）。 */
  bytes: number;
}

/**
 * R164-A1: 与 `executor-python/log_stream_pusher.py` **逐字同值**的两道字节闸。
 *
 * 改前 node 侧只有条数上限（10 片 × 100 行 = 1000 行），单行长度无上限，
 * 而 admin 的 `AppendLogChunkDto` 允许单行 512KB（`LOG_LINE_MAX_LENGTH`）——
 * 即内存上界 ≈ 1000 × 512KB ≈ 512MB/执行、单次 POST body ≈ 100 × 512KB ≈ 51MB。
 * 条数上限**不构成字节安全边界**。python 侧在 R123 已按字节切（本文件同值），
 * 同一部署下两侧行为必须一致，否则「python 执行器的日志不会丢、node 的会丢 413」
 * 这种差异只有出故障时才会被发现。
 */
export const MAX_BYTES_PER_CHUNK = 1_000_000;
export const MAX_BUFFERED_BYTES = 10_000_000;

/**
 * 单片推送超时，**故意不再用 admin-client 的 20s 默认值**。
 *
 * 与 python 侧 `_push_chunk` 的 `timeout=5.0` 对齐：flush 已串行化，
 * 单片超时直接决定「一个慢 admin 会阻塞多久后续日志」。20s × 3 次重试 = 61s 的窗口
 * 里，正常产出的日志会被背压丢弃 —— 而丢的正是排障最需要的那段。
 */
export const PUSH_TIMEOUT_MS = 5_000;

/**
 * R164-A1: 丢行必须在**流里留下可见的一行**（对齐 python R125）。
 *
 * 只在本机 warn 时，实时视图的行号会直接从 100 跳到 1100 —— 没有任何一行说明
 * 中间丢了 100 行，**一个静默的缺口看起来就像一段正常的日志**。
 *
 * 刻意**不**复用 admin 的 `LOG_TRUNCATION_MARKER`（`/[\s*(?:logs\s+)?truncated\b/i`）：
 * 那条正则在 admin 侧参与「终态回调是否用回调日志覆盖实时流」的判定
 * （task.service.ts:5105/5122），执行器本地背压不该影响那个决策。
 */
export const BACKPRESSURE_MARKER = (n: number): string =>
  `... [${n} log lines dropped by local backpressure] ...`;

/** `text` 的 UTF-8 字节数（记账必须是字节：中文 1 字符 = 3 字节）。 */
function utf8Len(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * RT-LOG: Asynchronous log stream pusher.
 * Buffers log lines and pushes them to the admin API in chunks (1s / 100 lines / 1MB).
 * Non-blocking: failures are logged but do not interrupt task execution.
 */
export class LogStreamPusher {
  private chunks: LogChunk[] = [];
  private currentLine = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly FLUSH_INTERVAL = 1000; // 1 second
  private readonly MAX_LINES_PER_CHUNK = 100;
  private readonly MAX_CHUNKS_IN_MEMORY = 10; // Backpressure limit（条数闸）
  // 第四轮审计（A8）: 背压丢行的可观测性——每个执行限 1 条 warn（防风暴
  // 刷屏：背压本身是持续状态，逐行 warn 反而淹没日志），进入背压状态置位，
  // 成功清空缓冲后复位，允许后续再次丢行时再次告警一次。
  private backpressureWarned = false;
  // 跨 chunk 的半行缓冲（**按流隔离**）：子进程输出按任意字节边界分片，一行
  // 可能被劈成两个 chunk。不做缓冲就会把「一行」记成「两行」——行号与最终
  // 回调日志对不上。
  //
  // R164-A1：此前是**一个** `partial` 字段，被 stdout 与 stderr 两个 handler
  // 共用（routes/execute.ts 的 proc.stdout.on('data') / proc.stderr.on('data')
  // 都调 addOutput(output)）。两条管道各自按任意边界到达，于是 stdout 的一个
  // 残行会被拼到 stderr 的下一行前面（"out-partial" + "err-line\n" →
  // "out-partialerr-line"）：**一行内容张冠李戴，且行号跟着错位**。
  // python 侧没有这个问题——它把 stderr 合并进 stdout 的管道（execute.py:4074
  // 的 stderr=asyncio.subprocess.STDOUT），天然只有一条流；node 侧两条独立
  // 管道只能在 pusher 内按流各留一份残行。
  private partials = new Map<LogStream, string>();
  // R164-A1：在飞缓冲的字节记账（与条数上限并存），以及丢行窗口的记账。
  private bufferedBytes = 0;
  private droppedSinceFlush = 0;
  /** 自上次 flush 起**第一条**被丢行的行号（marker 占用它，落在缺口位置上）。 */
  private firstDroppedLine: number | null = null;
  // R164-A1：串行化 flush（对齐 python 的 `_flush_lock`）。timer 触发的 flush 与
  // finalFlush 此前可以并发：前者在网络上 await 时后者进入，两个 flush 各发一片，
  // **到达 admin 的顺序可能与行号顺序相反**（admin 按范围先删后插，两片不重叠，
  // 所以不会写坏数据，但 SSE 实时视图会看到 1100 行出现在 1000 行之前）；
  // 而且 finalFlush 会在在飞请求落地前就 resolve —— 结束路径「等日志发完」的
  // 语义其实是空的。
  private flushChain: Promise<void> = Promise.resolve();

  constructor(private executionId: string) {}

  /**
   * Add a line to the buffer. Returns the line number assigned to this line.
   */
  addLine(content: string): number {
    const lineNum = this.currentLine;
    this.currentLine++;
    const lineBytes = utf8Len(content);

    // Find the most recent chunk or create a new one.
    // R164-A1：除条数外**还按字节**切片——100 行 × 512KB 的单个 POST 既超出
    // admin 合理载荷，也会把「一次失败重试」的成本放大两个数量级（对齐 python R123）。
    let chunk = this.chunks[this.chunks.length - 1];
    if (
      !chunk
      || chunk.lines.length >= this.MAX_LINES_PER_CHUNK
      || chunk.bytes + lineBytes > MAX_BYTES_PER_CHUNK
    ) {
      chunk = { fromLine: lineNum, lines: [], bytes: 0 };
      this.chunks.push(chunk);
    }

    chunk.lines.push(content);
    chunk.bytes += lineBytes;
    this.bufferedBytes += lineBytes;

    // Backpressure: 条数 + 字节两个维度任一超限即丢最旧的切片（=**保留尾部**：
    // 执行失败的原因几乎总在最后几行）。先记账再判，才能让「单行就超预算」
    // 这种病态输入也被收住（否则它会绕过检查）。
    while (
      this.chunks.length > this.MAX_CHUNKS_IN_MEMORY
      || this.bufferedBytes > MAX_BUFFERED_BYTES
    ) {
      const dropped = this.chunks.shift();
      if (!dropped) break;
      this.bufferedBytes -= dropped.bytes;
      if (this.bufferedBytes < 0) this.bufferedBytes = 0; // 记账保守兜底，绝不为负
      // R164-A1：记下丢弃窗口的起点——marker 行占用「第一条被丢行」的行号，
      // 这样它落在缺口所在的位置，而不是堆到流末尾。
      if (this.firstDroppedLine === null) this.firstDroppedLine = dropped.fromLine;
      this.droppedSinceFlush += dropped.lines.length;
      // 第四轮审计（A8）: 丢行从 debug 升级为 warn（每执行限 1 条）。
      // 被丢弃的行不会再出现在实时流里（执行结束的回调日志不受影响，
      // 那走另一条持久化路径），属于「实时视图缺口」级别的信号，运维
      // 需要从日志里看到它发生；限 1 条防背压风暴刷屏。
      if (!this.backpressureWarned) {
        this.backpressureWarned = true;
        logger.warn(
          `[LogStreamPusher] Backpressure: dropping buffered log lines for execution ${this.executionId} (admin API slower than producer; subsequent drops will not be logged again)`,
        );
      }
      logger.debug(`[LogStreamPusher] Dropped ${dropped.lines.length} lines due to backpressure for execution ${this.executionId}`);
    }

    this.scheduleFlush();
    return lineNum;
  }

  /**
   * Feed a raw (possibly partial) stdout/stderr chunk.
   *
   * 只按 `\n` 切分并保留尾部半行，直到下一片补齐或 `finalFlush` 收尾——
   * 空行是**真实日志行**，必须与回调日志逐行对齐，不能过滤掉。
   *
   * R164-A1：`stream` 决定残行缓冲的归属。两路输出合并进**同一个行号空间**
   * （行号由到达顺序决定，这本身是对的：回调日志也是按到达顺序累积），但
   * **残行不能合并**——否则 stdout 的半行会吞掉 stderr 的一整行。
   */
  addOutput(output: string, stream: LogStream = 'stdout'): void {
    if (!output) return;
    const text = (this.partials.get(stream) ?? '') + output;
    const segments = text.split('\n');
    this.partials.set(stream, segments.pop() ?? '');
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
   *
   * 只负责「取消挂起的定时器 + 排队」，真正的排空在 {@link flushNow}。
   * JS 侧没有 python 那个「在 timer 任务内 cancel 自身 → CancelledError 静默丢光」
   * 的陷阱（timer 回调先把 `this.timer` 置 null 再 flush），但仍需串行化，
   * 见 {@link flushChain} 的注释。
   */
  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.serialize(() => this.flushNow());
  }

  /**
   * 把 `fn` 排到 flush 链尾：同一时刻只有一个 flush 在网络上跑，
   * 后到的 flush 等前一个落地后再取缓冲（对齐 python `_flush_lock` 的语义）。
   */
  private serialize(fn: () => Promise<void>): Promise<void> {
    const run = this.flushChain.then(fn, fn);
    // 链上吞掉拒绝：一次失败不能把后续 flush 永久卡死在已 rejected 的 promise 上。
    this.flushChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 排空当前缓冲（调用方须已经持有 flush 链）。 */
  private async flushNow(): Promise<void> {
    if (this.chunks.length === 0) return;

    const chunksToFlush = this.chunks.splice(0, this.chunks.length);
    this.bufferedBytes = 0;

    // R164-A1：先推**一行 marker**（占用第一条被丢行的行号），再推真实切片。
    // 单行成片是安全的：每片自带 fromLine，admin 按 fromLine+i 落库，所以插入
    // 这一行**不会**让后续切片的行号错位。
    if (this.firstDroppedLine !== null) {
      const marker: LogChunk = {
        fromLine: this.firstDroppedLine,
        lines: [BACKPRESSURE_MARKER(this.droppedSinceFlush)],
        bytes: 0, // 已在缓冲记账之外，不参与字节闸
      };
      this.droppedSinceFlush = 0;
      this.firstDroppedLine = null;
      chunksToFlush.unshift(marker);
    }

    let allPushed = true;
    for (const chunk of chunksToFlush) {
      try {
        await this.pushChunk(chunk);
      } catch (err) {
        allPushed = false;
        logger.debug(`[LogStreamPusher] Failed to push chunk for execution ${this.executionId}: ${err}`);
        // Continue with next chunks despite failure
      }
    }
    // 第四轮审计（A8）: 缓冲清空且全部推送成功 → 复位背压告警闸，让下一次
    // 独立的背压事件仍能产出一条 warn（而非本执行终身静默）。
    if (allPushed) this.backpressureWarned = false;
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

    // SEC-THROTTLE-BUCKET（审计 P1-1 配套）：与回调同款附带
    // `x-executor-address`——admin 侧 ExecutorAwareThrottlerGuard 现在**只对
    // 执行器机器面路由**认这个头（人操作面一律按 IP 计，防伪造头绕过限流），
    // 日志上报属于机器面，不带头就会退回按出口 IP 计桶，多执行器共享 NAT 时
    // 120/min 档位会被叠加打穿（RT-LOG 要修的正是「话痨任务日志被限流截断」）。
    const response = await post<{ count: number }>(
      path,
      {
        fromLine: chunk.fromLine,
        lines: chunk.lines,
      },
      executorAddressHeaderFor(),
      PUSH_TIMEOUT_MS,
    );

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
    // 收尾：把每路流的半行缓冲当作最后一行发出（子进程最后一行常无换行符）。
    // 按 Map 的插入顺序（stdout 通常先出现）保证同一执行内收尾顺序稳定。
    for (const [stream, tail] of Array.from(this.partials.entries())) {
      if (!tail) continue;
      this.partials.set(stream, '');
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
