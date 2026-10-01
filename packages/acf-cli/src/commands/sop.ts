import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import { get, formatApiError } from '../client.js';

// Field names aligned with the Sop entity
// (apps/admin-api/src/modules/sop/entities/sop.entity.ts);
// sop.service.list returns `{ items, total }`.
interface Sop {
  id: string;
  slug: string;
  title: string;
  currentVersion?: string | null;
  status: string;
  updatedAt?: string;
}

export function sopCommand(): Command {
  const cmd = new Command('sop').description('Inspect SOP definitions');

  // acf sop list
  cmd.command('list')
    .description('List SOP definitions (newest update first)')
    .option('--status <status>', 'Filter by SOP status (draft | published | deprecated)')
    .option('-p, --page <n>', 'Page number', '1')
    .option('-n, --page-size <n>', 'Page size (max 100)', '20')
    .action(async (opts) => {
      const spinner = ora('Fetching SOPs…').start();
      try {
        const data = await get<{ items: Sop[]; total: number }>('/sop', {
          page: opts.page,
          pageSize: opts.pageSize,
          status: opts.status,
        });
        spinner.stop();
        const items = data.items ?? [];
        const table = new Table({
          head: ['Title', 'Slug', 'Status', 'Version', 'Updated'],
          colWidths: [32, 24, 12, 12, 24],
          style: { head: ['cyan'] },
        });
        for (const s of items) {
          table.push([
            s.title,
            s.slug,
            statusColor(s.status),
            s.currentVersion ?? '-',
            s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '-',
          ]);
        }
        console.log(table.toString());
        console.log(chalk.gray(`Total: ${data.total ?? items.length}  page ${opts.page}`));
      } catch (e: unknown) {
        spinner.fail('Failed to list SOPs');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf sop show <id>
  cmd.command('show <sopId>')
    .description('Show one SOP: status, current version and markdown body')
    .action(async (sopId: string) => {
      const spinner = ora('Fetching SOP…').start();
      try {
        const s = await get<Sop & { bodyMarkdown?: string | null }>(`/sop/${sopId}`);
        spinner.stop();
        console.log(chalk.bold(s.title));
        console.log(chalk.gray(`slug: ${s.slug}  status: ${s.status}  version: ${s.currentVersion ?? '-'}  updated: ${s.updatedAt ?? '-'}`));
        if (s.bodyMarkdown) {
          console.log('');
          console.log(s.bodyMarkdown);
        } else {
          console.log(chalk.gray('(no body — the SOP has no published version yet)'));
        }
      } catch (e: unknown) {
        spinner.fail('Failed to show SOP');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  return cmd;
}

function statusColor(s: string): string {
  if (s === 'published') return chalk.green(s);
  if (s === 'deprecated') return chalk.red(s);
  return s;
}
