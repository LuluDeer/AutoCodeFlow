import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import { get, post } from '../client.js';
import { emitError, confirmDestructive } from '../ui.js';

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
  /**
   * R68：**已占槽位**（含 E-01 pull 取件预留；R16 起还被抬到「客户端上报 vs 服务端
   * 在途占坑」的较大值），也是服务端派发闸门读的数。它**不是**「在跑任务数」：
   * 空闲 pull 执行器在长轮询窗口内同样占 1 个槽位。
   */
  runningTaskCount?: number;
  /**
   * E-01-RPT：已预留但尚未领取的槽位。上游返回整行实体
   * （`executor.service.ts::findAll/findOne` 无 select 收窄），故 CLI **拿得到**该列。
   * null/undefined = 旧版执行器未上报 ⇒ 无从换算「实际在跑 = 已占 − 预留」。
   */
  reservedSlots?: number | null;
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

/**
 * R68：**实际在跑** = 已占槽位 − 取件预留（下限钳 0）。
 *
 * 与 admin-web 的 `utils/executor-metrics.ts::resolveRunningCount` 同一口径（那边是
 * TS 常量，这里是 CLI 的独立副本——两个包不共享代码，故各自实现并用测试钉住）。
 * `reservedSlots` 缺失/null（旧版执行器未上报）⇒ **返回 null 表示「无从换算」**，
 * 调用方必须回落「只显示已占槽位」，**不得**谎称在跑任务数。
 */
function actualRunningCount(e: Executor): number | null {
  if (e.reservedSlots === null || e.reservedSlots === undefined) return null;
  const occupied = Number.isFinite(e.runningTaskCount) ? Math.max(e.runningTaskCount ?? 0, 0) : 0;
  const reserved = Number.isFinite(e.reservedSlots) ? Math.max(e.reservedSlots, 0) : 0;
  return Math.max(occupied - reserved, 0);
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
          // R68：列头旧称「Running」，会被读成「在跑任务数」；本表是**机群概览**
          // （容量视角，同部署下拉/仪表盘热力条）⇒ 如实叫「Occupied」（已占槽位）。
          head: ['ID', 'App Name', 'Status', 'Address', 'Last Heartbeat', 'CPU', 'Occupied'],
          colWidths: [14, 20, 10, 22, 18, 8, 10],
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
        emitError('Failed to list executors', e, { spinner });
      }
    });

  // acf executor get <id>
  cmd.command('get <id>')
    .description('Show details of a single executor (config, status, metrics)')
    // --json 补面（本轮 UX 统一）：单对象形态 → pretty JSON
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (id, opts: { json?: boolean }) => {
      const spinner = ora('Fetching executor…').start();
      try {
        const e = await get<Executor>(`/executors/${id}`);
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(e, null, 2));
          return;
        }
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
        // R68：旧实现把「已占槽位」标成「Running Tasks」——空闲 pull 执行器会显示
        // 「Running Tasks : 1」而机器上没有任何任务在跑（admin-web 同类谎报见
        // R62/R64/R67）。现在：
        //   · 有 reservedSlots ⇒ 显示**实际在跑**（已占 − 预留，下限 0）；
        //   · 无 reservedSlots（旧版执行器）⇒ **无从换算** ⇒ 只显示已占槽位，
        //     绝不谎称在跑任务数。
        const runningCount = actualRunningCount(e);
        if (runningCount !== null) {
          console.log('  Running Tasks     :', runningCount);
        }
        console.log('  Occupied Slots    :', e.runningTaskCount ?? 0);
        console.log('  Running Executions:', runningExecutionIdsText(e.runningExecutionIds));
        console.log('  Max Concurrent    :', e.maxConcurrentTasks ?? '-');
        console.log('  Total Tasks       :', e.totalTaskCount ?? 0);
        console.log('  Failed Tasks      :', e.failedTaskCount ?? 0);
        console.log('  CPU               :', pct(e.cpuUsage));
        console.log('  Memory            :', pct(e.memUsage));
        console.log('  Last Heartbeat    :', e.lastHeartbeat ? `${new Date(e.lastHeartbeat).toLocaleString()} (${heartbeatAge(e.lastHeartbeat)})` : '-');
      } catch (e: unknown) {
        emitError('Failed to fetch executor', e, { spinner });
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
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .action(async (nameOrId: string, opts: { reason?: string; yes?: boolean }) => {
      // P1（CLI-AGENT-UX-AUDIT）：轮换是**不可逆**的——旧 token 立即失效，
      // 而新 token 只在本命令输出里出现一次，没被捕获就永久丢失（只能再轮换）。
      // 此前零确认。补确认，并复用统一的非交互语义（非 TTY 缺 --yes → 码 2）。
      if (
        !(await confirmDestructive(
          `Rotate the token for "${nameOrId}"? The old token stops working immediately and the new one is shown only once.`,
          { yes: opts.yes },
        ))
      ) {
        return;
      }
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
        emitError('Failed to rotate token', e, { spinner });
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
        emitError('Failed to mark executor offline', e, { spinner });
      }
    });

  return cmd;
}
