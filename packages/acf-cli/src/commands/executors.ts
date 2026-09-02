import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import { get, formatApiError } from '../client';

// Field names aligned with the Executor entity
// (apps/admin-api/src/modules/executor/entities/executor.entity.ts)
interface Executor {
  id: string;
  appName: string;
  address: string;
  status: string;
  type?: string;
  executorVersion?: string;
  groupName?: string | null;
  tags?: string[] | null;
  description?: string | null;
  runningTaskCount?: number;
  maxConcurrentTasks?: number | null;
  cpuUsage?: number | null;
  memUsage?: number | null;
  totalTaskCount?: number;
  failedTaskCount?: number;
  lastHeartbeat?: string;
}

function statusColor(s: string): string {
  if (s === 'online') return chalk.green(s);
  if (s === 'offline') return chalk.red(s);
  return chalk.yellow(s);
}

function heartbeatAge(ts?: string): string {
  if (!ts) return '-';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return chalk.green(`${Math.round(diff / 1000)}s ago`);
  if (diff < 300_000) return chalk.yellow(`${Math.round(diff / 60000)}m ago`);
  return chalk.red(`${Math.round(diff / 60000)}m ago`);
}

function pct(v?: number | null): string {
  return v === null || v === undefined ? '-' : `${v}%`;
}

export function executorsCommand(): Command {
  const cmd = new Command('executor').description('View registered executors');

  cmd.command('list')
    .description('List all executors and their status')
    .action(async () => {
      const spinner = ora('Fetching executors…').start();
      try {
        const data = await get<Executor[] | { list: Executor[] }>('/executors');
        spinner.stop();
        const executors: Executor[] = Array.isArray(data) ? data : (data.list ?? []);
        const table = new Table({
          head: ['ID', 'App Name', 'Status', 'Address', 'Last Heartbeat', 'CPU', 'Running'],
          colWidths: [14, 20, 10, 22, 18, 8, 9],
          style: { head: ['cyan'] },
        });
        for (const e of executors) {
          table.push([
            e.id.slice(0, 12),
            e.appName ?? '-',
            statusColor(e.status),
            e.address ?? '-',
            heartbeatAge(e.lastHeartbeat),
            pct(e.cpuUsage),
            e.runningTaskCount !== undefined ? `${e.runningTaskCount}` : '-',
          ]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        spinner.fail('Failed');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf executor get <id>
  cmd.command('get <id>')
    .description('Show details of a single executor (config, status, metrics)')
    .action(async (id) => {
      const spinner = ora('Fetching executor…').start();
      try {
        const e = await get<Executor>(`/executors/${id}`);
        spinner.stop();
        console.log(chalk.bold('Executor Details'));
        console.log('  ID                :', e.id);
        console.log('  App Name          :', e.appName ?? '-');
        console.log('  Address           :', e.address ?? '-');
        console.log('  Status            :', statusColor(e.status));
        console.log('  Type              :', e.type ?? '-');
        console.log('  Version           :', e.executorVersion ?? '-');
        console.log('  Group             :', e.groupName ?? '-');
        console.log('  Tags              :', e.tags?.length ? e.tags.join(', ') : '-');
        console.log('  Description       :', e.description ?? '-');
        console.log('  Running Tasks     :', e.runningTaskCount ?? 0);
        console.log('  Max Concurrent    :', e.maxConcurrentTasks ?? '-');
        console.log('  Total Tasks       :', e.totalTaskCount ?? 0);
        console.log('  Failed Tasks      :', e.failedTaskCount ?? 0);
        console.log('  CPU               :', pct(e.cpuUsage));
        console.log('  Memory            :', pct(e.memUsage));
        console.log('  Last Heartbeat    :', e.lastHeartbeat ? `${new Date(e.lastHeartbeat).toLocaleString()} (${heartbeatAge(e.lastHeartbeat)})` : '-');
      } catch (e: unknown) {
        spinner.fail('Failed');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  return cmd;
}
