import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import { get } from '../client';

interface Executor {
  id: string;
  name: string;
  status: string;
  hostname?: string;
  lastHeartbeat?: string;
  runtime?: string[];
  currentLoad?: number;
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
          head: ['ID', 'Name', 'Status', 'Hostname', 'Last Heartbeat', 'Load'],
          colWidths: [14, 20, 10, 20, 18, 8],
          style: { head: ['cyan'] },
        });
        for (const e of executors) {
          table.push([
            e.id.slice(0, 12),
            e.name ?? '-',
            statusColor(e.status),
            e.hostname ?? '-',
            heartbeatAge(e.lastHeartbeat),
            e.currentLoad !== undefined ? `${e.currentLoad}` : '-',
          ]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        spinner.fail('Failed');
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    });

  return cmd;
}
