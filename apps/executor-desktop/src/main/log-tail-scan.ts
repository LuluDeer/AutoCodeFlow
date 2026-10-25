import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/**
 * F-22（UIUX 审计 2026-10-25）：日志查看器首读的尾窗扫描。
 *
 * ## 为什么需要它
 *
 * `readLogIncremental`（ipc-handlers.ts）在「fromLine=0 且游标新建」（首次打开
 * 查看器 / 用户点刷新）分支原实现是 readFileSync 整个文件 + 全量 split：10MB+
 * 的任务日志一次 IPC 全量过桥，渲染层拿到后只留最后 1500/2400 行，其余全部
 * 丢弃——打开即主进程内存尖峰 + 序列化卡顿（主进程同时承载 UI/托盘/心跳）。
 * 同族问题在 `logs:getToday` 已用 readLastLines 尾窗修过一次（NETOPT-2⑥），
 * 本模块把同样的处置带给 `log:read` / `apps:log:read`。
 *
 * 纯 Node 模块（fs + string_decoder，零 electron 依赖）⇒ log-tail.selftest
 * 直接驱动**真实现**做行为断言，不需要 SYNC 副本（与 path-domain / notifier-rules
 * 的纯模块抽取先例同型；ipc-handlers 本体仍因 import electron 无法被 selftest
 * 加载，其接线由 selftest 的源码 SYNC GUARD 钉住）。
 *
 * ## 语义（必须与 readLogIncremental 的游标口径逐字一致）
 *
 *  - 行定义与游标路径相同：按 '\n' 切分、**丢弃空行**（游标路径是
 *    `split('\n').filter(l => l.length > 0)`）、**不剥 '\r'**（CRLF 文件的行尾
 *    \r 与增量路径行为一致——剥离是 readLastLines/logs:getToday 的刻意偏离，
 *    那里有渲染层 normalizeLogLine 的配套；本路径沿用游标口径）；
 *  - totalLines = 全文件**非空完整行**数（与游标 totalLines 同一口径，后续
 *    增量读的行号才能无缝续上；渲染层的「全局行号 = totalLines - 缓冲行数」
 *    换算也因此精确）；
 *  - 文件尾没有换行符的最后一行视为「未完整落盘」——不计行数、不返回，
 *    consumedBytes 停在最后一个 '\n' 之后（与增量路径「半行留到下次」同口径；
 *    已占用的字节下次增量读会从 consumedBytes 起重新读到，不丢不重）；
 *  - lines 只保留尾部 maxLines 行（默认 LOG_TAIL_MAX_LINES，覆盖渲染层
 *    1500（历史）/2400（应用）两个缓冲消费口径并留余量）。
 *
 * 实现：单遍顺序扫描（1MB 读块 + StringDecoder 处理跨块多字节字符），用固定
 * 长度的「尾部滚动窗口」留住最后 maxLines 行——内存有界（与文件大小无关），
 * 一遍同时拿到尾窗行、精确总行数与游标偏移。不采用「先读尾窗、再补一次全文件
 * 计数」的两读方案：两次读取之间并发追加会让 totalLines 与尾窗内容错位，
 * 渲染层的行号/「共 M 行」随之永久漂移。
 */

/** 尾窗行数上限：渲染层两个查看器的缓冲消费口径为 1500/2400 行，留余量。 */
export const LOG_TAIL_MAX_LINES = 3000;

/** 顺序扫描的读块大小（扫描期内存上界的决定项之一，与文件大小无关）。 */
const SCAN_CHUNK_BYTES = 1024 * 1024;

export interface LogTailScan {
  /** 尾部至多 maxLines 个非空完整行（不剥 \r，语义同游标路径）。 */
  lines: string[];
  /** 全文件非空完整行数（游标口径，精确值）。 */
  totalLines: number;
  /** 最后一个完整行（含换行符）之后的字节偏移——游标 offset 的新建值。 */
  consumedBytes: number;
  /** 尾窗截断了更早的行（totalLines > lines.length）。 */
  truncated: boolean;
}

/**
 * 扫描日志文件的尾窗。文件不存在/打开失败等 I/O 异常返回 null——调用方
 * （readLogIncremental）落回既有路径由其 catch 兜底，行为不劣化。
 */
export function scanLogTail(
  filePath: string,
  maxLines: number = LOG_TAIL_MAX_LINES,
): LogTailScan | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) {
      return { lines: [], totalLines: 0, consumedBytes: 0, truncated: false };
    }
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    const tail: string[] = [];
    let carry = '';
    let totalLines = 0;
    let consumedBytes = 0;
    let pos = 0;
    while (pos < size) {
      const read = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      // read <= 0：并发截断等异常——带着已扫描的部分收尾，绝不让首读挂死。
      if (read <= 0) break;
      pos += read;
      const text = carry + decoder.write(buf.subarray(0, read));
      const parts = text.split('\n');
      carry = parts.pop() ?? '';
      for (const part of parts) {
        // 游标偏移与增量路径同口径：每个完整行按「行内容字节 + 1 个 \n」记账
        //（空行也占字节，只是不计行数）。
        consumedBytes += Buffer.byteLength(part, 'utf8') + 1;
        if (part.length > 0) {
          totalLines += 1;
          tail.push(part);
          if (tail.length > maxLines) tail.shift();
        }
      }
    }
    // 冲出解码器内的残留字节（残缺的多字节序列 → U+FFFD，与 readFileSync 同
    // 行为；返回的残串连同 carry 一并丢弃——见下）。
    decoder.end();
    // 文件尾无换行：carry 里的最后一行尚未写完——与游标路径同口径（withheld），
    // 不计行数、不进尾窗；consumedBytes 已停在最后一个 \n 之后，该半行留给
    // 后续增量读补齐后交付（其字节会从 consumedBytes 起重新读到，不丢不重）。
    return {
      lines: tail,
      totalLines,
      consumedBytes,
      truncated: totalLines > tail.length,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}
