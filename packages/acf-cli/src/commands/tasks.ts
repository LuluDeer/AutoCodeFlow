import { Command, InvalidArgumentError } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { get, post, put, patch, del, ANALYZE_TIMEOUT_MS } from '../client.js';
import { emitError, emitUsageError, UsageError, confirmDestructive } from '../ui.js';

interface Task {
  id: string;
  name: string;
  status: string;
  runtime: string;
  cronExpression?: string;
  applicationId?: string;
  // 详情补面（task get 的扩展字段；均为可选，旧数据/轻量投影缺失时打 '-'）
  description?: string | null;
  triggerType?: string;
  timeout?: number | null;
  maxRetry?: number | null;
  enabled?: boolean;
}

interface Execution {
  id: string;
  taskId: string;
  status: string;
  duration?: number;
  createdAt: string;
  aiAnalysis?: string;
  // U11: aligned with admin-api task-execution.entity.ts — the executor
  // callback records these on terminal executions; without them the CLI
  // silently dropped the failure cause.
  exitCode?: number | null;
  failureReason?: string | null;
  errorMessage?: string | null;
}

interface PaginatedTasks {
  list: Task[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 结构化失败原因（failureReason，执行器回调上报）→ 可直接照做的建议。
 *
 * 2026-10 开发人员实测：任务声明 runtimeVersion=3.12 派到无该解释器的执行器
 * 秒失败且执行日志 0 行——failureReason=interpreter_unavailable 只有 --json
 * 里能看到，中文详情还得再查一次文档。把最常见的几个失败原因翻译成"下一步
 * 怎么做"，随 `--wait` 的失败终态直接打出来（键集对齐 executor-node
 * protocol.schemas.ts 的 CallbackFailureReason 枚举）。
 */
export const FAILURE_REASON_HINTS: Record<string, string> = {
  interpreter_unavailable:
    'the interpreter requested by runtimeVersion is not available on this executor — remove runtimeVersion to use the host default interpreter',
  runtime_missing:
    'the task runtime is not available on this executor — check the task runtime field or the executor interpreter pool',
  script_error:
    'the entry script exited with a non-zero code — inspect the log with: acf task logs <execId>',
  timeout:
    'the execution exceeded its time budget — raise the task timeout or split the work',
  sandbox_unavailable:
    'the executor sandbox is not available — contact the executor operator or relax the sandbox configuration',
};

// E-1 任务定义导出物（GET /tasks/:id/export 的原始 JSON 体，不经 envelope）。
// schemaVersion 钉 "1"；导出物即 POST /tasks/import 的请求体，两端口径对称。
interface TaskExportPayload {
  schemaVersion: string;
  exportedAt?: string;
  task: Record<string, unknown>;
}

// POST /tasks/import 响应（envelope data）。
interface TaskImportResult {
  taskId: string;
  name: string;
  warnings?: string[];
}

// P3 glue：执行器侧运行时白名单（executor-node execute.ts 的 glueLanguage 分支
// —— javascript/python/shell，另有 glue_node 等旧别名）。注意 node 脚本的合法
// 值是 `javascript`：发 `node` 执行器会在运行时抛 "Unsupported glue language"，
// 与 acf task lint 的本地推断值（node|python|shell）刻意不同——lint 只做本地
// new Function 编译，glue 的 language 要落库给执行器消费。
const GLUE_LANGUAGES = ['python', 'javascript', 'shell'] as const;

const GLUE_EXT_LANG: Record<string, string> = {
  '.py': 'python',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.sh': 'shell',
  '.bash': 'shell',
};

/**
 * E-1：`acf task import -` 的 stdin 读取。"-" 是 CI/管道惯例；stdin 是 TTY
 * 时（用户忘了给文件、手敲 `-`）拒绝而不是挂死等待 EOF。流参数可注入——
 * 单测用 PassThrough 驱动，不碰真实 stdin。
 */
export function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  return new Promise((resolve, reject) => {
    if ((stream as NodeJS.ReadStream).isTTY) {
      reject(new UsageError('stdin is a TTY — pipe the payload (cat payload.json | acf task import -) or pass a file path'));
      return;
    }
    let data = '';
    stream.setEncoding('utf-8');
    stream.on('data', (chunk: string) => {
      data += chunk;
    });
    stream.on('end', () => resolve(data));
    stream.on('error', (err: unknown) => {
      reject(new UsageError(`Cannot read stdin: ${err instanceof Error ? err.message : String(err)}`));
    });
  });
}

function statusColor(s: string): string {
  if (s === 'success') return chalk.green(s);
  if (s === 'failed' || s === 'timeout' || s === 'killed') return chalk.red(s);
  if (s === 'running') return chalk.cyan(s);
  if (s === 'active') return chalk.green(s);
  if (s === 'paused') return chalk.yellow(s);
  return chalk.gray(s);
}

export function tasksCommand(): Command {
  const cmd = new Command('task').description('Manage tasks');

  // acf task list
  cmd.command('list')
    .description('List all tasks')
    .option('-s, --status <status>', 'Filter by status (active|paused)')
    .option('-k, --keyword <keyword>', 'Search by NAME only (sent as the `name` query param; backward-compatible channel)')
    .option('--search <keyword>', 'Search across name AND description (sent as the `q` query param — what the console search box sends; combined with --keyword both must match)')
    .option('-p, --page <n>', 'Page number', '1')
    .option('-n, --page-size <n>', 'Items per page', '20')
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (opts) => {
      const spinner = ora('Fetching tasks…').start();
      try {
        // ListTasksQueryDto: `name`（按名，向后兼容）+ `q`（name OR description）
        const data = await get<PaginatedTasks>('/tasks', {
          page: opts.page,
          pageSize: opts.pageSize,
          status: opts.status,
          name: opts.keyword,
          q: opts.search,
        });
        spinner.stop();
        if (opts.json) {
          // ECO-02: --json —— CI/脚本消费面（信封已拆，直接可用负载）
          console.log(JSON.stringify(data));
          return;
        }
        const table = new Table({
          head: ['ID', 'Name', 'Runtime', 'Status', 'Cron'],
          colWidths: [14, 30, 12, 10, 20],
          style: { head: ['cyan'] },
        });
        for (const t of data.list ?? []) {
          table.push([t.id.slice(0, 12), t.name, t.runtime, statusColor(t.status), t.cronExpression ?? '-']);
        }
        console.log(table.toString());
        console.log(chalk.gray(`Total: ${data.total}  page ${data.page}/${Math.ceil(data.total / data.pageSize)}`));
      } catch (e: unknown) {
        emitError('Failed to list tasks', e, { spinner });
      }
    });

  // acf task get <id>
  cmd.command('get <id>')
    .description('Show task details')
    // 第四轮审计（--json 补面）：对齐 task list 的 ECO-02 CI 消费面
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (id, opts: { json?: boolean }) => {
      const spinner = ora('Fetching task…').start();
      try {
        const t = await get<Task>(`/tasks/${id}`);
        spinner.stop();
        if (opts.json) {
          // ECO-02: --json —— CI/脚本消费面（pretty print 便于人工核查）
          console.log(JSON.stringify(t, null, 2));
          return;
        }
        console.log(chalk.bold('Task Details'));
        console.log('  ID          :', t.id);
        console.log('  Name        :', t.name);
        console.log('  Runtime     :', t.runtime);
        console.log('  Status      :', statusColor(t.status));
        console.log('  Trigger     :', t.triggerType ?? '-');
        console.log('  Cron        :', t.cronExpression ?? '-');
        console.log('  Description :', t.description ?? '-');
        console.log('  App         :', t.applicationId ?? '-');
        console.log('  Timeout     :', t.timeout !== undefined && t.timeout !== null ? `${t.timeout}s` : '-');
        console.log('  Max retry   :', t.maxRetry ?? '-');
        console.log('  Enabled     :', t.enabled === undefined ? '-' : (t.enabled ? chalk.green('yes') : chalk.gray('no')));
      } catch (e: unknown) {
        emitError('Failed', e, { spinner });
      }
    });

  // acf task trigger <id>
  cmd.command('trigger <id>')
    .description('Manually trigger a task. Returns the execution id immediately; add --wait to poll until the terminal state and get its exit code')
    .option('--wait', 'Poll until execution finishes', false)
    // NETOPT-2①: --wait 的轮询上限可调（秒）。默认 600 保持既有行为；
    // 非正值直接报参数错误而不是静默回落默认值——CI 里写错单位（毫秒当秒）
    // 若被静默吞掉，长任务又会掉回「假超时假绿」的老坑。
    .option(
      '--wait-timeout <seconds>',
      'Max seconds to keep polling with --wait before giving up (default 600)',
      (v: string) => {
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new InvalidArgumentError('must be a positive integer (seconds)');
        }
        return n;
      },
      600,
    )
    // NOTE: no --executor option here — TriggerTaskDto only accepts `params`
    // and the backend ValidationPipe runs with forbidNonWhitelisted, so a
    // per-trigger pin would be rejected with 400. Executor pinning IS
    // supported by the backend as a task-level field (tasks.executorId) — set
    // it via `acf task create/update --executor <id>`, not per run.
    // --params 补面（本轮）：TriggerTaskDto 收 params（覆盖任务默认参数，与
    // webhook 面同形），block-strategy 闸（N-14）按生效参数判重——CLI 此前
    // 永远发空 body，无法按 run 覆盖参数。
    .option('--params <json>', 'Per-run param overrides as JSON, e.g. \'{"KEY":"value"}\' (replaces the task\'s default params for this run)')
    // 第四轮审计（--json 补面）：trigger 响应（execution 对象）直出 JSON，
    // CI 拿 executionId 做后续断言无需解析人读文本。
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (id: string, opts: { wait?: boolean; waitTimeout?: number; json?: boolean; params?: string }) => {
      const spinner = ora('Triggering task…').start();
      try {
        // 本地 JSON 预检：坏 params 是用法错误（退出码 2），请求不发出。
        let params: Record<string, unknown> | undefined;
        if (opts.params !== undefined) {
          try {
            params = JSON.parse(opts.params) as Record<string, unknown>;
          } catch (e: unknown) {
            throw new UsageError(`Invalid --params JSON: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        // 只有显式 --params 才带 body（缺省时 post 单参调用，既有语义逐字节保持）。
        const exec = params !== undefined
          ? await post<Execution>(`/tasks/${id}/trigger`, { params })
          : await post<Execution>(`/tasks/${id}/trigger`);
        if (opts.json) {
          // ECO-02 同款：--json —— ora 默认写 stderr，stdout 仍是干净 JSON。
          // P2（CLI-AGENT-UX-AUDIT）：--json **且** --wait 时不在这里输出中间态，
          // 改由 pollExecution 在最末尾一次性输出**最终** execution 对象——
          // 否则 stdout 会先来一段 execution JSON，再接死亡终态的人类可读行
          // （Exit code / Failure reason），单行 JSON 解析器必崩。
          spinner.stop();
          if (!opts.wait) {
            console.log(JSON.stringify(exec, null, 2));
          }
        } else {
          spinner.succeed(`Execution started: ${exec.id}`);
          if (!opts.wait) {
            process.stderr.write(
              chalk.gray('  (add --wait to poll until completion and get the exit code)\n'),
            );
          }
        }
        if (opts.wait) {
          await pollExecution(exec.id, opts.waitTimeout, { json: !!opts.json });
        }
      } catch (e: unknown) {
        emitError('Failed to trigger', e, { spinner });
      }
    });

  // acf task executions <id>
  cmd.command('executions <id>')
    .description('List recent executions for a task')
    .option('-n, --limit <n>', 'Number of results', '10')
    // --json 补面（本轮 UX 统一）：对齐 task list 的 ECO-02 CI 消费面
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (id, opts: { limit?: string; json?: boolean }) => {
      const spinner = ora('Fetching executions…').start();
      try {
        // 后端 PaginationDto 只认 page/pageSize——不发送 `limit`，
        // 否则开启 forbidNonWhitelisted 后必然 400（N7/N10）。
        const data = await get<{ list: Execution[]; total: number }>(`/tasks/${id}/executions`, {
          pageSize: opts.limit,
          page: 1,
        });
        spinner.stop();
        if (opts.json) {
          // ECO-02 同款：列表/信封形态 → 单行紧凑 JSON（与 task list --json 一致）
          console.log(JSON.stringify(data));
          return;
        }
        const table = new Table({
          // U11: exitCode column — distinguishes "failed by callback
          // report" (exit 0 / null) from "process died" (non-zero).
          // 2026-10 补 failureReason 列：interpreter_unavailable 这类结构化
          // 失败此前只在 --json 可见（executions 表格无原因），值班扫一眼
          // 即可分流。
          head: ['Exec ID', 'Status', 'Duration', 'Exit', 'Reason', 'Started'],
          colWidths: [14, 12, 12, 6, 30, 25],
          style: { head: ['cyan'] },
        });
        for (const e of data.list ?? []) {
          table.push([
            e.id.slice(0, 12),
            statusColor(e.status),
            e.duration ? `${e.duration}ms` : '-',
            e.exitCode ?? '-',
            e.failureReason ?? '-',
            new Date(e.createdAt).toLocaleString(),
          ]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        emitError('Failed', e, { spinner });
      }
    });

  // acf task logs <execId>
  cmd.command('logs <execId>')
    .description('Fetch execution logs (line-paginated)')
    .option('-f, --from-line <n>', 'Start line (0-based)', '0')
    .option('-n, --limit <n>', 'Max lines to fetch (max 2000)', '200')
    .option('--tail <n>', 'Show last N lines (overrides --from-line)')
    // 第四轮审计（--json 补面）：行页对象（lines/totalLines/hasMore）直出 JSON
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (execId, opts: { fromLine: string; limit: string; tail?: string; json?: boolean }) => {
      const spinner = ora('Fetching logs…').start();
      try {
        if (opts.tail) {
          const tail = Math.max(1, parseInt(opts.tail, 10) || 50);
          const head = await get<{ totalLines: number }>(`/tasks/executions/${execId}/logs`, {
            fromLine: 0,
            limit: 1,
          });
          const from = Math.max(0, head.totalLines - tail);
          const data = await get<{ lines: string[]; totalLines: number }>(
            `/tasks/executions/${execId}/logs`,
            { fromLine: from, limit: tail },
          );
          spinner.stop();
          if (opts.json) {
            // ECO-02 同款：--json —— 附 fromLine 便于消费方续读
            console.log(JSON.stringify({ ...data, fromLine: from }, null, 2));
            return;
          }
          for (const l of data.lines ?? []) console.log(l);
          console.log(chalk.gray(`\n(${data.lines?.length ?? 0}/${data.totalLines} lines — last ${tail})`));
        } else {
          const fromLine = parseInt(opts.fromLine, 10) || 0;
          const data = await get<{ lines: string[]; totalLines: number; hasMore: boolean }>(
            `/tasks/executions/${execId}/logs`,
            { fromLine, limit: opts.limit },
          );
          spinner.stop();
          if (opts.json) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          for (const l of data.lines ?? []) console.log(l);
          if (data.hasMore) {
            console.log(chalk.gray(`\n… hasMore — next: acf task logs ${execId} --from-line ${fromLine + (data.lines?.length ?? 0)}`));
          } else {
            console.log(chalk.gray(`\n(${data.totalLines} lines total)`));
          }
        }
      } catch (e: unknown) {
        emitError('Failed to fetch logs', e, { spinner });
      }
    });

  // acf task analyze <taskId> <execId>
  cmd.command('analyze <taskId> <execId>')
    .description('Run AI analysis on a failed execution')
    .action(async (taskId, execId) => {
      const spinner = ora('Running AI analysis…').start();
      try {
        // NETOPT-6④：同步 AI 端点（服务端预算 60s×2）用 120s per-call 覆盖，
        // 否则默认 30s 结构性小于服务端预算，AI 跑满预算成功返回时 CLI 已超时。
        const result = await post<{ aiAnalysis: string }>(
          `/tasks/${taskId}/executions/${execId}/analyze`,
          undefined,
          ANALYZE_TIMEOUT_MS,
        );
        spinner.stop();
        console.log(chalk.bold('\nAI Analysis'));
        console.log(result.aiAnalysis || 'No analysis available (AI not configured).');
      } catch (e: unknown) {
        emitError('Analysis failed', e, { spinner });
      }
    });

  // acf task suggest-schedule <id>
  cmd.command('suggest-schedule <id>')
    .description('Ask AI to suggest an optimal cron schedule')
    .action(async (id) => {
      const spinner = ora('Asking AI for schedule suggestion…').start();
      try {
        // NETOPT-6④：同上——suggest-schedule 也是同步 AI 端点。
        const result = await post<{ suggestedCron: string; currentCron: string | null; reasoning: string }>(
          `/tasks/${id}/suggest-schedule`,
          undefined,
          ANALYZE_TIMEOUT_MS,
        );
        spinner.stop();
        console.log(chalk.bold('Schedule Suggestion'));
        console.log('  Current   :', result.currentCron ?? '(none)');
        console.log('  Suggested :', chalk.green(result.suggestedCron));
        console.log('\nReasoning:');
        console.log(result.reasoning);
      } catch (e: unknown) {
        emitError('Failed', e, { spinner });
      }
    });

  // acf task stats <id>
  cmd.command('stats <id>')
    .description('Show execution statistics for a task')
    // --json 补面（本轮 UX 统一）：单对象形态 → pretty JSON（与 task get --json 一致）
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (id, opts: { json?: boolean }) => {
      const spinner = ora('Fetching stats…').start();
      try {
        const s = await get<{ successRate: number; avgDuration: number; totalRuns: number; recentExecutions: Execution[] }>(`/tasks/${id}/stats`);
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(s, null, 2));
          return;
        }
        console.log(chalk.bold('Execution Stats'));
        console.log(`  Success rate : ${chalk.green(s.successRate + '%')}`);
        console.log(`  Avg duration : ${s.avgDuration}ms`);
        console.log(`  Total runs   : ${s.totalRuns}`);
      } catch (e: unknown) {
        emitError('Failed', e, { spinner });
      }
    });

  // acf task versions <id>
  cmd.command('versions <id>')
    .description('List historical versions of a task')
    // --json 补面（本轮 UX 统一）：rollback/compare 前先拿 versionId 的脚本消费面
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (id, opts: { json?: boolean }) => {
      const spinner = ora('Fetching task versions…').start();
      try {
        const versions = await get<Array<{ id: string; version: string; gitCommit?: string; createdBy?: string; description?: string; createdAt: string }>>(
          `/tasks/${id}/versions`,
        );
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(versions, null, 2));
          return;
        }
        const table = new Table({
          head: ['Version', 'Commit', 'Created By', 'Created', 'Description'],
          colWidths: [12, 14, 16, 25, 30],
          style: { head: ['cyan'] },
        });
        for (const v of versions) {
          table.push([
            v.version,
            v.gitCommit?.slice(0, 12) ?? '-',
            v.createdBy ?? '-',
            new Date(v.createdAt).toLocaleString(),
            v.description ?? '-',
          ]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        emitError('Failed to list versions', e, { spinner });
      }
    });

  // acf task rollback <id>
  cmd.command('rollback <id>')
    .description('Roll a task back to a specific historical version snapshot')
    .requiredOption('--version <versionId>', 'Version ID to roll back to (see: acf task versions <id>)')
    .action(async (id, opts) => {
      const spinner = ora('Rolling back task…').start();
      try {
        const t = await post<Task>(`/tasks/${id}/versions/${opts.version}/rollback`);
        spinner.succeed(`Task rolled back: ${t.id}`);
        console.log(chalk.gray(`  name: ${t.name}  status: ${statusColor(t.status)}`));
      } catch (e: unknown) {
        emitError('Failed to roll back', e, { spinner });
      }
    });

  // acf task compare <id> <versionId1> <versionId2>
  cmd.command('compare <id> <versionId1> <versionId2>')
    .description('Diff two task versions (shows fields whose values differ)')
    // --json 补面（本轮 UX 统一）：diff 记录直出，脚本可断言具体字段
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (id, versionId1, versionId2, opts: { json?: boolean }) => {
      const spinner = ora('Comparing versions…').start();
      try {
        const diff = await get<Record<string, { old: unknown; new: unknown }>>(
          `/tasks/${id}/versions/${versionId1}/compare/${versionId2}`,
        );
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(diff ?? {}, null, 2));
          return;
        }
        const keys = Object.keys(diff ?? {});
        if (keys.length === 0) {
          console.log(chalk.green('No differences between the two versions.'));
          return;
        }
        const table = new Table({
          head: ['Field', 'Version 1', 'Version 2'],
          colWidths: [24, 38, 38],
          style: { head: ['cyan'] },
          wordWrap: true,
        });
        for (const k of keys) {
          table.push([
            k,
            JSON.stringify(diff[k].old) ?? '-',
            JSON.stringify(diff[k].new) ?? '-',
          ]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        emitError('Failed to compare versions', e, { spinner });
      }
    });

  // acf task create
  cmd.command('create')
    .description('Create a new task (JSON payload via --body or --file)')
    // 2026-10-07 deprecation：载荷旗标由 --json 更名 --body——--json 将在下一个
    // 大版本收敛为纯布尔「输出 JSON」旗标（与 task list/show/trigger 等命令的
    // 既有语义统一）。旧名本版本仍可用（与 --body 互斥），stderr 打警告。
    // 二者都声明为可选（requiredOption 会让 --json 过渡路径在 commander 层就
    // 被"缺必填"拒绝），缺一校验在 action 里做。
    .option('--body <json>', 'Task body as JSON string (required unless --file is given)')
    .option('--json <body>', 'DEPRECATED (renamed to --body): Task body as JSON string. In the next major version --json becomes a boolean output flag')
    .option('--file <path>', 'Read task body from a JSON file (overrides --body/--json)')
    .option('--executor <id>', 'Pin the task to a specific executor ID (uuid); mutually exclusive with executeMode=broadcast')
    .action(async (opts) => {
      if (opts.body !== undefined && opts.json !== undefined) {
        emitUsageError('--body and --json (deprecated alias) are mutually exclusive — pass only --body');
      }
      if (opts.body === undefined && opts.json === undefined && !opts.file) {
        emitUsageError('Missing required task body — pass --body <json> (or --file <path>)');
      }
      const spinner = ora('Creating task…').start();
      try {
        if (opts.json !== undefined) {
          process.stderr.write(
            chalk.yellow('⚠ --json <body> is deprecated and will be removed in the next major version (it will become a boolean output flag). Use --body <json> instead.\n'),
          );
        }
        const fs = await import('fs/promises');
        // 本地 payload 层错误（文件读不了/JSON 坏）= 用法错误（退出码 2），
        // 与服务端拒绝（1）区分；口径与 apps.ts 的 loadJsonBody 一致。
        let raw: string;
        try {
          raw = opts.file ? await fs.readFile(opts.file, 'utf-8') : (opts.body ?? opts.json);
        } catch (err) {
          throw new UsageError(`Cannot read payload file: ${opts.file} (${err instanceof Error ? err.message : String(err)})`);
        }
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch (err) {
          throw new UsageError(`Invalid JSON payload: ${err instanceof Error ? err.message : String(err)}`);
        }
        // R7 (N20): 显式 --executor 覆盖/补写 body.executorId（pinning）。
        if (opts.executor) body.executorId = opts.executor;
        const t = await post<Task>('/tasks', body);
        spinner.succeed(`Task created: ${t.id}`);
        console.log(chalk.gray(`  name: ${t.name}  status: ${statusColor(t.status)}`));
      } catch (e: unknown) {
        emitError('Failed to create task', e, { spinner });
      }
    });

  // acf task update <id>
  cmd.command('update <id>')
    .description('Update a task (JSON payload via --body or --file)')
    // 2026-10-07 deprecation：同 task create——载荷更名 --body，旧名过渡一版。
    .option('--body <json>', 'Task patch body as JSON string (required unless --file is given)')
    .option('--json <body>', 'DEPRECATED (renamed to --body): Task patch body as JSON string. In the next major version --json becomes a boolean output flag')
    .option('--file <path>', 'Read task patch body from a JSON file (overrides --body/--json)')
    .option('--executor <id>', 'Pin the task to a specific executor ID (uuid); pass --body {"executorId":null} to clear. Mutually exclusive with executeMode=broadcast')
    .action(async (id, opts) => {
      if (opts.body !== undefined && opts.json !== undefined) {
        emitUsageError('--body and --json (deprecated alias) are mutually exclusive — pass only --body');
      }
      if (opts.body === undefined && opts.json === undefined && !opts.file) {
        emitUsageError('Missing required task patch body — pass --body <json> (or --file <path>)');
      }
      const spinner = ora('Updating task…').start();
      try {
        if (opts.json !== undefined) {
          process.stderr.write(
            chalk.yellow('⚠ --json <body> is deprecated and will be removed in the next major version (it will become a boolean output flag). Use --body <json> instead.\n'),
          );
        }
        const fs = await import('fs/promises');
        // 本地 payload 层错误（文件读不了/JSON 坏）= 用法错误（退出码 2），
        // 与服务端拒绝（1）区分；口径与 apps.ts 的 loadJsonBody 一致。
        let raw: string;
        try {
          raw = opts.file ? await fs.readFile(opts.file, 'utf-8') : (opts.body ?? opts.json);
        } catch (err) {
          throw new UsageError(`Cannot read payload file: ${opts.file} (${err instanceof Error ? err.message : String(err)})`);
        }
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch (err) {
          throw new UsageError(`Invalid JSON payload: ${err instanceof Error ? err.message : String(err)}`);
        }
        // R7 (N20): 显式 --executor 覆盖/补写 body.executorId（pinning）。
        if (opts.executor) body.executorId = opts.executor;
        const t = await patch<Task>(`/tasks/${id}`, body);
        spinner.succeed(`Task updated: ${t.id}`);
        console.log(chalk.gray(`  name: ${t.name}  status: ${statusColor(t.status)}`));
      } catch (e: unknown) {
        emitError('Failed to update task', e, { spinner });
      }
    });

  // acf task delete <id>
  cmd.command('delete <id>')
    .description('Delete a task (force-terminates running executions)')
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .action(async (id, opts) => {
      // P0（CLI-AGENT-UX-AUDIT）：非交互 stdin 下必须显式拒绝，不能静默假绿。
      if (
        !(await confirmDestructive(
          `Delete task ${id}? Running executions will be force-terminated.`,
          { yes: opts.yes },
        ))
      ) {
        return;
      }
      const spinner = ora('Deleting task…').start();
      try {
        await del(`/tasks/${id}`);
        spinner.succeed(`Task ${id} deleted`);
      } catch (e: unknown) {
        emitError('Failed to delete task', e, { spinner });
      }
    });

  // acf task pause <id>
  cmd.command('pause <id>')
    .description('Pause task scheduled execution')
    .action(async (id) => {
      const spinner = ora('Pausing task…').start();
      try {
        const t = await post<Task>(`/tasks/${id}/pause`);
        spinner.succeed(`Task ${id} paused`);
        console.log(chalk.gray(`  status: ${statusColor(t.status)}`));
      } catch (e: unknown) {
        emitError('Failed to pause task', e, { spinner });
      }
    });

  // acf task resume <id>
  cmd.command('resume <id>')
    .description('Resume task scheduled execution')
    .action(async (id) => {
      const spinner = ora('Resuming task…').start();
      try {
        const t = await post<Task>(`/tasks/${id}/resume`);
        spinner.succeed(`Task ${id} resumed`);
        console.log(chalk.gray(`  status: ${statusColor(t.status)}`));
      } catch (e: unknown) {
        emitError('Failed to resume task', e, { spinner });
      }
    });

  // E-1: acf task export <id> [-o file] —— 导出任务定义为 JSON（导出物即
  // POST /tasks/import 的请求体，两端口径完全对称，CLI 不做任何本地变换）。
  // 服务端不经统一 envelope 包裹（@Res() 直写 attachment），client 的 unwrap
  // 判据（数值 code）不会命中，这里拿到的就是原始 { schemaVersion, exportedAt, task }。
  cmd.command('export <id>')
    .description('Export a task definition as JSON (the payload is accepted verbatim by `acf task import`; secrets are never part of it)')
    .option('-o, --output <file>', 'Write the JSON payload to a file instead of stdout')
    .action(async (id: string, opts: { output?: string }) => {
      const spinner = ora('Exporting task…').start();
      try {
        const payload = await get<TaskExportPayload>(`/tasks/${id}/export`);
        if (opts.output) {
          try {
            await fs.promises.writeFile(opts.output, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
          } catch (err) {
            // 本地文件层错误 = 用法错误（退出码 2），与服务端拒绝（1）区分。
            throw new UsageError(
              `Cannot write export file: ${opts.output} (${err instanceof Error ? err.message : String(err)})`,
            );
          }
          spinner.succeed(`Task exported to ${opts.output}`);
        } else {
          spinner.stop();
          console.log(JSON.stringify(payload, null, 2));
        }
      } catch (e: unknown) {
        emitError('Failed to export task', e, { spinner });
      }
    });

  // E-1: acf task import <file> —— 从导出物创建任务（"-" 读 stdin）。
  // 请求体 = 导出物原样回放（JSON.parse 后交由 axios 序列化，键序/键值不变）；
  // 重名自动加后缀不覆盖、secrets 键整体忽略（warnings 常驻重配提示）均为服务端语义。
  cmd.command('import <file>')
    .description('Create a task from an export payload ("-" reads stdin). The new task starts paused; reconfigure secrets afterwards (SEC-02: they are never transferred)')
    .action(async (file: string) => {
      const spinner = ora('Importing task…').start();
      try {
        let raw: string;
        try {
          raw = file === '-' ? await readStdin() : await fs.promises.readFile(file, 'utf-8');
        } catch (err) {
          // 本地 payload 层错误（文件读不了/stdin 不可用）= 用法错误（退出码 2）。
          throw new UsageError(
            `Cannot read payload ${file === '-' ? 'from stdin' : `file: ${file}`} (${err instanceof Error ? err.message : String(err)})`,
          );
        }
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch (err) {
          throw new UsageError(`Invalid JSON payload: ${err instanceof Error ? err.message : String(err)}`);
        }
        const result = await post<TaskImportResult>('/tasks/import', body);
        spinner.stop();
        spinner.succeed(`Task imported: ${result.taskId}`);
        console.log(chalk.gray(`  name: ${result.name}  status: paused`));
        for (const w of result.warnings ?? []) {
          console.log(chalk.yellow(`  ⚠ ${w}`));
        }
      } catch (e: unknown) {
        emitError('Failed to import task', e, { spinner });
      }
    });

  // 批量面：POST /tasks/batch/{trigger|pause|resume|delete}，body = { taskIds }。
  // 服务端逐个执行、部分失败不影响其他任务（失败项以 { id, error } 回传，恒 200）。
  cmd.command('batch <action> [ids...]')
    .description('Batch trigger/pause/resume/delete tasks (partial failures do not affect the other tasks)')
    .option('--ids <ids>', 'Comma-separated task IDs (merged with any positional ids, deduplicated)')
    .option('--json', 'Emit raw JSON (CI-consumable: the raw per-task result array)')
    .option('-y, --yes', 'Skip the confirmation prompt for batch delete', false)
    .action(async (action: string, ids: string[], opts: { ids?: string; json?: boolean; yes?: boolean }) => {
      const ACTIONS = ['trigger', 'pause', 'resume', 'delete'] as const;
      if (!(ACTIONS as readonly string[]).includes(action)) {
        emitUsageError(`Unknown batch action "${action}" — expected one of: ${ACTIONS.join(' | ')}`);
      }
      const fromFlag = (opts.ids ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      // 服务端硬契约（BatchTaskIdsDto）：1..500 个 uuid，单请求上限 500。
      const taskIds = [...new Set([...(ids ?? []), ...fromFlag])];
      if (taskIds.length === 0) {
        emitUsageError('No task IDs given — pass them as arguments or via --ids id1,id2,id3');
      }
      if (taskIds.length > 500) {
        emitUsageError(`Batch is limited to 500 task IDs per request (got ${taskIds.length})`);
      }
      // P1（CLI-AGENT-UX-AUDIT）：`batch delete` 此前**零确认**——单个
      // `task delete` 要确认，而 `--ids a,b,c`（上限 500 个）却能无提示抹掉
      // 一整批任务。按「不可逆 × 影响面」补确认，且与三处 delete 共用同一个
      // 非交互语义（缺 --yes 时以退出码 2 拒绝，不静默假绿）。
      if (action === 'delete') {
        if (
          !(await confirmDestructive(
            `Delete ${taskIds.length} task(s)? Running executions will be force-terminated.`,
            { yes: opts.yes },
          ))
        ) {
          return;
        }
      }
      const spinner = ora(`Batch ${action} (${taskIds.length} task(s))…`).start();
      try {
        // Promise.all 保序：results[i] 对应 taskIds[i]（失败项为 { id, error }）。
        const results = await post<Array<Record<string, unknown> | undefined>>(
          `/tasks/batch/${action}`,
          { taskIds },
        );
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(results ?? []));
          return;
        }
        let failed = 0;
        (results ?? []).forEach((r, i) => {
          const tid = taskIds[i] ?? String(i);
          if (r && typeof r === 'object' && 'error' in r) {
            failed++;
            console.log(chalk.red(`✗ ${tid}: ${String((r as { error: unknown }).error)}`));
          } else {
            console.log(chalk.green(`✔ ${tid}`));
          }
        });
        if (failed > 0) {
          // 部分失败：服务端仍是 200，但 CLI 要让 CI 看得见（对齐 CLI-EXIT-01
          // 的「--wait 失败终态 → 非零退出码」语义）。退出码 1 = 服务端拒绝类。
          console.error(
            chalk.red(`Batch ${action} finished with ${failed} failure(s) out of ${taskIds.length} task(s).`),
          );
          process.exitCode = 1;
        } else {
          console.log(chalk.green(`Batch ${action}: ${taskIds.length}/${taskIds.length} succeeded`));
        }
      } catch (e: unknown) {
        emitError(`Failed to batch ${action}`, e, { spinner });
      }
    });

  // acf task kill <taskId> <execId>
  cmd.command('kill <taskId> <execId>')
    .description('Force-cancel a running or pending execution')
    .action(async (taskId, execId) => {
      const spinner = ora('Cancelling execution…').start();
      try {
        const r = await post<{ success: boolean; message: string }>(
          `/tasks/${taskId}/executions/${execId}/kill`,
        );
        spinner.succeed(r.message || 'Execution cancelled');
      } catch (e: unknown) {
        emitError('Failed to cancel execution', e, { spinner });
      }
    });

  // P3: acf task webhook <enable|rotate|disable|status> <taskId>（FEAT-21 任务级
  // 入站 webhook）。契约：enable/rotate 响应 { url, secret }——secret 明文仅在
  // 该响应出现一次，服务端只存加密信封，输出必须带一次性提示（口径同 apikey
  // create 的 plaintext）；enable 对已启用任务等价轮换；disable 清空密钥、签名
  // 请求即刻 401；status（GET）只回 { enabled, url }，secret 永不回传——查看
  // URL 而不必轮换密钥的通路。
  cmd.command('webhook <action> <taskId>')
    .description(
      'Manage the task inbound webhook (HMAC-signed). enable/rotate print the secret exactly once; status shows the URL without touching the secret; disable makes signed calls answer 401 immediately',
    )
    .option('--json', 'Emit raw JSON (CI-consumable; includes the one-time secret for enable/rotate)')
    .action(async (action: string, taskId: string, opts: { json?: boolean }) => {
      const ACTIONS = ['enable', 'rotate', 'disable', 'status'] as const;
      if (!(ACTIONS as readonly string[]).includes(action)) {
        emitUsageError(`Unknown webhook action "${action}" — expected one of: ${ACTIONS.join(' | ')}`);
      }
      const spinner = ora(`Task webhook ${action}…`).start();
      try {
        if (action === 'status') {
          const s = await get<{ enabled: boolean; url: string }>(`/tasks/${taskId}/webhook`);
          spinner.stop();
          if (opts.json) {
            console.log(JSON.stringify(s));
            return;
          }
          console.log(chalk.bold('Task Webhook'));
          console.log('  Enabled:', s.enabled ? chalk.green('yes') : chalk.red('no'));
          console.log('  URL    :', s.url);
          console.log(chalk.gray('  (the secret is never returned by status — run rotate to reissue one)'));
          return;
        }
        if (action === 'disable') {
          const r = await post<{ enabled: false }>(`/tasks/${taskId}/webhook/disable`);
          spinner.stop();
          if (opts.json) {
            console.log(JSON.stringify(r));
            return;
          }
          spinner.succeed('Task webhook disabled — signed calls now answer 401');
          return;
        }
        // enable | rotate：{ url, secret } 一次性回显。路径必须显式——服务端
        // 是三条字面量路由（enable/rotate/disable），动态模板虽运行时可达，
        // 但 consumer-routes 守卫的静态对账无法把两段参数模板对上 openapi。
        const actionPath =
          action === 'enable'
            ? `/tasks/${taskId}/webhook/enable`
            : `/tasks/${taskId}/webhook/rotate`;
        const r = await post<{ url: string; secret: string }>(actionPath);
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(r));
          return;
        }
        spinner.succeed(
          action === 'enable'
            ? 'Task webhook enabled'
            : 'Task webhook secret rotated — the old secret stopped working immediately',
        );
        console.log('  URL    :', r.url);
        console.log('  Secret :', chalk.bold(r.secret));
        console.log(
          chalk.yellow(
            '  ⚠ The secret is shown only once — store it now (CI secret store / env file). It cannot be retrieved again; rotate to reissue.',
          ),
        );
        console.log(
          chalk.gray(
            '  Trigger: POST the URL with X-AutoCodeFlow-Timestamp and X-Hub-Signature-256: sha256=<hex of HMAC_SHA256(secret, "<timestamp>.<rawBody>")>',
          ),
        );
      } catch (e: unknown) {
        emitError(`Failed to ${action} task webhook`, e, { spinner });
      }
    });

  // P3: acf task glue <taskId> -f <file> | --stdin —— PUT /tasks/:id/glue
  //（{ source, language? }）。语言按扩展名推断或 --language 显式指定（白名单
  // 见 GLUE_LANGUAGES）；空/纯空白脚本服务端 400（会让任务静默改跑 entrypoint
  // 的自相矛盾态），CLI 本地同判提前拒绝。语法可先用 acf task lint 本地预检。
  cmd.command('glue <taskId>')
    .description(
      'Update the GLUE script inline (online code edit). Language is inferred from the file extension (.js/.mjs/.cjs → javascript, .py → python, .sh/.bash → shell) or forced with --language python|javascript|shell',
    )
    .option('-f, --file <path>', 'Read the script from a file; "-" reads stdin (same convention as acf task import)')
    .option('--stdin', 'Read the script from stdin (equivalent to -f -)')
    .option('--language <lang>', 'Language: python | javascript | shell (the executor rejects anything else at run time)')
    .action(async (taskId: string, opts: { file?: string; stdin?: boolean; language?: string }) => {
      if (opts.stdin && opts.file) {
        emitUsageError('--stdin and -f/--file are mutually exclusive');
      }
      if (!opts.stdin && !opts.file) {
        emitUsageError('Nothing to upload — pass -f <file> (or --stdin). Preview syntax locally first with: acf task lint <file>');
      }
      const fromStdin = opts.stdin || opts.file === '-';
      const spinner = ora('Updating glue script…').start();
      try {
        let source: string;
        try {
          source = fromStdin ? await readStdin() : await fs.promises.readFile(opts.file as string, 'utf-8');
        } catch (err) {
          // 本地 payload 层错误（文件读不了/stdin 不可用）= 用法错误（退出码 2）。
          throw new UsageError(
            `Cannot read script ${fromStdin ? 'from stdin' : `file: ${opts.file}`} (${err instanceof Error ? err.message : String(err)})`,
          );
        }
        if (!source.trim()) {
          // 与服务端 P0 防线同判（service 层拒绝空脚本，语义同一条消息）。
          throw new UsageError(
            'Refusing to upload an empty glue script — the server would reject it (the task would silently fall back to its entrypoint)',
          );
        }
        let language: string | undefined;
        if (opts.language) {
          if (!(GLUE_LANGUAGES as readonly string[]).includes(opts.language)) {
            throw new UsageError(
              `Unknown glue language "${opts.language}" — expected one of: ${GLUE_LANGUAGES.join(' | ')} (the executor rejects other values at run time)`,
            );
          }
          language = opts.language;
        } else if (fromStdin) {
          throw new UsageError('Cannot infer the glue language from stdin — pass --language python|javascript|shell');
        } else {
          const ext = path.extname(opts.file as string).toLowerCase();
          language = GLUE_EXT_LANG[ext];
          if (!language) {
            throw new UsageError(
              `Cannot infer the glue language from extension "${ext}" (${opts.file}) — pass --language python|javascript|shell`,
            );
          }
        }
        const t = await put<Task>(`/tasks/${taskId}/glue`, { source, language });
        spinner.succeed(`Glue script updated: ${t.id}`);
        console.log(
          chalk.gray(`  name: ${t.name}  language: ${language}  bytes: ${Buffer.byteLength(source, 'utf-8')}`),
        );
      } catch (e: unknown) {
        emitError('Failed to update glue script', e, { spinner });
      }
    });

  // ECO-02: acf task lint <file> —— 本地语法检查（node: 语法编译不执行；
  // python: ast.parse；shell: bash -n）。上传 glue 前把语法错误挡在本地。
  cmd
    .command('lint <file>')
    .description('Syntax-check a glue script locally (js/mjs/cjs/py/sh) without executing it')
    .option('--language <lang>', 'Override language detection (node/python/shell)')
    .action((file: string, opts: { language?: string }) => {
      let source: string;
      try {
        source = fs.readFileSync(file, 'utf-8');
      } catch {
        // 本地参数/文件层错误 → 用法错误（退出码 2），与服务端拒绝（1）区分。
        emitUsageError(`Cannot read file: ${file}`);
      }
      const ext = path.extname(file).toLowerCase();
      const lang =
        opts.language ??
        (['.js', '.mjs', '.cjs'].includes(ext)
          ? 'node'
          : ext === '.py'
            ? 'python'
            : ['.sh', '.bash'].includes(ext)
              ? 'shell'
              : undefined);
      if (!lang) {
        emitUsageError(`Cannot infer language from extension "${ext}" — pass --language node|python|shell`);
      }
      const ok = (msg: string) => {
        console.log(chalk.green(`✔ ${file}: ${msg}`));
        process.exit(0);
      };
      if (lang === 'node') {
        try {
          // new Function 编译函数体但不调用——纯语法检查，零执行副作用。
          // 包裹 try/catch 形态的 glue 源码同样能被编译。
          // eslint-disable-next-line no-new-func
          new Function(source);
        } catch (err) {
          console.error(chalk.red(`✗ ${file}: syntax error`));
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }
        ok('syntax OK (node)');
      } else if (lang === 'python') {
        const py = ['python3', 'python'].find((bin) => {
          const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
          return r.status === 0;
        });
        if (!py) {
          // 环境不满足 ≠ 脚本有语法错：给退出码 2（用法/环境），让 CI 能区分
          // 「我的脚本坏了」与「这台机器没装 Python」。
          emitUsageError(
            'python not found on PATH — install Python 3 to lint python glue (or pass --language to check another runtime)',
          );
        }
        // 走 stdin 传源码而非把路径当 argv：Windows 路径的反斜杠会被 bash/python
        // 的解析层吃掉（`C:\Users\...` → `C:Users...`），实测必假报。
        const r = spawnSync(py, ['-c', `import ast,sys; ast.parse(sys.stdin.read())`], {
          input: source,
          stdio: 'pipe',
        });
        if (r.status !== 0) {
          console.error(chalk.red(`✗ ${file}: syntax error`));
          process.stderr.write(r.stderr?.toString() ?? '');
          process.exit(1);
        }
        ok('syntax OK (python, ast.parse)');
      } else {
        // P1（CLI-AGENT-UX-AUDIT）：此前是 spawnSync('bash', ['-n', file])——
        // Windows 上 bash 把 `C:\Users\...` 的反斜杠当转义符吃掉，报
        // `/bin/bash: C:Users... No such file or directory`，**任何合法脚本
        // 都被判 syntax error**（实测 Git Bash 在场同样复现）。改成把源码经
        // stdin 喂给 `bash -n`（等价的纯语法检查，且跨平台不依赖路径形态）。
        //
        // bash 不存在时（纯 Windows 无 Git Bash）改为可操作的用法错误（码 2），
        // 而不是把 spawn 失败混同成「脚本有语法错」。
        if (!hasCommand('bash')) {
          emitUsageError(
            'bash not found on PATH — install Git Bash (or WSL) to lint shell glue, or pass --language to check another runtime',
          );
        }
        const r = spawnSync('bash', ['-n'], { input: source, stdio: 'pipe' });
        if (r.status !== 0) {
          console.error(chalk.red(`✗ ${file}: syntax error`));
          process.stderr.write(r.stderr?.toString() ?? '');
          process.exit(1);
        }
        ok('syntax OK (bash -n)');
      }
    });

  return cmd;
}

async function pollExecution(
  execId: string,
  waitTimeoutSeconds = 600,
  opts: { json?: boolean } = {},
): Promise<void> {
  const INTERVAL = 2000;
  const MAX_WAIT = waitTimeoutSeconds * 1000;
  const spinner = ora('Waiting for execution…').start();
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT) {
    await sleep(INTERVAL);
    try {
      const exec = await get<Execution>(`/tasks/executions/${execId}`);
      // killed 是后端 ExecutionStatus 的合法终态（acf task kill / Web 端），
      // 遗漏会让 --wait 在被 kill 后空转到 MAX_WAIT 并误报超时（N10）。
      if (['success', 'failed', 'timeout', 'cancelled', 'killed'].includes(exec.status)) {
        if (opts.json) {
          // P2（CLI-AGENT-UX-AUDIT）：--json --wait 的唯一 stdout 出口 ——
          // 最终 execution 对象（含 status/exitCode/failureReason/errorMessage/
          // aiAnalysis），不再混入人类可读行。细节走 stderr 便于人眼旁读。
          spinner.stop();
          console.log(JSON.stringify(exec, null, 2));
          if (exec.status !== 'success') {
            process.stderr.write(
              chalk.yellow(
                `Execution ${exec.status}` +
                  (exec.failureReason ? ` (${exec.failureReason})` : '') +
                  '\n',
              ),
            );
          }
          if (exec.status !== 'success') process.exitCode = 1;
          return;
        }
        if (exec.status === 'success') {
          spinner.succeed(`Execution ${exec.status} in ${exec.duration ?? '?'}ms`);
        } else {
          spinner.fail(`Execution ${exec.status}`);
          // CLI-EXIT-01（本轮审计）：--wait 的契约是「等完并给出结果」，
          // 但此前失败终态只打印原因就 return，退出码依旧是 0——CI 里
          // `acf task trigger <id> --wait && echo ok` 在任务失败时照样打印
          // ok，整条 --wait 通道对自动化不可用。与 `acf exec tail` 同场景
          // 的语义对齐（那里已是 status==='success' ? 0 : 1）：失败终态
          // 置 exitCode=1，成功保持 0。
          // 用 exitCode 赋值而非 process.exit(1)：让调用方（trigger 的
          // action、以及将来任何组合命令）仍能走完自己的收尾路径。
          process.exitCode = 1;
          // U11: surface the structured failure cause the executor reported
          // (exitCode / failureReason) — previously only aiAnalysis printed,
          // so a non-zero exit or timeout reason was invisible without
          // digging through `acf task logs`.
          if (exec.exitCode !== null && exec.exitCode !== undefined) {
            console.log(chalk.yellow('  Exit code      :'), exec.exitCode);
          }
          if (exec.failureReason) {
            console.log(chalk.yellow('  Failure reason :'), exec.failureReason);
            // 可操作建议：failureReason 是机器枚举，直接给"下一步怎么做"。
            const hint = FAILURE_REASON_HINTS[exec.failureReason];
            if (hint) console.log(chalk.yellow('  Suggestion     :'), hint);
          }
          if (exec.errorMessage) {
            console.log(chalk.yellow('  Error          :'), exec.errorMessage);
          }
          if (exec.aiAnalysis) {
            console.log(chalk.yellow('\nAI Analysis:'), exec.aiAnalysis);
          }
        }
        return;
      }
      spinner.text = `Status: ${exec.status}…`;
    } catch (e: unknown) {
      // 4xx（除 429）是确定性失败（token 失效/执行不存在等）——继续轮询只会
      // 空转到 MAX_WAIT 并误报超时，掩盖真实错误；立即退出并透出后端消息。
      const status = axios.isAxiosError(e) ? e.response?.status : undefined;
      if (status && status >= 400 && status < 500 && status !== 429) {
        // 统一错误出口：4xx 按类别映射退出码（401→3、其余→1），网络/5xx 继续
        // 轮询（下方 transient 分支）。
        emitError('Waiting for execution failed', e, { spinner });
      }
      // transient (network / 429 / 5xx), keep polling
    }
  }
  // NETOPT-2①：--wait 的承诺是「等完并给出结果」，但轮询窗口耗尽时此前只
  // spinner.fail 就返回，退出码依旧是 0——执行明明还在跑，CI 里
  // `acf task trigger <id> --wait && …` 对任何超过等待上限的真实长任务假绿。
  // 与上方失败终态的 CLI-EXIT-01 语义对齐：置 exitCode=1，并明示执行仍在
  // 运行、如何继续观察（exec tail）或放宽等待上限（--wait-timeout）。
  spinner.fail(`Timed out waiting for execution after ${waitTimeoutSeconds}s`);
  if (opts.json) {
    // --json 下超时也只留 stderr：stdout 要么是干净的最终 JSON，要么什么都没有
    // （此处确实没有终态可输出——超时意味着没有终态）。
    process.stderr.write(
      chalk.red(
        `The execution is still running — no terminal status within ${waitTimeoutSeconds}s. ` +
          `Follow it later with 'acf exec tail ${execId}' or raise --wait-timeout.\n`,
      ),
    );
    process.exitCode = 1;
    return;
  }
  console.error(
    chalk.red(
      `The execution is still running — no terminal status within ${waitTimeoutSeconds}s. ` +
        `Follow it later with 'acf exec tail ${execId}' or raise --wait-timeout.`,
    ),
  );
  process.exitCode = 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 探测可执行文件是否在 PATH 上（`task lint` 的 shell 分支用）。
 * 用 `--version` 的成功退出码判定，`stdio: 'ignore'` 避免污染 lint 的输出；
 * 探测本身的失败（ENOENT）也统一归为「不可用」。
 */
function hasCommand(bin: string): boolean {
  try {
    return spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}
