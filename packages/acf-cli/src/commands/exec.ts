/**
 * ECO-02: acf exec tail <execId> —— 实时跟随执行日志（SSE）。
 *
 * 路由契约：
 * - GET /tasks/executions/:execId（compat alias）解析 taskId 与状态；
 * - 终态执行直接走 GET /tasks/executions/:execId/logs 打全量日志后退出；
 * - 未终态：先 POST /auth/sse-ticket 换短效票据，再走
 *   GET /tasks/:taskId/executions/:execId/logs/stream?ticket=
 *   （SSE 逐行 data: JSON.stringify(line)，event: done 收尾，: ping 保活帧）。
 *
 * SEC-CLI-01（本轮审计）：此处此前有两个各自独立、都会让 tail 完全不可用的缺陷：
 *  1) 用 `?access_token=` 建流——该通道已被服务端**整体撤销**
 *     （jwt.strategy.ts:SSE_TICKET_PARAM，只认 ?ticket=，且注释明说旧通道
 *     "intentionally GONE"），于是任何非终态 tail 立刻 401；
 *  2) 读取 `page.logs`——服务端返回的是 `{ lines, totalLines, hasMore }`
 *     （task.service.ts 的 getExecutionLogs），`logs` 恒为 undefined → ''，
 *     循环在第一轮就 break，打出**空输出**后静默退出。
 * 两者叠加使 `acf exec tail` 在任何路径上都不工作。
 */
import { Command } from 'commander';
import axios from 'axios';
import chalk from 'chalk';
import { get, post } from '../client';
import { getApiUrl } from '../config';
import { formatApiError } from '../client';

const TERMINAL = new Set(['success', 'failed', 'timeout', 'killed', 'cancelled']);

export interface SseMessage {
  event: string;
  data: string;
}

/**
 * 增量 SSE 解析器：feed(chunk) → 完整消息数组。跨 chunk 半行/半消息安全；
 * 注释行（: ping）忽略；event 行只影响下一条 data 消息的事件名。
 */
export function createSseParser(onMessage: (msg: SseMessage) => void): {
  feed: (chunk: string) => void;
} {
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length > 0) {
      onMessage({ event: eventName, data: dataLines.join('\n') });
    }
    eventName = 'message';
    dataLines = [];
  };

  return {
    feed(chunk: string) {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          dispatch();
          continue;
        }
        if (line.startsWith(':')) continue; // keepalive comment
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    },
  };
}

interface ExecutionRef {
  taskId?: string;
  status?: string;
}

interface LogsPage {
  /**
   * SEC-CLI-01: 服务端（task.service.ts getExecutionLogs）返回的行数组字段名是
   * `lines`，不是 `logs`。旧实现读 `logs` 恒为 undefined → 永远打不出日志。
   * 同时兼容旧的字符串形态，避免服务端若有历史版本而再次静默失败。
   */
  lines?: string[] | string;
  hasMore?: boolean;
  totalLines?: number;
}

/** 把服务端行数组（或旧字符串形态）规整为 string[]。 */
function toLines(lines: LogsPage['lines']): string[] {
  if (Array.isArray(lines)) return lines.filter((l) => typeof l === 'string');
  if (typeof lines === 'string' && lines.length > 0) return lines.split('\n');
  return [];
}

/** SSE 票据响应（POST /auth/sse-ticket）。 */
interface SseTicketResponse {
  ticket: string;
  expiresAt?: string;
}

export function execCommand(): Command {
  const cmd = new Command('exec').description('Follow or inspect executions');

  cmd
    .command('tail <execId>')
    .description('Follow execution logs live (SSE); terminal executions print their logs and exit')
    .option('--json', 'Emit raw JSON lines instead of plain text')
    .action(async (execId: string, opts: { json?: boolean }) => {
      try {
        const exec = await get<ExecutionRef>(`/tasks/executions/${execId}`);
        if (!exec?.taskId) {
          throw new Error(`Execution ${execId} not found`);
        }

        if (exec.status && TERMINAL.has(exec.status)) {
          // 终态：全量日志直出（分页拉全，对齐 admin-web U2 兜底语义）
          let fromLine = 0;
          let printed = 0;
          for (;;) {
            const page = await get<LogsPage>(
              `/tasks/executions/${execId}/logs?fromLine=${fromLine}&limit=2000`,
            );
            const lines = toLines(page?.lines);
            if (lines.length > 0) {
              for (const line of lines) {
                process.stdout.write((opts.json ? JSON.stringify({ line }) : line) + '\n');
                printed++;
              }
            }
            if (!page?.hasMore || lines.length === 0) break;
            fromLine = printed;
          }
          process.exitCode = exec.status === 'success' ? 0 : 1;
          return;
        }

        // 未终态：SSE 跟随。
        // SEC-CLI-01: 先换一枚 30s TTL 的专用 SSE 票据（走常规 Authorization
        // 头的 POST），再以 ?ticket= 建流——`?access_token=` 通道已被服务端撤销，
        // 旧写法会让每次非终态 tail 直接 401。与 admin-web/src/api/sse.ts 同流程。
        const { ticket } = await post<SseTicketResponse>('/auth/sse-ticket');
        const base = getApiUrl().replace(/\/+$/, '');
        const url = `${base}/tasks/${exec.taskId}/executions/${execId}/logs/stream?ticket=${encodeURIComponent(ticket)}`;
        const res = await axios.get(url, { responseType: 'stream', timeout: 0 });

        process.stderr.write(
          chalk.gray(`[tail] following execution ${execId} (status: ${exec.status ?? 'unknown'}) — Ctrl+C to detach\n`),
        );
        // NETOPT-2②：done 帧是「日志流完整收尾」的唯一判据。此前 stream
        // 'end' 一律 process.exit(0)——服务端/网络在 done 帧之前断流（反代
        // 超时、进程重启）时，tail 静默以 0 退出，CI 里 `acf exec tail … &&
        // …` 把断流当成功。sawDone 记录是否见过 done 帧：见过才 exit(0)，
        // 否则明示日志流中断并以非零码退出。
        let sawDone = false;
        const parser = createSseParser((msg) => {
          if (msg.event === 'done') {
            sawDone = true;
            process.stderr.write(chalk.gray('[tail] done\n'));
            process.exit(0);
          }
          if (msg.event !== 'message') return;
          try {
            const line = JSON.parse(msg.data) as unknown;
            process.stdout.write(
              (opts.json ? JSON.stringify({ line }) : String(line)) + '\n',
            );
          } catch {
            // 非 JSON data 帧按原文输出
            process.stdout.write(msg.data + '\n');
          }
        });

        const stream = res.data as NodeJS.ReadableStream;
        stream.on('data', (chunk: Buffer | string) => {
          parser.feed(chunk.toString('utf-8'));
        });
        stream.on('end', () => {
          if (sawDone) {
            process.exit(0);
            // 防穿透：测试里 process.exit 常被钉成桩（正常返回），结构上
            // 也不能让「完整收尾」落进下面的失败路径。
            return;
          }
          // 断流且没有 done 帧：执行可能仍在运行。用 exitCode 赋值而非
          // process.exit(1)，让事件循环自然收尾（流已 end，无挂起句柄）。
          process.stderr.write(
            chalk.red(
              '[tail] log stream interrupted before a done frame — the execution may still be running. Retry with `acf exec tail ' +
                execId +
                '`.\n',
            ),
          );
          process.exitCode = 1;
        });
        stream.on('error', (err: Error) => {
          process.stderr.write(chalk.red(`[tail] stream error: ${err.message}\n`));
          process.exit(1);
        });
      } catch (e: unknown) {
        console.error(chalk.red('✗ tail failed:'), formatApiError(e));
        process.exit(1);
      }
    });

  return cmd;
}
