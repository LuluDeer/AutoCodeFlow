import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import { get, post, del } from '../client.js';
import { emitError, confirmDestructive } from '../ui.js';

interface Deployment {
  id: string;
  applicationId?: string;
  executorId?: string;
  status: string;
  runMode?: string;
}

function statusColor(s: string): string {
  if (s === 'running') return chalk.green(s);
  if (s === 'stopped') return chalk.gray(s);
  if (s === 'error' || s === 'failed') return chalk.red(s);
  if (s === 'deploying') return chalk.cyan(s);
  return chalk.yellow(s);
}

/**
 * acf deploy 组 —— 部署行的干预/查询面。
 *
 * 2026-10 开发人员实测的可发现性缺口：`acf deploy --help` 只有 upgrade/stop，
 * 被误读成"CLI 没有部署状态查询"；实际列表在 `acf app deployments`。修复：
 * ① deploy 组补 `list`（与 app deployments 同源——同一个 GET /app-deployments
 * 契约，改动需两边同步）；② 组描述里交叉引用。
 */
export function deployCommand(): Command {
  const cmd = new Command('deploy').description(
    'Manage application deployments (upgrade / stop / list / remove records). List all deployments with: acf deploy list (same data as acf app deployments)',
  );

  // acf deploy list [appId] —— 与 apps.ts 的 `app deployments` 同源同契约。
  cmd.command('list [appId]')
    .description('List deployments (optionally filtered by application) — same data as: acf app deployments')
    .option('-p, --page <n>', 'Page number', '1')
    .option('-n, --page-size <n>', 'Page size', '20')
    // --json 补面（UX 统一）：列表/信封形态 → 单行紧凑 JSON
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (appId, opts: { page?: string; pageSize?: string; json?: boolean }) => {
      const spinner = ora('Fetching deployments…').start();
      try {
        // app-deployment.service.findAll returns `{ data, total }`
        const data = await get<{ data?: Deployment[]; list?: Deployment[]; total?: number }>('/app-deployments', {
          ...(appId ? { applicationId: appId } : {}),
          page: opts.page,
          pageSize: opts.pageSize,
        });
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(data));
          return;
        }
        const list: Deployment[] = Array.isArray(data) ? data : (data.data ?? data.list ?? []);
        const table = new Table({
          head: ['Deployment', 'App', 'Executor', 'Status', 'RunMode'],
          colWidths: [14, 14, 14, 12, 11],
          style: { head: ['cyan'] },
        });
        for (const d of list) {
          table.push([
            d.id.slice(0, 12),
            d.applicationId?.slice(0, 12) ?? '-',
            d.executorId?.slice(0, 12) ?? '-',
            statusColor(d.status),
            d.runMode ?? '-',
          ]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        emitError('Failed to list deployments', e, { spinner });
      }
    });

  // acf deploy upgrade <deploymentId>
  cmd.command('upgrade <deploymentId>')
    .description('Trigger an overlay upgrade for a running deployment (pulls the latest application version)')
    .action(async (deploymentId) => {
      const spinner = ora('Triggering upgrade…').start();
      try {
        // POST /app-deployments/:id/upgrade — AppDeploymentController.upgrade
        const dep = await post<Deployment>(`/app-deployments/${deploymentId}/upgrade`);
        spinner.succeed(`Upgrade triggered for deployment ${deploymentId}`);
        console.log(chalk.gray(`  status: ${dep?.status ?? '-'}  executor: ${dep?.executorId ?? '-'}`));
      } catch (e: unknown) {
        emitError('Failed to trigger upgrade', e, { spinner });
      }
    });

  // acf deploy stop <deploymentId>
  cmd.command('stop <deploymentId>')
    .description('Stop a running deployment')
    .action(async (deploymentId) => {
      const spinner = ora('Stopping deployment…').start();
      try {
        // POST /app-deployments/:id/stop — AppDeploymentController.stop
        const dep = await post<Deployment>(`/app-deployments/${deploymentId}/stop`);
        spinner.succeed(`Deployment ${deploymentId} stopped`);
        console.log(chalk.gray(`  status: ${dep?.status ?? '-'}`));
      } catch (e: unknown) {
        emitError('Failed to stop deployment', e, { spinner });
      }
    });

  // acf deploy remove <deploymentId> —— DELETE /app-deployments/:id
  //
  // 2026-10 开发人员遗留噪音：一条 stopped + daemon 的旧部署记录无法删除
  //（CLI 只有 stop）。服务端早已提供 DELETE /app-deployments/:id（仅终态行
  // FAILED/STOPPED，在途/运行/待审批 409 并说明正确出口），CLI 补齐此面。
  cmd.command('remove <deploymentId>')
    .description(
      'Delete a FINISHED deployment record (failed/stopped only). In-flight, running and pending-approval rows are refused with 409 — stop a running one first, use approval reject/cancel for a pending one',
    )
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .action(async (deploymentId, opts) => {
      // P0（CLI-AGENT-UX-AUDIT）：非交互 stdin 下必须显式拒绝，不能静默假绿。
      if (
        !(await confirmDestructive(
          `Delete deployment record ${deploymentId}? (terminal rows only: failed/stopped)`,
          { yes: opts.yes },
        ))
      ) {
        return;
      }
      const spinner = ora('Deleting deployment record…').start();
      try {
        // DELETE /app-deployments/:id — AppDeploymentController.remove
        const r = await del<{ ok: boolean; deletedId: string }>(`/app-deployments/${deploymentId}`);
        spinner.succeed(`Deployment record ${r?.deletedId ?? deploymentId} removed`);
      } catch (e: unknown) {
        emitError('Failed to remove deployment record', e, { spinner });
      }
    });

  return cmd;
}
