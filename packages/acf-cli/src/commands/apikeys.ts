import { Command, InvalidArgumentError } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import { get, post, del } from '../client.js';
import { emitError, emitUsageError } from '../ui.js';

/**
 * AUTH-03 限权 API Key（CI/CD 机器凭证）。服务端只存 SHA-256 哈希，
 * 明文（acf_<64 hex>）仅在创建响应里一次性回显——create 的输出把这一点
 * 讲清楚是这个命令最重要的职责。/api-keys 是 JWT-only 面（API Key 不能
 * 管理 API Key），所以这里总是以用户 JWT 调用。
 */
interface ApiKey {
  id: number;
  name: string;
  keyPrefix: string;
  scope: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
  lastUsedAt?: string | null;
  createdAt?: string;
}

// scope 三级矩阵（api-reference.md「API Keys」节）：readonly 读 / trigger
// 读+触发 / manage 全量。本地预检只为报错快一点，服务端 IsIn 仍是权威。
const SCOPES = ['readonly', 'trigger', 'manage'] as const;

export function apikeysCommand(): Command {
  const cmd = new Command('apikey')
    .description('Manage API keys (limited-scope machine credentials for CI/CD)');

  cmd.command('create')
    .description('Create an API key — the plaintext (acf_…) is echoed exactly once and can never be retrieved again')
    .requiredOption('--name <name>', 'Key name (1-100 chars)')
    .requiredOption('--scope <scope>', 'Scope: readonly | trigger | manage')
    .option(
      '--expires <days>',
      'Expires in N days (1-3650; default: never expires)',
      (v: string) => {
        const n = Number.parseInt(v, 10);
        if (!Number.isInteger(n) || n < 1 || n > 3650) {
          throw new InvalidArgumentError('must be an integer between 1 and 3650 (days)');
        }
        return n;
      },
    )
    .option('--json', 'Emit raw JSON (CI-consumable; includes the one-time plaintext)')
    .action(async (opts: { name: string; scope: string; expires?: number; json?: boolean }) => {
      if (!(SCOPES as readonly string[]).includes(opts.scope)) {
        emitUsageError(`Unknown scope "${opts.scope}" — expected one of: ${SCOPES.join(' | ')}`);
      }
      const spinner = ora('Creating API key…').start();
      try {
        // CreateApiKeyDto 白名单：{ name, scope, expiresInDays? }。不发送
        // undefined 键（forbidNonWhitelisted 下未知/空键没有意义）。
        const body: Record<string, unknown> = { name: opts.name, scope: opts.scope };
        if (opts.expires !== undefined) body.expiresInDays = opts.expires;
        const key = await post<ApiKey & { plaintext: string }>('/api-keys', body);
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(key));
          return;
        }
        console.log(chalk.green(`✔ API key created: ${key.name} (id: ${key.id})`));
        console.log('  Prefix    :', key.keyPrefix);
        console.log('  Scope     :', key.scope);
        console.log('  Plaintext :', chalk.bold(key.plaintext));
        console.log(
          chalk.yellow(
            '  ⚠ The plaintext is shown only once — store it now (CI secret store / env file). It cannot be retrieved or re-displayed later.',
          ),
        );
      } catch (e: unknown) {
        emitError('Failed to create API key', e, { spinner });
      }
    });

  cmd.command('list')
    .description('List your API keys (masked view — plaintext is never returned by the API)')
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (opts: { json?: boolean }) => {
      const spinner = ora('Fetching API keys…').start();
      try {
        const keys = await get<ApiKey[]>('/api-keys');
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(keys ?? []));
          return;
        }
        const table = new Table({
          head: ['ID', 'Name', 'Prefix', 'Scope', 'Expires', 'Status', 'Last used'],
          colWidths: [6, 26, 14, 10, 22, 10, 22],
          style: { head: ['cyan'] },
        });
        for (const k of keys ?? []) {
          table.push([
            String(k.id),
            k.name,
            k.keyPrefix,
            k.scope,
            k.expiresAt ? new Date(k.expiresAt).toLocaleString() : 'never',
            k.revokedAt ? chalk.red('revoked') : chalk.green('active'),
            k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : '-',
          ]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        emitError('Failed to list API keys', e, { spinner });
      }
    });

  cmd.command('revoke <id>')
    .description('Revoke an API key (soft-delete — takes effect on its next request, cannot be undone)')
    .action(async (id: string) => {
      // 服务端 ParseIntPipe：id 是数字主键（acf apikey list 查看）。
      if (!/^\d+$/.test(id)) {
        emitUsageError(`API key id must be a number (got "${id}") — find ids with: acf apikey list`);
      }
      const spinner = ora('Revoking API key…').start();
      try {
        // DELETE /api-keys/:id（REST 主语义；POST /:id/revoke 是幂等别名端点）。
        await del<{ success: boolean }>(`/api-keys/${id}`);
        spinner.succeed(`API key ${id} revoked`);
      } catch (e: unknown) {
        emitError('Failed to revoke API key', e, { spinner });
      }
    });

  return cmd;
}
