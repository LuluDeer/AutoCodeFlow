import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import { get, formatApiError } from '../client.js';

// Field names aligned with the AgentSession entity
// (apps/admin-api/src/modules/agent/entities/agent-session.entity.ts).
interface AgentSession {
  id: string;
  kind: string;
  status: string;
  title?: string;
  triggerSource?: string;
  createdAt?: string;
}

export function agentCommand(): Command {
  const cmd = new Command('agent').description('Inspect agent sessions');

  // acf agent sessions
  cmd.command('sessions')
    .description('List agent sessions (newest first; waiting_input = paused on a human decision)')
    .option('--kind <kind>', 'Filter by kind (ops_watch | incident | sop_authoring)')
    .option('--status <status>', 'Filter by status (pending | running | waiting_input | succeeded | failed | aborted)')
    .option('-p, --page <n>', 'Page number', '1')
    .option('-n, --page-size <n>', 'Page size (max 100)', '20')
    .action(async (opts) => {
      const spinner = ora('Fetching agent sessions…').start();
      try {
        const data = await get<{ items?: AgentSession[]; data?: AgentSession[]; total?: number }>(
          '/agent/sessions',
          {
            page: opts.page,
            pageSize: opts.pageSize,
            kind: opts.kind,
            status: opts.status,
          },
        );
        spinner.stop();
        const items = data.items ?? data.data ?? [];
        const table = new Table({
          head: ['Time', 'Kind', 'Status', 'Title', 'ID'],
          colWidths: [22, 14, 14, 36, 20],
          style: { head: ['cyan'] },
        });
        for (const s of items) {
          table.push([
            s.createdAt ? new Date(s.createdAt).toLocaleString() : '-',
            s.kind,
            statusColor(s.status),
            s.title ?? '-',
            s.id,
          ]);
        }
        console.log(table.toString());
        console.log(
          chalk.gray(`Total: ${data.total ?? items.length}  page ${opts.page}`),
        );
      } catch (e: unknown) {
        spinner.fail('Failed to list agent sessions');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  return cmd;
}

function statusColor(s: string): string {
  if (s === 'succeeded') return chalk.green(s);
  if (s === 'failed' || s === 'aborted') return chalk.red(s);
  if (s === 'waiting_input') return chalk.yellow(s);
  return s;
}
