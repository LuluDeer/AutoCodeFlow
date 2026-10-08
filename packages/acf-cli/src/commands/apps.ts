import { Command, InvalidArgumentError } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'path';
import { get, post, put, del, ANALYZE_TIMEOUT_MS, UPLOAD_TIMEOUT_MS } from '../client.js';
import { emitError, emitUsageError, UsageError, confirmDestructive } from '../ui.js';

interface Application {
  id: string;
  name: string;
  status: string;
  version?: string;
  runtime?: string;
  gitRepo?: string;
  gitBranch?: string;
  gitCommit?: string;
  description?: string;
  entrypoint?: string;
  packageUrl?: string;
}

interface Deployment {
  id: string;
  applicationId: string;
  executorId?: string;
  status: string;
  runMode?: string;
}

/**
 * P2：POST /applications/:id/upgrade-all 响应（app-deployment.service
 * .upgradeAllWithRollout）。all 模式恒 ok:true + succeeded/failed 计数；
 * canary 额外带 rollout 批次信息；ARCH-31 同应用在途批次互斥时
 * ok:false + rollout.blockedReason（业务拒绝，HTTP 仍是 2xx）。
 */
interface UpgradeAllResult {
  ok: boolean;
  total: number;
  succeeded: number;
  failed: number;
  rollout?: {
    batchId: string;
    strategy: string;
    canaryIds: string[];
    promotedIds: string[];
    blockedReason?: string;
  };
}

function statusColor(s: string): string {
  if (s === 'running') return chalk.green(s);
  if (s === 'stopped') return chalk.gray(s);
  if (s === 'error' || s === 'failed') return chalk.red(s);
  if (s === 'deploying') return chalk.cyan(s);
  return chalk.yellow(s);
}

/** Load a JSON payload from --file (preferred) or --json. */
async function loadJsonBody(json?: string, file?: string): Promise<unknown> {
  const fs = await import('fs/promises');
  // 本地 payload 层错误（文件读不了/JSON 坏）= 用法错误（退出码 2），与
  // 服务端拒绝（1）区分；tasks.ts 的 create/update 同口径。
  let raw: string;
  try {
    raw = file ? await fs.readFile(file, 'utf-8') : (json as string);
  } catch (err) {
    throw new UsageError(`Cannot read payload file: ${file} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (raw === undefined) {
    throw new UsageError('Missing JSON payload (provide --json or --file)');
  }
  try {
    return JSON.parse(raw);
  } catch (e: unknown) {
    throw new UsageError(`Invalid JSON payload: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function appsCommand(): Command {
  const cmd = new Command('app').description('Manage applications');

  // acf app list
  cmd.command('list')
    .description('List all applications')
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (opts) => {
      const spinner = ora('Fetching applications…').start();
      try {
        const data = await get<{ list: Application[]; total: number }>('/applications');
        spinner.stop();
        const apps: Application[] = Array.isArray(data) ? data : (data.list ?? []);
        if (opts.json) {
          // ECO-02: --json —— CI/脚本消费面
          console.log(JSON.stringify(apps));
          return;
        }
        const table = new Table({
          head: ['ID', 'Name', 'Status', 'Version', 'Git Repo', 'Branch'],
          colWidths: [14, 26, 12, 10, 28, 14],
          style: { head: ['cyan'] },
        });
        for (const a of apps) {
          table.push([
            a.id.slice(0, 12),
            a.name,
            statusColor(a.status),
            a.version ?? '-',
            a.gitRepo ?? '-',
            a.gitBranch ?? '-',
          ]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        emitError('Failed to list applications', e, { spinner });
      }
    });

  // acf app get <id>
  cmd.command('get <id>')
    .description('Show application details')
    // --json 补面（本轮 UX 统一）：单对象形态 → pretty JSON
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (id, opts: { json?: boolean }) => {
      const spinner = ora('Fetching application…').start();
      try {
        const a = await get<Application>(`/applications/${id}`);
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(a, null, 2));
          return;
        }
        console.log(chalk.bold('Application Details'));
        console.log('  ID          :', a.id);
        console.log('  Name        :', a.name);
        console.log('  Status      :', statusColor(a.status));
        console.log('  Version     :', a.version ?? '-');
        console.log('  Runtime     :', a.runtime ?? '-');
        console.log('  Git Repo    :', a.gitRepo ?? '-');
        console.log('  Git Branch  :', a.gitBranch ?? '-');
        console.log('  Git Commit  :', a.gitCommit ?? '-');
        console.log('  Entrypoint  :', a.entrypoint ?? '-');
        console.log('  Package URL :', a.packageUrl ?? '-');
        console.log('  Description :', a.description ?? '-');
      } catch (e: unknown) {
        emitError('Failed', e, { spinner });
      }
    });

  // acf app create
  // 2026-10-07 对齐 task create 的载荷旗标改名：--json <body> → --body。
  //（task 侧先改，app 侧本轮补齐——--json 在其余命令都是「输出 JSON」布尔
  // 旗标，载荷语义的 --json 是历史包袱，下一大版本收敛为布尔。）
  cmd.command('create')
    .description('Create an application (JSON payload via --body or --file; required: name, version, runtime)')
    .option('--body <json>', 'Application body as JSON string (required unless --file is given)')
    .option('--json <body>', 'DEPRECATED (renamed to --body): Application body as JSON string. In the next major version --json becomes a boolean output flag')
    .option('--file <path>', 'Read application body from a JSON file (overrides --body/--json)')
    .action(async (opts) => {
      if (opts.body !== undefined && opts.json !== undefined) {
        emitUsageError('--body and --json (deprecated alias) are mutually exclusive — pass only --body');
      }
      if (opts.body === undefined && opts.json === undefined && !opts.file) {
        emitUsageError('Missing required application body — pass --body <json> (or --file <path>)');
      }
      const spinner = ora('Creating application…').start();
      try {
        if (opts.json !== undefined) {
          process.stderr.write(
            chalk.yellow('⚠ --json <body> is deprecated and will be removed in the next major version (it will become a boolean output flag). Use --body <json> instead.\n'),
          );
        }
        const body = await loadJsonBody(opts.json ?? opts.body, opts.file);
        const a = await post<Application>('/applications', body);
        spinner.succeed(`Application created: ${a.id}`);
        console.log(chalk.gray(`  name: ${a.name}  version: ${a.version ?? '-'}  status: ${statusColor(a.status)}`));
      } catch (e: unknown) {
        emitError('Failed to create application', e, { spinner });
      }
    });

  // P2: acf app upload <zip> —— POST /applications/upload（multipart/form-data，
  // 按名称 upsert：应用已存在只更新 packageUrl（可选 runtime/version），不存在
  // 则创建）。入参白名单以服务端 UploadApplicationDto 为准：file/name 必填、
  // runtime/version 可选——forbidNonWhitelisted 下多一个字段都 400，故可选字段
  // 只在用户给出时才 append。zip 魔数/大小/zip 炸弹校验是服务端职责（400/503
  // 契约语义），CLI 不复刻，只做廉价的扩展名/可读性预检（退出码 2，请求不发）。
  cmd.command('upload <zip>')
    .description(
      'Upload an application package (.zip, max 200 MB) and upsert it by name: an existing app only gets its packageUrl (and runtime/version) updated, a new one is created. ZIP magic/size/zip-bomb checks are server-side',
    )
    .requiredOption('--name <name>', 'Application name (1-100 chars) — the upsert key')
    .option('--runtime <runtime>', 'Runtime type (max 50 chars; a NEW app defaults to python when omitted)')
    .option('--version <version>', 'Version to record for this upload (e.g. 1.2.0); omit to keep the current version')
    .option('--json', 'Emit raw JSON (CI-consumable)')
    .action(async (zip: string, opts: { name: string; runtime?: string; version?: string; json?: boolean }) => {
      const spinner = ora('Uploading package…').start();
      try {
        if (!/\.zip$/i.test(zip)) {
          throw new UsageError(`Only .zip packages are accepted (got "${zip}") — the server validates both extension and ZIP magic`);
        }
        const fsPromises = await import('fs/promises');
        let buf: Buffer;
        try {
          buf = await fsPromises.readFile(zip);
        } catch (err) {
          // 本地文件层错误 = 用法错误（退出码 2），与服务端拒绝（1）区分；
          // 口径与 loadJsonBody / task import 一致。
          throw new UsageError(`Cannot read package file: ${zip} (${err instanceof Error ? err.message : String(err)})`);
        }
        // Node 内置 FormData/Blob（undici，Node >=18 全局可用）：axios 1.x 识别
        // spec FormData 后自动补 multipart boundary 与 Content-Type，无需引入
        // form-data 依赖。字段名 file/name/runtime/version 是服务端 multer +
        // DTO 白名单；不手动设 Content-Type（会把 boundary 写死）。
        const form = new FormData();
        form.append('file', new Blob([buf], { type: 'application/zip' }), path.basename(zip));
        form.append('name', opts.name);
        if (opts.runtime) form.append('runtime', opts.runtime);
        if (opts.version) form.append('version', opts.version);
        // NETOPT-6④ 同款思路：200MB 上限下实例默认 30s 结构性不够，用
        // UPLOAD_TIMEOUT_MS（300s）per-call 覆盖。
        const a = await post<Application>('/applications/upload', form, UPLOAD_TIMEOUT_MS);
        spinner.stop();
        if (opts.json) {
          // ECO-02：单对象形态 → pretty JSON
          console.log(JSON.stringify(a, null, 2));
          return;
        }
        spinner.succeed(`Package uploaded: ${a.name}`);
        console.log(
          chalk.gray(
            `  id: ${a.id}  version: ${a.version ?? '-'}  status: ${statusColor(a.status)}  packageUrl: ${a.packageUrl ?? '-'}`,
          ),
        );
      } catch (e: unknown) {
        emitError('Failed to upload package', e, { spinner });
      }
    });

  // acf app update <id>
  cmd.command('update <id>')
    .description(
      'Update an application (JSON payload via --body or --file). ' +
        'Accepted fields: description, version, runtime, status, gitRepo, gitBranch, gitCommit, manifest, env, entrypoint, packageUrl, webhookSecret. ' +
        'NOTE: the backend UpdateApplicationDto has no `name` field — renaming is not supported.',
    )
    .option('--body <json>', 'Application patch body as JSON string (required unless --file is given)')
    .option('--json <body>', 'DEPRECATED (renamed to --body): Application patch body as JSON string. In the next major version --json becomes a boolean output flag')
    .option('--file <path>', 'Read application patch body from a JSON file (overrides --body/--json)')
    .action(async (id, opts) => {
      if (opts.body !== undefined && opts.json !== undefined) {
        emitUsageError('--body and --json (deprecated alias) are mutually exclusive — pass only --body');
      }
      if (opts.body === undefined && opts.json === undefined && !opts.file) {
        emitUsageError('Missing required application patch body — pass --body <json> (or --file <path>)');
      }
      const spinner = ora('Updating application…').start();
      try {
        if (opts.json !== undefined) {
          process.stderr.write(
            chalk.yellow('⚠ --json <body> is deprecated and will be removed in the next major version (it will become a boolean output flag). Use --body <json> instead.\n'),
          );
        }
        const body = (await loadJsonBody(opts.json ?? opts.body, opts.file)) as Record<string, unknown>;
        // UpdateApplicationDto has no `name` — with forbidNonWhitelisted the
        // API would answer 400 "property name should not exist". Fail early
        // with an actionable message instead.
        if (body && typeof body === 'object' && 'name' in body) {
          // 本地 payload 语义错误 = 用法错误（退出码 2），不必等服务端 400。
          throw new UsageError(
            'Application update does not support renaming: the backend UpdateApplicationDto has no `name` field. ' +
              'Remove "name" from the payload.',
          );
        }
        const a = await put<Application>(`/applications/${id}`, body);
        spinner.succeed(`Application updated: ${a.id}`);
        console.log(chalk.gray(`  name: ${a.name}  version: ${a.version ?? '-'}  status: ${statusColor(a.status)}`));
      } catch (e: unknown) {
        emitError('Failed to update application', e, { spinner });
      }
    });

  // acf app delete <id>
  cmd.command('delete <id>')
    .description('Delete an application')
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .action(async (id, opts) => {
      // P0（CLI-AGENT-UX-AUDIT）：非交互 stdin 下必须显式拒绝，不能静默假绿。
      if (!(await confirmDestructive(`Delete application ${id}?`, { yes: opts.yes }))) return;
      const spinner = ora('Deleting application…').start();
      try {
        await del(`/applications/${id}`);
        spinner.succeed(`Application ${id} deleted`);
      } catch (e: unknown) {
        emitError('Failed to delete application', e, { spinner });
      }
    });

  // acf app analyze <id>
  cmd.command('analyze <id>')
    .description('Run AI health analysis on an application')
    .action(async (id) => {
      const spinner = ora('Running AI health analysis…').start();
      try {
        // NETOPT-6④：同步 AI 端点（服务端预算 60s×2）用 120s per-call 覆盖，
        // 否则默认 30s 结构性小于服务端预算，AI 跑满预算成功返回时 CLI 已超时。
        const result = await post<{
          appId: string;
          appName: string;
          analysis: string;
          stats: { totalTasks: number; avgSuccessRate: number; avgDuration: number; criticalTasks: string[] };
        }>(`/applications/${id}/analyze`, undefined, ANALYZE_TIMEOUT_MS);
        spinner.stop();
        console.log(chalk.bold(`\nAI Health Analysis — ${result.appName}`));
        console.log(chalk.gray('─'.repeat(60)));
        console.log(`  Total tasks     : ${result.stats.totalTasks}`);
        console.log(`  Avg success rate: ${chalk.green(result.stats.avgSuccessRate + '%')}`);
        console.log(`  Avg duration    : ${result.stats.avgDuration}ms`);
        if (result.stats.criticalTasks.length > 0) {
          console.log(`  Critical tasks  : ${chalk.red(result.stats.criticalTasks.join(', '))}`);
        }
        console.log();
        console.log(result.analysis);
      } catch (e: unknown) {
        emitError('Analysis failed', e, { spinner });
      }
    });

  // acf app deploy <id>
  //
  // P0（2026-10 开发人员实测）：`--run-mode` 的语义此前只列枚举值、不解释
  // 行为差异，且默认值 `daemon` 恰好是"部署即立刻执行入口脚本"的模式——中台
  // 定时触发场景（存量部署 11/12 是 scheduled）按"部署 = 待命"理解却不传 -m，
  // 部署时自跑了一次完整任务，28s 后再 trigger 又跑一次，两边并发写同一云盘
  // 目录。修复三管齐下：
  //   ① 默认值改为 `scheduled`（仅下发、由中台/定时触发，部署后不自跑）；
  //   ② 帮助文本写清三档的真实行为（语义见 docs/deployment.md §runMode）；
  //   ③ 显式传 once/daemon 时在发请求前打黄色预警"将立刻启动入口脚本"。
  // `deploy-only` 是 scheduled 的自解释别名（"仅部署、不自动运行"）——服务端
  // RunMode 枚举没有该值，CLI 在本地归一为 scheduled 后发送。
  cmd.command('deploy <id>')
    .description('Deploy an application to an executor (auto-selects the lowest-load online executor when --executor is omitted)')
    .option('-e, --executor <executorId>', 'Pin to a specific executor')
    .option(
      '-m, --run-mode <mode>',
      'Run mode: once (run the entry script once, no restart) | daemon (resident process — the entry script STARTS at deploy and auto-restarts on crash) | scheduled (deploy-only — no process at deploy; middleware/cron triggers it later; default) | deploy-only (alias of scheduled)',
      (v: string) => {
        const m = v.toLowerCase();
        if (!['once', 'daemon', 'scheduled', 'deploy-only'].includes(m)) {
          throw new InvalidArgumentError('must be one of: once | daemon | scheduled | deploy-only (deploy-only = scheduled — deploy without auto-run)');
        }
        return m;
      },
      'scheduled',
    )
    .option('--env <json>', 'Env var overrides as JSON, e.g. \'{"KEY":"value"}\'')
    .option('--start-command <cmd>', 'Startup command override (defaults to manifest entrypoint)')
    .action(async (id, opts) => {
      // deploy-only → scheduled：本地别名归一（服务端 RunMode 枚举无 deploy-only）。
      const runMode = opts.runMode === 'deploy-only' ? 'scheduled' : opts.runMode;
      if (runMode === 'daemon' || runMode === 'once') {
        // 预警在请求发出之前给出：once/daemon 会在部署时立刻启动入口脚本
        //（daemon 异常退出还会自动重启）——"部署即跑"是双跑事故的根源。
        process.stderr.write(
          chalk.yellow(
            `⚠ run-mode "${opts.runMode}" starts the entry script immediately at deploy — for deploy-only (middleware/cron triggers later), use --run-mode scheduled.\n`,
          ),
        );
      }
      const spinner = ora('Triggering deployment…').start();
      try {
        const body: Record<string, unknown> = { runMode };
        if (opts.executor) body.executorId = opts.executor;
        if (opts.startCommand) body.startCommand = opts.startCommand;
        // P2（CLI-AGENT-UX-AUDIT）：--env 的 JSON 解析此前裸放在 try 里，坏 JSON
        // 被当成「部署失败」报退出码 1——agent 会去查服务端日志，而实际是自己
        // 参数写错了。与 `task trigger --params` 同口径：本地 payload 错误是
        // 用法错误（退出码 2），且请求不发出。
        if (opts.env) {
          try {
            body.env = JSON.parse(opts.env);
          } catch (err) {
            throw new UsageError(
              `Invalid --env JSON: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        const dep = await post<{ id?: string; status?: string; executorId?: string }>(
          `/app-deployments/applications/${id}/deploy`,
          body,
        );
        spinner.succeed('Deployment triggered');
        console.log(chalk.gray(`  deployment: ${dep?.id ?? '-'}  status: ${dep?.status ?? '-'}  executor: ${dep?.executorId ?? 'auto'}`));
      } catch (e: unknown) {
        emitError('Deployment failed', e, { spinner });
      }
    });

  // P2: acf app upgrade-all <appId> —— POST /applications/:id/upgrade-all（DEP-02
  // 灰度）。契约：请求体全可选，缺省（不传 body）= all 全量升级，既有语义逐字节
  // 保持；canary 传 { rollout: { strategy: 'canary', percentage? } }。
  // 2026-10-07：UpgradeAllDto 增可选 version（版本定向灰度/渐进回滚）——
  // --version <v> 时 body 带顶层 version；缺省不带（升级目标恒为应用当前版本）。
  // 批次由服务端异步推进（心跳确认 → 健康探测 → 提升），受理 ≠ 完成。
  cmd.command('upgrade-all <appId>')
    .description(
      "Trigger a rolling upgrade of all RUNNING deployments to the application's current version (or --version). Default = full upgrade (pre-DEP-02 semantics, no body). Canary batches advance asynchronously on the server — acceptance is not completion",
    )
    .option('--strategy <strategy>', 'Rollout strategy: all (default) | canary (first batch → heartbeat confirm → health probe → auto-promote the rest, DEP-02)')
    .option(
      '--percentage <n>',
      'Canary first-batch percentage, int 1-100 (default 50 — first batch = ceil(N × p%), at least 1)',
      (v: string) => {
        const n = Number.parseInt(v, 10);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
          throw new InvalidArgumentError('must be an integer between 1 and 100');
        }
        return n;
      },
    )
    .option(
      '--version <version>',
      'Target a historical released version (version string, not uuid) — enables gradual rollback. Default: the application\'s current version. The app record is restored from that version snapshot before the rollout starts',
    )
    .option('--json', 'Emit raw JSON (CI-consumable)')
    .option('-y, --yes', 'Skip the confirmation prompt for a FULL upgrade (all strategy)', false)
    .action(async (appId: string, opts: { strategy?: string; percentage?: number; version?: string; json?: boolean; yes?: boolean }) => {
      const strategy = opts.strategy ?? 'all';
      if (strategy !== 'all' && strategy !== 'canary') {
        emitUsageError(`Unknown rollout strategy "${strategy}" — expected one of: all | canary`);
      }
      if (opts.percentage !== undefined && strategy !== 'canary') {
        emitUsageError('--percentage only applies to --strategy canary (the full-upgrade path never reads it)');
      }
      // P1（CLI-AGENT-UX-AUDIT）：全量滚动升级会重启该应用**所有 RUNNING 部署**，
      // 此前零确认。canary 天然是低风险首步（且服务端会自动提升/回滚），不设门；
      // all 是「一次性动全量」，需要显式表态——与三处 delete 共用同一套非交互语义。
      if (strategy === 'all') {
        if (
          !(await confirmDestructive(
            `Roll out the upgrade to ALL running deployments of ${appId}?`,
            { yes: opts.yes },
          ))
        ) {
          return;
        }
      }
      const spinner = ora('Triggering upgrade…').start();
      try {
        // all：不传 body —— 与既有全量升级语义逐字节一致；canary：rollout
        // 白名单体，percentage 仅在给出时携带（服务端缺省 50）。
        const body =
          strategy === 'canary'
            ? {
                ...(opts.version !== undefined ? { version: opts.version } : {}),
                rollout: {
                  strategy,
                  ...(opts.percentage !== undefined ? { percentage: opts.percentage } : {}),
                },
              }
            : opts.version !== undefined
              ? { version: opts.version }
              : undefined;
        const r = await post<UpgradeAllResult>(`/applications/${appId}/upgrade-all`, body);
        spinner.stop();
        if (opts.json) {
          // ECO-02：响应对象直出（含 rollout 批次信息），退出码语义与下面的人读
          // 路径一致（受理被拒/批次失败 → 1）。
          console.log(JSON.stringify(r, null, 2));
          if (r.ok === false || (r.failed ?? 0) > 0) process.exitCode = 1;
          return;
        }
        if (r.ok === false) {
          // 受理被拒（ARCH-31 在途批次互斥 / canary 首批失败 ok=false,failed=1）：
          // HTTP 仍是 2xx，但 CLI 要让 CI 看得见（对齐 task batch 部分失败语义）。
          spinner.fail('Upgrade batch not started');
          console.error(
            chalk.red(
              `  ${r.rollout?.blockedReason ?? `first canary batch failed (${r.failed}/${r.total}) — see rolloutMeta on the app's deployments for the reason`}`,
            ),
          );
          process.exitCode = 1;
          return;
        }
        if (strategy === 'canary') {
          spinner.succeed(`Canary batch accepted: first batch ${r.succeeded}/${r.total} deployment(s)`);
          console.log(chalk.gray(`  batchId: ${r.rollout?.batchId ?? '-'}  strategy: ${r.rollout?.strategy ?? strategy}`));
          if (r.rollout?.canaryIds?.length) {
            console.log(chalk.gray(`  canary: ${r.rollout.canaryIds.map((x) => x.slice(0, 12)).join(', ')}`));
          }
          if (r.rollout?.promotedIds?.length) {
            console.log(chalk.gray(`  promoted so far: ${r.rollout.promotedIds.length}`));
          }
          console.log(
            chalk.yellow(
              `  ⚠ Accepted is not finished — the batch advances asynchronously (heartbeat confirm → health probe → promote). Follow progress in the admin console or: acf app deployments ${appId}`,
            ),
          );
        } else {
          spinner.succeed(`Upgrade triggered: ${r.succeeded}/${r.total} deployment(s) accepted, ${r.failed} failed`);
          if ((r.failed ?? 0) > 0) {
            console.error(
              chalk.red(
                `  ${r.failed} deployment(s) failed to accept the upgrade — inspect with: acf app deployments ${appId}`,
              ),
            );
            process.exitCode = 1;
          }
        }
      } catch (e: unknown) {
        emitError('Failed to trigger upgrade-all', e, { spinner });
      }
    });

  // acf app deployments [appId]
  cmd.command('deployments [appId]')
    .description('List deployments (optionally filtered by application)')
    .option('-p, --page <n>', 'Page number', '1')
    .option('-n, --page-size <n>', 'Page size', '20')
    // --json 补面（本轮 UX 统一）：列表/信封形态 → 单行紧凑 JSON
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

  // acf app versions <id>
  cmd.command('versions <id>')
    .description('Show application version history')
    // --json 补面（本轮 UX 统一）：数组形态 → pretty JSON
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (id, opts: { json?: boolean }) => {
      const spinner = ora('Fetching version history…').start();
      try {
        // getVersionHistory returns `commit` / `deployedAt` (no gitCommit / changeNote)
        const versions = await get<
          Array<{ id: string; version: string; commit?: string; deployedAt?: string; createdAt?: string; status?: string }>
        >(`/applications/${id}/versions`);
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(versions, null, 2));
          return;
        }
        const table = new Table({
          head: ['Version', 'Commit', 'Deployed', 'Status'],
          colWidths: [12, 14, 25, 12],
          style: { head: ['cyan'] },
        });
        for (const v of versions) {
          table.push([
            v.version,
            v.commit?.slice(0, 12) ?? '-',
            new Date(v.deployedAt ?? v.createdAt ?? '').toLocaleString(),
            v.status ?? '-',
          ]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        emitError('Failed to list versions', e, { spinner });
      }
    });

  // DEP-01: acf app releases <appId> —— GET /applications/:id/releases
  // 统一发布追溯视图：一行 = 一次版本发布（版本号/包地址/部署时间/状态/次数/
  // 执行器/runMode/触发方式/操作人）。`app versions` 是过渡期 legacy alias，
  // releases 才是现代读面（admin-web ApplicationDetailPage 消费它）。
  interface AppRelease {
    id: string | null;
    version: string | null;
    packageUrl?: string | null;
    gitCommit?: string | null;
    deployedAt: string | null;
    latestDeploymentId?: string | null;
    deploymentStatus: string | null;
    deploymentCount: number;
    executorAddress?: string | null;
    runMode: string | null;
    triggerType: string | null;
    operator?: string | null;
    status: string;
    createdAt: string | null;
    synthetic?: boolean;
  }
  cmd.command('releases <appId>')
    .description('List unified release history (version × latest deployment) for an application — the modern DEP-01 view; `app versions` is the legacy alias')
    .option('-p, --page <n>', 'Page number', '1')
    .option('-n, --page-size <n>', 'Page size (max 200, default 50)', '50')
    // --json 补面（UX 统一）：列表/信封形态 → 单行紧凑 JSON
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (appId: string, opts: { page?: string; pageSize?: string; json?: boolean }) => {
      const spinner = ora('Fetching releases…').start();
      try {
        // getReleases returns `{ data, total, page, pageSize }`
        const data = await get<{ data?: AppRelease[]; list?: AppRelease[]; total?: number }>(
          `/applications/${appId}/releases`,
          { page: opts.page, pageSize: opts.pageSize },
        );
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(data));
          return;
        }
        const list: AppRelease[] = Array.isArray(data) ? data : (data.data ?? data.list ?? []);
        if (!list.length) {
          console.log(chalk.gray('No releases recorded for this application.'));
          return;
        }
        const table = new Table({
          head: ['Version', 'Deployed', 'Status', 'Count', 'Executor', 'RunMode', 'Trigger'],
          colWidths: [12, 20, 12, 8, 18, 10, 12],
          style: { head: ['cyan'] },
        });
        for (const r of list) {
          table.push([
            r.version ?? '-',
            r.deployedAt ? new Date(r.deployedAt).toLocaleString() : '-',
            statusColor(r.deploymentStatus ?? r.status),
            String(r.deploymentCount),
            r.executorAddress ?? '-',
            r.runMode ?? '-',
            r.triggerType ?? '-',
          ]);
        }
        console.log(table.toString());
        console.log(chalk.gray(`Total: ${data.total ?? list.length}  page ${opts.page}`));
      } catch (e: unknown) {
        emitError('Failed to list releases', e, { spinner });
      }
    });

  return cmd;
}
