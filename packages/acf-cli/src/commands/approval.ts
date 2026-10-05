import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import { get, post } from '../client.js';
import { emitError, emitUsageError } from '../ui.js';

/**
 * P3: DEP-04 部署审批流（第二人规则在服务端强制：审批者 ≠ 提交者
 * approvalMeta.requestedBy，违反 403；提交者撤回自己的请求走 cancel）。
 *
 * 端点（api-reference.md「App Deployments」节，MCP 侧 list_pending_approvals /
 * approve_deployment / reject_deployment / cancel_deployment 同一套）：
 * - GET  /app-deployments/approvals/pending        —— ADMIN 待办队列（等价
 *   GET /app-deployments?approvalStatus=pending_approval）
 * - GET  /app-deployments?approvalStatus=…         —— 终态过滤
 *   （approved/rejected/cancelled；pending_approval 是审批前冻结态）
 * - POST /app-deployments/:id/approval/approve|reject —— body 可选 { reason ≤200 }
 *   （CLI 的 --note 映射为契约字段 reason）
 * - POST /app-deployments/:id/approval/cancel      —— 无 body
 *
 * 状态机：pending_approval → approved（推送链启动）/ rejected（FAILED 终态）/
 * cancelled（FAILED 终态）；三动作均为原子认领，并发双审批仅首者生效（409）。
 */

interface ApprovalDeployment {
  id: string;
  applicationId?: string;
  executorId?: string;
  status: string;
  runMode?: string;
  deployedVersion?: string | null;
  approvalStatus?: string | null;
  approvalMeta?: { requestedBy?: string | number | null } | null;
  statusMessage?: string | null;
  createdAt?: string;
}

const LIST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

function statusColor(s: string): string {
  if (s === 'running') return chalk.green(s);
  if (s === 'failed' || s === 'stopped') return chalk.red(s);
  if (s === 'deploying') return chalk.cyan(s);
  return chalk.yellow(s);
}

export function approvalCommand(): Command {
  const cmd = new Command('approval')
    .description('DEP-04 deployment approvals (second-person rule enforced server-side; ADMIN only)');

  // acf approval list
  cmd.command('list')
    .description(
      'List deployments in the approval workflow. Default (--status pending) hits the dedicated ADMIN queue; approved/rejected/cancelled filter the generic deployment list',
    )
    .option('-s, --status <status>', 'pending (default) | approved | rejected | cancelled', 'pending')
    .option('-a, --application <appId>', 'Filter by application ID')
    .option('-p, --page <n>', 'Page number', '1')
    .option('-n, --page-size <n>', 'Page size (max 100)', '20')
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(
      async (opts: { status: string; application?: string; page: string; pageSize: string; json?: boolean }) => {
        if (!(LIST_STATUSES as readonly string[]).includes(opts.status)) {
          emitUsageError(`Unknown approval status "${opts.status}" — expected one of: ${LIST_STATUSES.join(' | ')}`);
        }
        const spinner = ora('Fetching approvals…').start();
        try {
          const query = {
            page: opts.page,
            pageSize: opts.pageSize,
            ...(opts.application ? { applicationId: opts.application } : {}),
          };
          // pending 走专用 ADMIN 队列端点；终态走通用列表的 approvalStatus 过滤
          //（契约两端口径，服务端同一 findAll 实现，均返回 { data, total }）。
          const data = await get<{ data?: ApprovalDeployment[]; total?: number }>(
            opts.status === 'pending' ? '/app-deployments/approvals/pending' : '/app-deployments',
            opts.status === 'pending' ? query : { ...query, approvalStatus: opts.status },
          );
          spinner.stop();
          if (opts.json) {
            // ECO-02：列表/信封形态 → 单行紧凑 JSON
            console.log(JSON.stringify(data));
            return;
          }
          const list: ApprovalDeployment[] = Array.isArray(data) ? data : (data.data ?? []);
          const table = new Table({
            head: ['Deployment', 'App', 'Executor', 'Status', 'Version', 'Requested by'],
            colWidths: [14, 14, 14, 16, 10, 14],
            style: { head: ['cyan'] },
          });
          for (const d of list) {
            table.push([
              d.id.slice(0, 12),
              d.applicationId?.slice(0, 12) ?? '-',
              d.executorId?.slice(0, 12) ?? '-',
              statusColor(d.status),
              d.deployedVersion ?? '-',
              String(d.approvalMeta?.requestedBy ?? '-'),
            ]);
          }
          console.log(table.toString());
        } catch (e: unknown) {
          emitError('Failed to list approvals', e, { spinner });
        }
      },
    );

  // acf approval approve <id>
  cmd.command('approve <id>')
    .description(
      'Approve a pending deployment (ADMIN). Second-person rule: the approver must differ from the requester (403 otherwise) — to withdraw your own request use: acf approval cancel. On success the deployment is dispatched to the executor',
    )
    .option('--note <text>', 'Decision reason (max 200 chars), recorded in approvalMeta and the audit log')
    .action(async (id: string, opts: { note?: string }) => {
      if (opts.note && opts.note.length > 200) {
        emitUsageError(
          `--note is limited to 200 characters (got ${opts.note.length}) — the server enforces the same cap on the approval reason`,
        );
      }
      const spinner = ora('Approving deployment…').start();
      try {
        // ApprovalActionDto 白名单：{ reason? }（≤200）。未给 note 时不发 body。
        const dep = await post<ApprovalDeployment>(
          `/app-deployments/${id}/approval/approve`,
          opts.note ? { reason: opts.note } : undefined,
        );
        spinner.succeed('Deployment approved — dispatching to the executor');
        console.log(
          chalk.gray(
            `  deployment: ${dep?.id ?? id}  status: ${dep?.status ?? '-'}  approval: ${dep?.approvalStatus ?? '-'}`,
          ),
        );
      } catch (e: unknown) {
        emitError('Failed to approve deployment', e, { spinner });
      }
    });

  // acf approval reject <id>
  cmd.command('reject <id>')
    .description(
      'Reject a pending deployment (ADMIN). Nothing is ever dispatched — the row lands in a FAILED terminal state. Second-person rule applies; the reason lands in approvalMeta/statusMessage and the audit log',
    )
    .option('--note <text>', 'Decision reason (max 200 chars), recorded in approvalMeta and the audit log')
    .action(async (id: string, opts: { note?: string }) => {
      if (opts.note && opts.note.length > 200) {
        emitUsageError(
          `--note is limited to 200 characters (got ${opts.note.length}) — the server enforces the same cap on the approval reason`,
        );
      }
      const spinner = ora('Rejecting deployment…').start();
      try {
        const dep = await post<ApprovalDeployment>(
          `/app-deployments/${id}/approval/reject`,
          opts.note ? { reason: opts.note } : undefined,
        );
        spinner.succeed('Deployment rejected — nothing will be dispatched (row lands FAILED)');
        console.log(
          chalk.gray(
            `  deployment: ${dep?.id ?? id}  status: ${dep?.status ?? '-'}  approval: ${dep?.approvalStatus ?? '-'}`,
          ),
        );
      } catch (e: unknown) {
        emitError('Failed to reject deployment', e, { spinner });
      }
    });

  // acf approval cancel <id>
  cmd.command('cancel <id>')
    .description(
      'Withdraw your own pending deployment request (requester-only — other admins who want to veto should use: acf approval reject)',
    )
    .action(async (id: string) => {
      const spinner = ora('Cancelling pending request…').start();
      try {
        const dep = await post<ApprovalDeployment>(`/app-deployments/${id}/approval/cancel`);
        spinner.succeed('Pending deployment request cancelled (row lands FAILED)');
        console.log(
          chalk.gray(
            `  deployment: ${dep?.id ?? id}  status: ${dep?.status ?? '-'}  approval: ${dep?.approvalStatus ?? '-'}`,
          ),
        );
      } catch (e: unknown) {
        emitError('Failed to cancel deployment', e, { spinner });
      }
    });

  return cmd;
}
