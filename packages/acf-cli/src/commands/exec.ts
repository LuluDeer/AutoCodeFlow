/**
 * ECO-02: acf exec tail <execId> —— 实时跟随执行日志（SSE）。
 *
 * 路由契约：
 * - GET /tasks/executions/:execId（compat alias）解析 taskId 与状态；
 * - 终态执行直接走 GET /tasks/executions/:execId/logs 打全量日志后退出；
 * - 未终态走 GET /tasks/:taskId/executions/:execId/logs/stream?access_token=
 *   （SSE 逐行 data: JSON.stringify(line)，event: done 收尾，: ping 保活帧）。
 *
 * SSE 解析器 createSseParser 是纯状态机（跨 chunk 半行安全），单测覆盖。
 */
import { Command } from 'commander';
import axios from 'axios';
import chalk from 'chalk';
import { get } from '../client';
import { getToken, getApiUrl } from '../config';
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
  logs?: string;
  hasMore?: boolean;
  totalLines?: number;
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
            const logs = page?.logs ?? '';
            if (logs.length > 0) {
              for (const line of logs.split('\n')) {
                process.stdout.write((opts.json ? JSON.stringify({ line }) : line) + '\n');
                printed++;
              }
            }
            if (!page?.hasMore || logs.length === 0) break;
            fromLine = printed;
          }
          process.exitCode = exec.status === 'success' ? 0 : 1;
          return;
        }

        // 未终态：SSE 跟随
        const base = getApiUrl().replace(/\/+$/, '');
        const token = getToken();
        const url = `${base}/tasks/${exec.taskId}/executions/${execId}/logs/stream?access_token=${encodeURIComponent(token)}`;
        const res = await axios.get(url, { responseType: 'stream', timeout: 0 });

        process.stderr.write(
          chalk.gray(`[tail] following execution ${execId} (status: ${exec.status ?? 'unknown'}) — Ctrl+C to detach\n`),
        );
        const parser = createSseParser((msg) => {
          if (msg.event === 'done') {
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
        stream.on('end', () => process.exit(0));
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
