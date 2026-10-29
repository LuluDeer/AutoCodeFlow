import { Logger } from "@nestjs/common";
import * as fs from "fs";
import { getEnvVar } from "../../config/env";

/**
 * INCIDENT-2026-10-28（P0-2）：把 stdout / stderr 从「同步写」换成
 * 「异步写 + 有界丢弃」。
 *
 * ## 背景（事故机制）
 *
 * 生产用 `nohup node dist/main.js &>> AutoCodeFlow.log` 启动，fd 1/2 指向
 * **普通文件**。Node 对普通文件的 `process.stdout` 实现是 `SyncWriteStream`：
 * 每次 `console.log` 都是主线程上的 `writeSync(2)`。
 *
 * 磁盘一旦 stall（本机 Redis AOF fsync 历史累计 1018 次超时、PG 裸 COMMIT
 * 卡 30s），主线程被钉住 → 定时器/watchdog/HTTP 全部停摆：
 *
 * ```
 * 盘 IO 抖动 → 主线程 writeSync 阻塞 → 事件循环钉住 40s
 *           → watchdog setInterval 一次都没跑 → Leader 租约 30s 过期 → demote
 * ```
 *
 * 10-28 11:59 因此冻结约 40 秒，打穿 30s 的 Leader 租约，丢失 12:00 落点。
 *
 * ## 为什么 stderr 必须一起改
 *
 * Nest 的 `Logger.error` / `fatal` 走 stderr
 * （`@nestjs/common/services/console-logger.service.js` 的
 * `writeStreamType='stderr'`），而本仓 `main.ts` 的 `logFatal()` 全部走
 * `Logger.error`——**那恰恰是最需要可靠落盘的时刻**（启动校验失败、
 * bootstrap 崩溃、未捕获异常）。只改 stdout 等于把放大器切断了一半。
 *
 * ## 为什么不是简单的 createWriteStream
 *
 * 实测（Node v24.21.0）：连续写 128MB 时主线程确实不阻塞了，但
 * `writableLength` 堆到 125MB 且**无上界**。7.6GB 内存 + `overcommit_memory=1`
 * + Swap 已用 2.3GB 的机器上，无界堆积会把 OOM killer 引过来——比卡 40 秒更糟。
 *
 * 因此超过 `MAX_BUFFERED_BYTES` 的日志**直接丢弃并计数**。日志是诊断手段，
 * 不是业务数据——宁可丢日志也不能 OOM。
 *
 * ## 开关
 *
 * `LOG_ASYNC_STDOUT=false` 恢复旧行为，用于排查「日志本身丢太多」的现场。
 */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024; // 8MB ≈ 数万行 JSON

/** 判定给定 stream 是否为目标为普通文件的同步写实现 */
export function isSyncFileStream(stream: { constructor: { name: string } }) {
  return stream?.constructor?.name === "SyncWriteStream";
}

/**
 * 用原始 fd 写一条诊断信息——绕过被替换的 `write`，避免递归。
 * 失败即放弃（这本身就是最后手段的通道）。
 */
function rawWrite(fd: number, text: string): void {
  try {
    fs.writeSync(fd, text);
  } catch {
    /* 诊断通道不可用时不递归、不再尝试 */
  }
}

interface InstallState {
  /** 已被替换的 stream 名，供测试与幂等保护使用 */
  readonly installed: ReadonlyArray<"stdout" | "stderr">;
  /** 累计丢弃行数（含两个流） */
  dropped: () => number;
  /** 恢复原始 write 并停止 sink（测试清理用；生产不调用） */
  restore: () => void;
}

const installStateByProcess = new WeakMap<object, InstallState>();

/**
 * 安装异步 stdout/stderr。**必须在模块级顶层调用**（紧跟 `loadEnvFile`），
 * 不能放在 `bootstrap()` 内——后者晚于所有 `import` 的模块体求值，会漏掉
 * 模块体求值期的日志。
 *
 * 幂等：重复调用直接返回既有状态。
 */
export function installAsyncStdout(): InstallState | null {
  const existing = installStateByProcess.get(process);
  if (existing) return existing;

  // ARCH-27：模块求值期读 env 必须走 getEnvVar（main.ts 不在 process.env 豁免清单）
  if (getEnvVar("LOG_ASYNC_STDOUT") === "false") return null;

  const saved: Array<{
    name: "stdout" | "stderr";
    stream: NodeJS.WriteStream;
    write: NodeJS.WriteStream["write"];
    sink: fs.WriteStream;
  }> = [];
  let droppedTotal = 0;

  const install = (name: "stdout" | "stderr", fd: 1 | 2): void => {
    const stream = process[name];
    // 只在目标指向普通文件时介入：管道/socket 本来就是异步的（实测
    // constructor.name === 'Socket'），替换反而丢掉 backpressure。
    if (!isSyncFileStream(stream)) return;

    const sink = fs.createWriteStream("", { fd, autoClose: false });
    sink.on("error", (err: Error) => {
      // sink 自身故障：走原始 fd，避免递归进被替换的 write
      rawWrite(2, `[async-${name}] sink error: ${err.message}\n`);
    });

    let dropped = 0;
    const originalWrite = stream.write;

    const replacement = ((
      chunk: string | Buffer,
      encoding?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean => {
      // 有界丢弃：积压超限时丢新日志，绝不无界增长内存
      if (sink.writableLength > MAX_BUFFERED_BYTES) {
        dropped += 1;
        droppedTotal += 1;
        // 首条与每 1 万条告警一次，避免告警本身刷屏
        if (dropped === 1 || dropped % 10_000 === 0) {
          rawWrite(
            2,
            `[async-${name}] sink backlog ${sink.writableLength}B exceeds ` +
              `${MAX_BUFFERED_BYTES}B — dropped ${dropped} log line(s) so far ` +
              `(disk is stalling)\n`,
          );
        }
        // 仍按 Node 的 write 契约回调，避免调用方永久等待
        const done = typeof encoding === "function" ? encoding : cb;
        if (done) process.nextTick(done);
        return true; // 声称已接受：返回 false 会诱导调用方重试，反而放大积压
      }
      return typeof encoding === "function"
        ? sink.write(chunk, encoding)
        : sink.write(chunk, encoding as BufferEncoding | undefined, cb);
    }) as NodeJS.WriteStream["write"];

    stream.write = replacement;
    saved.push({ name, stream, write: originalWrite, sink });
  };

  // 顺序：先 stderr 再 stdout —— 若 stdout 的 sink 创建失败，stderr 已就位，
  // 告警不会因 stdout 安装失败而丢失。
  install("stderr", 2);
  install("stdout", 1);

  // 两个流都不是同步写（TTY/管道/journald）→ 不介入、也不注册 exit 钩子
  if (saved.length === 0) return null;

  // 退出前排空，避免尾部日志丢失
  const flush = (): void => {
    for (const { sink } of saved) {
      try {
        sink.end();
      } catch {
        /* 退出路径尽力而为 */
      }
    }
  };
  process.on("exit", flush);
  process.on("beforeExit", flush);

  const state: InstallState = {
    installed: saved.map((s) => s.name),
    dropped: () => droppedTotal,
    restore: () => {
      for (const { stream, write, sink } of saved) {
        stream.write = write;
        try {
          sink.end();
        } catch {
          /* 清理路径尽力而为 */
        }
      }
      process.off("exit", flush);
      process.off("beforeExit", flush);
      installStateByProcess.delete(process);
    },
  };
  installStateByProcess.set(process, state);

  // 用原始 fd 报到：这条日志本身也确认了安装成功
  rawWrite(
    2,
    `[async-stdout] installed for: ${state.installed.join(", ")} ` +
      `(bounded at ${MAX_BUFFERED_BYTES}B, drop-on-overflow)\n`,
  );

  return state;
}

/**
 * 供 spec 使用的日志器句柄。生产不使用（`installAsyncStdout` 内的 rawWrite
 * 已足够），仅让测试能断言告警路径。
 */
export const asyncStdoutLogger = new Logger("AsyncStdout");
