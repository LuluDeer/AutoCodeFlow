import { Command, InvalidArgumentError } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import { get, post, put, del } from '../client.js';
import { emitError, emitUsageError, confirmDestructive } from '../ui.js';

/**
 * MUTEX-01（应用互斥组）：组配置的读+管理面。
 *
 * 背景：后端 `mutex-groups` 4 端点（GET/POST/PUT/DELETE）自 MUTEX-01 起就存在，
 * 中台（admin-web 的应用表单下拉 + 组管理页）一直在用，但 CLI 此前**一条都没接**：
 *   · `acf app update --body '{"mutexGroupId":"…"}'` 其实能挂组（--body 是纯透传），
 *     可 `--help` 的 Accepted fields 里没写，等于「能用但没人知道」；
 *   · 「有哪些组可选」在 CLI 侧完全不可见，用户只能去中台抄 uuid。
 * 本命令组补齐这两件事：list 提供可选项（含 uuid 与挂载应用数），
 * create/update/delete 提供完整的组生命周期。
 *
 * 权限面（与后端 @Roles 一致）：GET 任意登录用户可读；写面（POST/PUT/DELETE）
 * 服务端要求 ADMIN，CLI 不预检角色——403 由 emitError 如实透出（退出码 1），
 * 与 project/apikey 等命令组同口径：权限是服务端决定，客户端不重复判定。
 */

/** 与后端 MutexGroupResponseDto 对齐（读面）。 */
interface MutexGroup {
  id: string;
  name: string;
  maxConcurrentPerDevice: number;
  scope: 'device' | 'global';
  description: string | null;
  /** 当前挂在该组上的应用数（list 面提供；create/update 响应可能缺省）。 */
  applicationCount?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 组作用域（后端 MUTEX_GROUP_SCOPES 的镜像）。本地预检只为报错快一点，
 * 服务端 @IsIn 仍是权威；与 apikeys.ts 的 SCOPES 同一纪律。
 */
const SCOPES = ['device', 'global'] as const;

/** 组内并发上界（后端 MUTEX_GROUP_MAX_CONCURRENT_CEILING 的镜像）。 */
const MAX_CONCURRENT_CEILING = 100;

/** `--scope` 解析：非法值在 commander 层就报错（退出码 2），不发请求。 */
function parseScope(v: string): string {
  if (!(SCOPES as readonly string[]).includes(v)) {
    throw new InvalidArgumentError(`must be one of: ${SCOPES.join(' | ')}`);
  }
  return v;
}

/** `--max-concurrent` 解析：1..100 的整数（与后端 @Min/@Max 同界）。 */
function parseMaxConcurrent(v: string): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENT_CEILING) {
    throw new InvalidArgumentError(
      `must be an integer between 1 and ${MAX_CONCURRENT_CEILING}`,
    );
  }
  return n;
}

/**
 * scope 的人类可读注解。两种作用域的语义差别很大（一个管单机串行、一个管
 * 全平台单点登录顶号），只打 "device"/"global" 用户看不懂，故列表里带注解。
 */
function scopeText(scope: string): string {
  if (scope === 'global') return chalk.yellow('global') + chalk.gray(' (全平台串行)');
  if (scope === 'device') return chalk.cyan('device') + chalk.gray(' (单机串行)');
  return scope;
}

export function mutexCommand(): Command {
  const cmd = new Command('mutex').description(
    'Manage application mutex groups (apps in one group never run concurrently on the same device)',
  );

  // acf mutex list
  cmd
    .command('list')
    .description('List mutex groups (the same options the console shows in the app form dropdown)')
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (opts: { json?: boolean }) => {
      const spinner = ora('Fetching mutex groups…').start();
      try {
        const groups = await get<MutexGroup[]>('/mutex-groups');
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(groups ?? []));
          return;
        }
        if (!groups?.length) {
          console.log(chalk.gray('No mutex groups yet.'));
          console.log(
            chalk.gray("Create one with: acf mutex create --name <name>"),
          );
          return;
        }
        const table = new Table({
          head: ['ID', 'Name', 'Max/Device', 'Scope', 'Apps', 'Description'],
          colWidths: [38, 22, 12, 26, 6, 30],
          style: { head: ['cyan'] },
        });
        for (const g of groups) {
          table.push([
            g.id,
            g.name,
            String(g.maxConcurrentPerDevice),
            scopeText(g.scope),
            g.applicationCount === undefined ? '-' : String(g.applicationCount),
            g.description ?? '-',
          ]);
        }
        console.log(table.toString());
        console.log(
          chalk.gray(
            'Attach an app with: acf app update <appId> --body \'{"mutexGroupId":"<ID>"}\'',
          ),
        );
      } catch (e: unknown) {
        emitError('Failed to list mutex groups', e, { spinner });
      }
    });

  // acf mutex create
  cmd
    .command('create')
    .description('Create a mutex group (ADMIN)')
    .requiredOption('--name <name>', 'Group name (unique, max 64 chars)')
    .option(
      '--max-concurrent <n>',
      `Concurrent runs allowed per device (1-${MAX_CONCURRENT_CEILING}, default 1 = serial)`,
      parseMaxConcurrent,
    )
    .option(
      '--scope <scope>',
      'device = serial per device, cross-device concurrent (default) | global = serial platform-wide (e.g. single-sign-on takeover)',
      parseScope,
    )
    .option('--description <text>', 'What the group is for (max 500 chars)')
    .option('--json', 'Emit raw JSON (CI-consumable)')
    .action(
      async (opts: {
        name: string;
        maxConcurrent?: number;
        scope?: string;
        description?: string;
        json?: boolean;
      }) => {
        const spinner = ora('Creating mutex group…').start();
        try {
          // CreateMutexGroupDto 白名单：{ name, maxConcurrentPerDevice?, scope?, description? }。
          // 不发送 undefined 键（forbidNonWhitelisted 下无意义）。
          const body: Record<string, unknown> = { name: opts.name };
          if (opts.maxConcurrent !== undefined) {
            body.maxConcurrentPerDevice = opts.maxConcurrent;
          }
          if (opts.scope !== undefined) body.scope = opts.scope;
          if (opts.description !== undefined) body.description = opts.description;
          const group = await post<MutexGroup>('/mutex-groups', body);
          spinner.stop();
          if (opts.json) {
            console.log(JSON.stringify(group));
            return;
          }
          console.log(chalk.green(`✔ Mutex group created: ${group.name}`));
          console.log('  ID           :', group.id);
          console.log('  Max/Device   :', group.maxConcurrentPerDevice);
          console.log('  Scope        :', group.scope);
          console.log(
            chalk.gray(
              `  Attach an app: acf app update <appId> --body '{"mutexGroupId":"${group.id}"}'`,
            ),
          );
        } catch (e: unknown) {
          emitError('Failed to create mutex group', e, { spinner });
        }
      },
    );

  // acf mutex update <id>
  cmd
    .command('update <id>')
    .description('Update a mutex group (name / max-concurrent / scope / description; ADMIN)')
    .option('--name <name>', 'New group name (unique, max 64 chars)')
    .option(
      '--max-concurrent <n>',
      `New per-device concurrency (1-${MAX_CONCURRENT_CEILING})`,
      parseMaxConcurrent,
    )
    .option('--scope <scope>', 'New scope: device | global', parseScope)
    .option('--description <text>', 'New description (max 500 chars)')
    .option('--json', 'Emit raw JSON (CI-consumable)')
    .action(
      async (
        id: string,
        opts: {
          name?: string;
          maxConcurrent?: number;
          scope?: string;
          description?: string;
          json?: boolean;
        },
      ) => {
        // 空 patch（一个字段都没给）在服务端的语义是「什么都不改」却仍算成功，
        // 容易被误读为「已生效」。本地拦下并给出可操作提示（退出码 2）。
        if (
          opts.name === undefined &&
          opts.maxConcurrent === undefined &&
          opts.scope === undefined &&
          opts.description === undefined
        ) {
          emitUsageError(
            'Nothing to update — pass at least one of: --name, --max-concurrent, --scope, --description',
          );
        }
        const spinner = ora('Updating mutex group…').start();
        try {
          const body: Record<string, unknown> = {};
          if (opts.name !== undefined) body.name = opts.name;
          if (opts.maxConcurrent !== undefined) {
            body.maxConcurrentPerDevice = opts.maxConcurrent;
          }
          if (opts.scope !== undefined) body.scope = opts.scope;
          if (opts.description !== undefined) body.description = opts.description;
          const group = await put<MutexGroup>(`/mutex-groups/${id}`, body);
          spinner.stop();
          if (opts.json) {
            console.log(JSON.stringify(group));
            return;
          }
          console.log(chalk.green(`✔ Mutex group updated: ${group.name}`));
          console.log('  ID           :', group.id);
          console.log('  Max/Device   :', group.maxConcurrentPerDevice);
          console.log('  Scope        :', group.scope);
        } catch (e: unknown) {
          emitError('Failed to update mutex group', e, { spinner });
        }
      },
    );

  // acf mutex delete <id>
  cmd
    .command('delete <id>')
    .description(
      'Delete a mutex group (ADMIN) — attached apps become ungrouped; refuses with 409 while apps are still attached unless --force',
    )
    .option(
      '-f, --force',
      'Delete even when apps are still attached (they silently lose the constraint)',
      false,
    )
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .action(async (id: string, opts: { force?: boolean; yes?: boolean }) => {
      // 破坏性动作：先要交互确认（非 TTY 且无 --yes 时由 confirmDestructive
      // 以退出码 2 拒绝，不会静默假绿）。
      const warning = opts.force
        ? `Delete mutex group ${id}? Attached apps will lose the mutual-exclusion constraint (--force given).`
        : `Delete mutex group ${id}?`;
      const proceed = await confirmDestructive(warning, { yes: opts.yes });
      if (!proceed) return;

      const spinner = ora('Deleting mutex group…').start();
      try {
        // 服务端：组上仍挂应用时返回 409，需显式 force=true 才放行。
        // 查询串交给 del() 的 params（不在路径字面量里拼 `?`）——见 client.ts
        // 的 del() 注释：手工拼串会让 consumer-routes 守卫无法静态解析该路由。
        await del<{ ok: true }>(
          `/mutex-groups/${id}`,
          opts.force ? { force: 'true' } : undefined,
        );
        spinner.succeed(`Mutex group ${id} deleted`);
      } catch (e: unknown) {
        emitError('Failed to delete mutex group', e, { spinner });
      }
    });

  return cmd;
}
