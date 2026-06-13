import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import { get, post } from '../client';

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
}

interface PaginatedTasks {
  list: Task[];
  total: number;
  page: number;
  pageSize: number;
}

function statusColor(s: string): string {
  if (s === 'success') return chalk.green(s);
  if (s === 'failed' || s === 'timeout') return chalk.red(s);
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
    .option('-s, --status <status>', 'Filter by status (active|paused|disabled)')
    .option('-k, --keyword <keyword>', 'Search by name')
    .option('-p, --page <n>', 'Page number', '1')
    .option('-n, --page-size <n>', 'Items per page', '20')
    .action(async (opts) => {
      const spinner = ora('Fetching tasks…').start();
      try {
        const data = await get<PaginatedTasks>('/tasks', {
          page: opts.page,
          pageSize: opts.pageSize,
          status: opts.status,
          keyword: opts.keyword,
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
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
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
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    });

  // acf task trigger <id>
  cmd.command('trigger <id>')
    .description('Manually trigger a task and wait for completion')
    .option('--wait', 'Poll until execution finishes', false)
    .option('--executor <executorId>', 'Pin to a specific executor')
    .action(async (id, opts) => {
      const spinner = ora('Triggering task…').start();
      try {
        const exec = await post<Execution>(`/tasks/${id}/trigger`, {
          executorId: opts.executor,
        });
        spinner.succeed(`Execution started: ${exec.id}`);
        if (opts.wait) {
          await pollExecution(exec.id);
        }
      } catch (e: unknown) {
        spinner.fail('Failed to trigger');
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
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
        const data = await get<{ list: Execution[]; total: number }>('/tasks/executions/list', {
          taskId: id,
          pageSize: opts.limit,
          page: 1,
        });
        spinner.stop();
        const table = new Table({
          head: ['Exec ID', 'Status', 'Duration', 'Started'],
          colWidths: [14, 12, 12, 25],
          style: { head: ['cyan'] },
        });
        for (const e of data.list ?? []) {
          table.push([
            e.id.slice(0, 12),
            statusColor(e.status),
            e.duration ? `${e.duration}ms` : '-',
            new Date(e.createdAt).toLocaleString(),
          ]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        spinner.fail('Failed');
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
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
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
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
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
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
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
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
      if (['success', 'failed', 'timeout', 'cancelled'].includes(exec.status)) {
        if (exec.status === 'success') {
          spinner.succeed(`Execution ${exec.status} in ${exec.duration ?? '?'}ms`);
        } else {
          spinner.fail(`Execution ${exec.status}`);
          if (exec.aiAnalysis) {
            console.log(chalk.yellow('\nAI Analysis:'), exec.aiAnalysis);
          }
        }
        return;
      }
      spinner.text = `Status: ${exec.status}…`;
    } catch {
      // transient, keep polling
    }
  }
  spinner.fail('Timed out waiting for execution');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
