import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { get, post, patch, del, formatApiError } from '../client';

interface Task {
  id: string;
  name: string;
  status: string;
  runtime: string;
  cronExpression?: string;
  applicationId?: string;
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
    .option('-k, --keyword <keyword>', 'Search by name (sent as the `name` query param)')
    .option('-p, --page <n>', 'Page number', '1')
    .option('-n, --page-size <n>', 'Items per page', '20')
    .action(async (opts) => {
      const spinner = ora('Fetching tasks…').start();
      try {
        // ListTasksQueryDto has `name` (no `keyword`)
        const data = await get<PaginatedTasks>('/tasks', {
          page: opts.page,
          pageSize: opts.pageSize,
          status: opts.status,
          name: opts.keyword,
        });
        spinner.stop();
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
        spinner.fail('Failed to list tasks');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf task get <id>
  cmd.command('get <id>')
    .description('Show task details')
    .action(async (id) => {
      const spinner = ora('Fetching task…').start();
      try {
        const t = await get<Task>(`/tasks/${id}`);
        spinner.stop();
        console.log(chalk.bold('Task Details'));
        console.log('  ID      :', t.id);
        console.log('  Name    :', t.name);
        console.log('  Runtime :', t.runtime);
        console.log('  Status  :', statusColor(t.status));
        console.log('  Cron    :', t.cronExpression ?? '-');
      } catch (e: unknown) {
        spinner.fail('Failed');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf task trigger <id>
  cmd.command('trigger <id>')
    .description('Manually trigger a task and wait for completion')
    .option('--wait', 'Poll until execution finishes', false)
    // NOTE: no --executor option here — TriggerTaskDto only accepts `params`
    // and the backend ValidationPipe runs with forbidNonWhitelisted, so a
    // per-trigger pin would be rejected with 400. Executor pinning IS
    // supported by the backend as a task-level field (tasks.executorId) — set
    // it via `acf task create/update --executor <id>`, not per run.
    .action(async (id, opts) => {
      const spinner = ora('Triggering task…').start();
      try {
        const exec = await post<Execution>(`/tasks/${id}/trigger`);
        spinner.succeed(`Execution started: ${exec.id}`);
        if (opts.wait) {
          await pollExecution(exec.id);
        }
      } catch (e: unknown) {
        spinner.fail('Failed to trigger');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf task executions <id>
  cmd.command('executions <id>')
    .description('List recent executions for a task')
    .option('-n, --limit <n>', 'Number of results', '10')
    .action(async (id, opts) => {
      const spinner = ora('Fetching executions…').start();
      try {
        // 后端 PaginationDto 只认 page/pageSize——不发送 `limit`，
        // 否则开启 forbidNonWhitelisted 后必然 400（N7/N10）。
        const data = await get<{ list: Execution[]; total: number }>(`/tasks/${id}/executions`, {
          pageSize: opts.limit,
          page: 1,
        });
        spinner.stop();
        const table = new Table({
          // U11: exitCode column — distinguishes "failed by callback
          // report" (exit 0 / null) from "process died" (non-zero).
          head: ['Exec ID', 'Status', 'Duration', 'Exit', 'Started'],
          colWidths: [14, 12, 12, 6, 25],
          style: { head: ['cyan'] },
        });
        for (const e of data.list ?? []) {
          table.push([
            e.id.slice(0, 12),
            statusColor(e.status),
            e.duration ? `${e.duration}ms` : '-',
            e.exitCode ?? '-',
            new Date(e.createdAt).toLocaleString(),
          ]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        spinner.fail('Failed');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf task logs <execId>
  cmd.command('logs <execId>')
    .description('Fetch execution logs (line-paginated)')
    .option('-f, --from-line <n>', 'Start line (0-based)', '0')
    .option('-n, --limit <n>', 'Max lines to fetch (max 2000)', '200')
    .option('--tail <n>', 'Show last N lines (overrides --from-line)')
    .action(async (execId, opts) => {
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
          for (const l of data.lines ?? []) console.log(l);
          console.log(chalk.gray(`\n(${data.lines?.length ?? 0}/${data.totalLines} lines — last ${tail})`));
        } else {
          const fromLine = parseInt(opts.fromLine, 10) || 0;
          const data = await get<{ lines: string[]; totalLines: number; hasMore: boolean }>(
            `/tasks/executions/${execId}/logs`,
            { fromLine, limit: opts.limit },
          );
          spinner.stop();
          for (const l of data.lines ?? []) console.log(l);
          if (data.hasMore) {
            console.log(chalk.gray(`\n… hasMore — next: acf task logs ${execId} --from-line ${fromLine + (data.lines?.length ?? 0)}`));
          } else {
            console.log(chalk.gray(`\n(${data.totalLines} lines total)`));
          }
        }
      } catch (e: unknown) {
        spinner.fail('Failed to fetch logs');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf task analyze <taskId> <execId>
  cmd.command('analyze <taskId> <execId>')
    .description('Run AI analysis on a failed execution')
    .action(async (taskId, execId) => {
      const spinner = ora('Running AI analysis…').start();
      try {
        const result = await post<{ aiAnalysis: string }>(`/tasks/${taskId}/executions/${execId}/analyze`);
        spinner.stop();
        console.log(chalk.bold('\nAI Analysis'));
        console.log(result.aiAnalysis || 'No analysis available (AI not configured).');
      } catch (e: unknown) {
        spinner.fail('Analysis failed');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf task suggest-schedule <id>
  cmd.command('suggest-schedule <id>')
    .description('Ask AI to suggest an optimal cron schedule')
    .action(async (id) => {
      const spinner = ora('Asking AI for schedule suggestion…').start();
      try {
        const result = await post<{ suggestedCron: string; currentCron: string | null; reasoning: string }>(
          `/tasks/${id}/suggest-schedule`,
        );
        spinner.stop();
        console.log(chalk.bold('Schedule Suggestion'));
        console.log('  Current   :', result.currentCron ?? '(none)');
        console.log('  Suggested :', chalk.green(result.suggestedCron));
        console.log('\nReasoning:');
        console.log(result.reasoning);
      } catch (e: unknown) {
        spinner.fail('Failed');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf task stats <id>
  cmd.command('stats <id>')
    .description('Show execution statistics for a task')
    .action(async (id) => {
      const spinner = ora('Fetching stats…').start();
      try {
        const s = await get<{ successRate: number; avgDuration: number; totalRuns: number; recentExecutions: Execution[] }>(`/tasks/${id}/stats`);
        spinner.stop();
        console.log(chalk.bold('Execution Stats'));
        console.log(`  Success rate : ${chalk.green(s.successRate + '%')}`);
        console.log(`  Avg duration : ${s.avgDuration}ms`);
        console.log(`  Total runs   : ${s.totalRuns}`);
      } catch (e: unknown) {
        spinner.fail('Failed');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf task versions <id>
  cmd.command('versions <id>')
    .description('List historical versions of a task')
    .action(async (id) => {
      const spinner = ora('Fetching task versions…').start();
      try {
        const versions = await get<Array<{ id: string; version: string; gitCommit?: string; createdBy?: string; description?: string; createdAt: string }>>(
          `/tasks/${id}/versions`,
        );
        spinner.stop();
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
        spinner.fail('Failed to list versions');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
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
        spinner.fail('Failed to roll back');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf task compare <id> <versionId1> <versionId2>
  cmd.command('compare <id> <versionId1> <versionId2>')
    .description('Diff two task versions (shows fields whose values differ)')
    .action(async (id, versionId1, versionId2) => {
      const spinner = ora('Comparing versions…').start();
      try {
        const diff = await get<Record<string, { old: unknown; new: unknown }>>(
          `/tasks/${id}/versions/${versionId1}/compare/${versionId2}`,
        );
        spinner.stop();
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
        spinner.fail('Failed to compare versions');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf task create
  cmd.command('create')
    .description('Create a new task (JSON payload via --json or --file)')
    .requiredOption('--json <body>', 'Task body as JSON string')
    .option('--file <path>', 'Read task body from a JSON file (overrides --json)')
    .option('--executor <id>', 'Pin the task to a specific executor ID (uuid); mutually exclusive with executeMode=broadcast')
    .action(async (opts) => {
      const spinner = ora('Creating task…').start();
      try {
        const fs = await import('fs/promises');
        const raw = opts.file
          ? await fs.readFile(opts.file, 'utf-8')
          : opts.json;
        const body = JSON.parse(raw);
        // R7 (N20): 显式 --executor 覆盖/补写 body.executorId（pinning）。
        if (opts.executor) body.executorId = opts.executor;
        const t = await post<Task>('/tasks', body);
        spinner.succeed(`Task created: ${t.id}`);
        console.log(chalk.gray(`  name: ${t.name}  status: ${statusColor(t.status)}`));
      } catch (e: unknown) {
        spinner.fail('Failed to create task');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf task update <id>
  cmd.command('update <id>')
    .description('Update a task (JSON payload via --json or --file)')
    .requiredOption('--json <body>', 'Task patch body as JSON string')
    .option('--file <path>', 'Read task patch body from a JSON file (overrides --json)')
    .option('--executor <id>', 'Pin the task to a specific executor ID (uuid); pass --json {"executorId":null} to clear. Mutually exclusive with executeMode=broadcast')
    .action(async (id, opts) => {
      const spinner = ora('Updating task…').start();
      try {
        const fs = await import('fs/promises');
        const raw = opts.file
          ? await fs.readFile(opts.file, 'utf-8')
          : opts.json;
        const body = JSON.parse(raw);
        // R7 (N20): 显式 --executor 覆盖/补写 body.executorId（pinning）。
        if (opts.executor) body.executorId = opts.executor;
        const t = await patch<Task>(`/tasks/${id}`, body);
        spinner.succeed(`Task updated: ${t.id}`);
        console.log(chalk.gray(`  name: ${t.name}  status: ${statusColor(t.status)}`));
      } catch (e: unknown) {
        spinner.fail('Failed to update task');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf task delete <id>
  cmd.command('delete <id>')
    .description('Delete a task (force-terminates running executions)')
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .action(async (id, opts) => {
      if (!opts.yes) {
        const readline = await import('readline/promises');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(`Delete task ${id}? Running executions will be force-terminated. [y/N] `);
        rl.close();
        if (!/^y(es)?$/i.test(answer)) {
          console.log(chalk.yellow('Aborted.'));
          return;
        }
      }
      const spinner = ora('Deleting task…').start();
      try {
        await del(`/tasks/${id}`);
        spinner.succeed(`Task ${id} deleted`);
      } catch (e: unknown) {
        spinner.fail('Failed to delete task');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
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
        spinner.fail('Failed to pause task');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
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
        spinner.fail('Failed to resume task');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
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
        spinner.fail('Failed to cancel execution');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  return cmd;
}

async function pollExecution(execId: string): Promise<void> {
  const INTERVAL = 2000;
  const MAX_WAIT = 10 * 60 * 1000; // 10 min
  const spinner = ora('Waiting for execution…').start();
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT) {
    await sleep(INTERVAL);
    try {
      const exec = await get<Execution>(`/tasks/executions/${execId}`);
      // killed 是后端 ExecutionStatus 的合法终态（acf task kill / Web 端），
      // 遗漏会让 --wait 在被 kill 后空转到 MAX_WAIT 并误报超时（N10）。
      if (['success', 'failed', 'timeout', 'cancelled', 'killed'].includes(exec.status)) {
        if (exec.status === 'success') {
          spinner.succeed(`Execution ${exec.status} in ${exec.duration ?? '?'}ms`);
        } else {
          spinner.fail(`Execution ${exec.status}`);
          // U11: surface the structured failure cause the executor reported
          // (exitCode / failureReason) — previously only aiAnalysis printed,
          // so a non-zero exit or timeout reason was invisible without
          // digging through `acf task logs`.
          if (exec.exitCode !== null && exec.exitCode !== undefined) {
            console.log(chalk.yellow('  Exit code      :'), exec.exitCode);
          }
          if (exec.failureReason) {
            console.log(chalk.yellow('  Failure reason :'), exec.failureReason);
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
        spinner.fail('Waiting for execution failed');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
      // transient (network / 429 / 5xx), keep polling
    }
  }
  spinner.fail('Timed out waiting for execution');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
