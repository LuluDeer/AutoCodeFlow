import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import { get, formatApiError } from '../client';

// Field names aligned with the AuditLog entity
// (apps/admin-api/src/modules/audit/entities/audit-log.entity.ts);
// audit.service.findAll returns `{ data, total }`.
interface AuditLog {
  id: number;
  userId?: number;
  username?: string;
  action: string;
  resource?: string;
  resourceId?: string;
  result?: string;
  ip?: string;
  createdAt: string;
}

function resultColor(r?: string): string {
  if (r === 'success') return chalk.green(r);
  if (r === 'failure') return chalk.red(r);
  return r ?? '-';
}

export function auditCommand(): Command {
  const cmd = new Command('audit').description('Query the audit log');

  // acf audit list
  cmd.command('list')
    .description('List audit log entries (newest first)')
    .option('--action <action>', 'Filter by action, fuzzy match (e.g. task.trigger)')
    .option('--resource <resource>', 'Filter by exact resource type (e.g. task)')
    .option('--user-id <n>', 'Filter by operator user id')
    .option('--username <username>', 'Filter by operator username (fuzzy match)')
    .option('--start-time <iso>', 'Only entries created at/after this time (ISO 8601, e.g. 2026-01-01T00:00:00Z)')
    .option('--end-time <iso>', 'Only entries created at/before this time (ISO 8601)')
    .option('-p, --page <n>', 'Page number', '1')
    .option('-n, --page-size <n>', 'Page size (max 100)', '20')
    .action(async (opts) => {
      const spinner = ora('Fetching audit logs…').start();
      try {
        // AuditQueryDto whitelist: action / resource / userId / username /
        // startTime / endTime (+ page / pageSize from PaginationDto). Any
        // other query field is rejected with 400 by forbidNonWhitelisted.
        const data = await get<{ data: AuditLog[]; total: number }>('/audit', {
          page: opts.page,
          pageSize: opts.pageSize,
          action: opts.action,
          resource: opts.resource,
          userId: opts.userId,
          username: opts.username,
          startTime: opts.startTime,
          endTime: opts.endTime,
        });
        spinner.stop();
        const rows: AuditLog[] = Array.isArray(data) ? data : (data.data ?? []);
        const total = Array.isArray(data) ? rows.length : (data.total ?? rows.length);
        const table = new Table({
          head: ['Time', 'User', 'Action', 'Resource', 'Resource ID', 'Result'],
          colWidths: [25, 16, 24, 14, 18, 10],
          style: { head: ['cyan'] },
        });
        for (const log of rows) {
          table.push([
            new Date(log.createdAt).toLocaleString(),
            log.username ?? (log.userId !== undefined ? `#${log.userId}` : '-'),
            log.action,
            log.resource ?? '-',
            log.resourceId?.slice(0, 16) ?? '-',
            resultColor(log.result),
          ]);
        }
        console.log(table.toString());
        console.log(chalk.gray(`Total: ${total}  page ${opts.page}`));
      } catch (e: unknown) {
        spinner.fail('Failed to list audit logs');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  return cmd;
}
