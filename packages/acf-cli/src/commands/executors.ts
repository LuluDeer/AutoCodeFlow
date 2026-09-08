import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import { get, post, formatApiError } from '../client';

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
  // CONSISTENCY-02: executionIds the executor reported on its last
  // heartbeat. Same tri-state as admin-web's ExecutorDetailPage:
  // null/undefined = older executor that never reports it, [] = online and
  // idle, non-empty = those executions are currently running.
  runningExecutionIds?: string[] | null;
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

// CONSISTENCY-02 (U11): tri-state rendering matching admin-web's
// ExecutorDetailPage semantics for the heartbeat-reported id list.
function runningExecutionIdsText(ids?: string[] | null): string {
  if (ids === null || ids === undefined) {
    return chalk.gray('not reported (older executor)');
  }
  if (ids.length === 0) {
    return chalk.gray('idle (none running)');
  }
  return `${ids.length} running: ${ids.join(', ')}`;
}

export function executorsCommand(): Command {
  const cmd = new Command('executor').description('View registered executors');

  cmd.command('list')
    .description('List all executors and their status')
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (opts) => {
      const spinner = ora('Fetching executors…').start();
      try {
        const data = await get<Executor[] | { list: Executor[] }>('/executors');
        spinner.stop();
        if (opts.json) {
          // ECO-02: --json —— CI/脚本消费面
          console.log(JSON.stringify(Array.isArray(data) ? data : data.list ?? []));
          return;
        }
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
        console.log('  Running Executions:', runningExecutionIdsText(e.runningExecutionIds));
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

  // NF-07: name|id resolution — rotate/offline/set-offline are ADMIN-only
  // id-scoped routes; accepting the appName keeps the UX aligned with
  // `executor list` where the short id is what operators see.
  async function resolveExecutorId(nameOrId: string): Promise<string> {
    let exec: Executor | undefined;
    try {
      exec = await get<Executor>(`/executors/${nameOrId}`);
    } catch {
      exec = undefined;
    }
    if (exec?.id) return exec.id;
    const data = await get<Executor[] | { list: Executor[] }>('/executors');
    const executors: Executor[] = Array.isArray(data) ? data : (data.list ?? []);
    const byName = executors.find((e) => e.appName === nameOrId);
    const byShortId = executors.find((e) => e.id.startsWith(nameOrId));
    const found = byName ?? byShortId;
    if (!found?.id) {
      throw new Error(`Executor "${nameOrId}" not found (no id match, no appName match, no short-id match)`);
    }
    return found.id;
  }

  // acf executor rotate <name|id> [--reason "..."]
  cmd.command('rotate <nameOrId>')
    .description('Rotate an executor token (ADMIN; new token is shown ONCE in this output)')
    .option('--reason <reason>', 'Optional rotation reason (≤200 chars, recorded in the audit log)')
    .action(async (nameOrId: string, opts: { reason?: string }) => {
      const spinner = ora('Rotating executor token…').start();
      try {
        const id = await resolveExecutorId(nameOrId);
        // POST /executors/:id/rotate-token — ExecutorController.rotateToken
        // (ADMIN-only). Returns { token } — the plaintext is persisted nowhere
        // and never shown again (AUTH-05: optional reason goes to the audit).
        const r = await post<{ token: string }>(
          `/executors/${id}/rotate-token`,
          opts.reason ? { reason: opts.reason } : undefined,
        );
        spinner.succeed(`Token rotated for executor ${id}`);
        console.log(chalk.bold('New token (shown only once — store it now):'));
        console.log(chalk.green(r?.token ?? ''));
      } catch (e: unknown) {
        spinner.fail('Failed to rotate token');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf executor offline <name|id>
  cmd.command('offline <nameOrId>')
    .description('Mark an executor offline (ADMIN; does not interrupt running tasks — for stale records after a crash)')
    .action(async (nameOrId: string) => {
      const spinner = ora('Marking executor offline…').start();
      try {
        const id = await resolveExecutorId(nameOrId);
        // POST /executors/:id/set-offline — ExecutorController.setOffline
        // (ADMIN-only; distinct from the @Public /executors/offline
        // executor-shutdown callback which is not an admin surface).
        const e = await post<Executor>(`/executors/${id}/set-offline`);
        spinner.succeed(`Executor ${id} marked offline`);
        console.log(chalk.gray(`  status: ${e?.status ?? 'offline'}  address: ${e?.address ?? '-'}`));
      } catch (e: unknown) {
        spinner.fail('Failed to mark executor offline');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  return cmd;
}
