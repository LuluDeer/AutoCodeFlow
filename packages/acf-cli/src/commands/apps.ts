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
 * R2（部署模型评审 §4.4）：新增 coverage 按状态分组计数与 skipped 在途
 * 跳过明细——只增不改，旧字段语义不变。
 */
interface UpgradeAllResult {
  ok: boolean;
  total: number;
  succeeded: number;
  failed: number;
  /** R2 §4.4：覆盖面分组计数（running+scheduled 为默认覆盖面）。 */
  coverage?: {
    running: number;
    scheduled: number;
    stopped: number;
    failed: number;
    inFlight: number;
  };
  /** R2 §4.4：在途行（pending/deploying/upgrading）跳过明细。 */
  skipped?: Array<{
    deploymentId: string;
    executorId: string | null;
    status: string;
    reason: string;
  }>;
  rollout?: {
    batchId: string;
    strategy: string;
    canaryIds: string[];
    promotedIds: string[];
    blockedReason?: string;
  };
}

/**
 * R1（部署模型评审 §4.2）：POST /applications/:id/set-current-version 响应——
 * 只按版本快照恢复应用当前字段，dispatched 恒 false（不下发任何设备）。
 */
interface SetCurrentVersionResult {
  ok: boolean;
  dispatched: boolean;
  version: string;
  versionId: string;
}

/**
 * R1（部署模型评审 §4.2）：POST /applications/:id/deploy-version 响应——
 * 字段恢复 + 下发。skipped.reason：no_deployment（执行器无部署行）/
 * not_running（行状态不可下发）/ upgrade_rejected（upgrade 链被拒，真失败）。
 */
interface DeployVersionResult {
  ok: boolean;
  dispatched: boolean;
  version: string;
  versionId: string;
  upgraded: Array<{
    deploymentId: string;
    executorId: string | null;
    executorAddress: string | null;
  }>;
  skipped: Array<{
    executorId: string | null;
    deploymentId: string | null;
    reason: string;
    detail?: string | null;
  }>;
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
    .description(
      'Create an application (JSON payload via --body or --file; required: name, version, runtime). ' +
        'Optional: mutexGroupId (uuid from `acf mutex list` to join a mutex group), approvalRequired (gate deploys behind a second person).',
    )
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
        // @types/node 26 收紧了 Buffer 与 DOM BlobPart 的关系：Buffer 是
        // Uint8Array<ArrayBufferLike>，而 BlobPart 要 ArrayBuffer-backed，
        // 直接传 buf 会 TS2322。用 Uint8Array 视图包一层（**零拷贝**，共享
        // 同一块内存，运行时行为与原来完全一致）即可满足签名。
        form.append(
          'file',
          new Blob([new Uint8Array(buf)], { type: 'application/zip' }),
          path.basename(zip),
        );
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
        'Accepted fields: description, version, runtime, status, gitRepo, gitBranch, gitCommit, manifest, env, entrypoint, packageUrl, webhookSecret, ' +
        'approvalRequired, mutexGroupId. ' +
        'NOTE: the backend UpdateApplicationDto has no `name` field — renaming is not supported. ' +
        'mutexGroupId takes a group uuid from `acf mutex list` (null detaches); `acf mutex` also manages the groups themselves.',
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
        const dep = await post<{
          id?: string;
          status?: string;
          executorId?: string;
          approvalStatus?: string | null;
        }>(`/app-deployments/applications/${id}/deploy`, body);
        // F2（本轮审计）：DEP-04 审批门打开时，后端返回 status=pending +
        // approvalStatus=pending_approval 且**不下发**。旧实现无条件打印
        // `✔ Deployment triggered` 并 exit 0 —— `acf app deploy && …` 会把
        // 「冻结待审批、设备上什么都没跑」读成部署成功；该行还占着 in-flight
        // 槽位，后续部署 409，调用方只看到"冲突"却不知道自己是在等审批。
        // MCP 的 deploy_application 早已按此判定，CLI 漏了。
        const awaitingApproval =
          dep?.approvalStatus === 'pending_approval' || dep?.status === 'pending';
        if (awaitingApproval) {
          spinner.warn('Deployment frozen pending approval — NOT dispatched yet');
          console.log(
            chalk.gray(
              `  deployment: ${dep?.id ?? '-'}  status: ${dep?.status ?? '-'}  ` +
                `approval: ${dep?.approvalStatus ?? 'pending'}  executor: ${dep?.executorId ?? 'auto'}`,
            ),
          );
          console.log(
            chalk.yellow(
              '  This application requires a second-person approval. The code has NOT been deployed. ' +
                'Run `acf approval pending` to see it, or `acf approval approve <id> <deploymentId>` to release it.',
            ),
          );
          // 非零退出：脚本里的 `acf app deploy … && 验证部署` 不能再把「等审批」
          // 当成「已部署」。语义是"未完成"，不是"参数错"（那是 2）。
          process.exitCode = 1;
          return;
        }
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
  // R2（部署模型评审 §4.4，2026-10-24）：覆盖面显式化——默认覆盖 = 全部
  // RUNNING 行（scheduled「仅部署」行实证稳态即 RUNNING，同属默认覆盖）；
  // --include-stopped 把 stopped 行显式纳入（仅 all 策略）；在途行由服务端
  // 跳过并在响应 skipped 明细回显（黄字透出，不当作失败）。
  // 批次由服务端异步推进（心跳确认 → 健康探测 → 提升），受理 ≠ 完成。
  cmd.command('upgrade-all <appId>')
    .description(
      "Trigger a rolling upgrade of the application's deployed devices to its current version (or --version). Default coverage = all RUNNING rows (deploy-only/scheduled rows report running on completion, so they are covered too); --include-stopped additionally dispatches STOPPED rows (all strategy only). Canary batches advance asynchronously on the server — acceptance is not completion",
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
      'Target a historical released version (version string, not uuid) — enables gradual rollback. Default: the application\'s current version. The app record is restored from that version snapshot before the rollout starts. Equivalent to the R1 set-current-version + deploy-version split endpoints; prefer those',
    )
    .option(
      '--include-stopped',
      'Also dispatch STOPPED deployment rows under the all strategy (default: only RUNNING rows — daemon and deploy-only alike). The canary strategy rejects this flag (health probing needs live processes)',
      false,
    )
    .option('--json', 'Emit raw JSON (CI-consumable)')
    .option('-y, --yes', 'Skip the confirmation prompt for a FULL upgrade (all strategy)', false)
    .action(async (appId: string, opts: { strategy?: string; percentage?: number; version?: string; includeStopped?: boolean; json?: boolean; yes?: boolean }) => {
      const strategy = opts.strategy ?? 'all';
      if (strategy !== 'all' && strategy !== 'canary') {
        emitUsageError(`Unknown rollout strategy "${strategy}" — expected one of: all | canary`);
      }
      if (opts.percentage !== undefined && strategy !== 'canary') {
        emitUsageError('--percentage only applies to --strategy canary (the full-upgrade path never reads it)');
      }
      // R2 §4.4：includeStopped 只作用于 all——canary 的健康探测需要活进程，
      // 扩覆盖只会造出必失败的灰度首批；客户端先拒（与 --percentage 同口径）。
      if (opts.includeStopped && strategy !== 'all') {
        emitUsageError('--include-stopped only applies to the all strategy (canary batches probe live processes)');
      }
      // P1（CLI-AGENT-UX-AUDIT）：全量滚动升级会重启该应用**所有 RUNNING 部署**，
      // 此前零确认。canary 天然是低风险首步（且服务端会自动提升/回滚），不设门；
      // all 是「一次性动全量」，需要显式表态——与三处 delete 共用同一套非交互语义。
      if (strategy === 'all') {
        if (
          !(await confirmDestructive(
            `Roll out the upgrade to ALL running deployments of ${appId}${opts.includeStopped ? ' (including stopped rows)' : ''}?`,
            { yes: opts.yes },
          ))
        ) {
          return;
        }
      }
      const spinner = ora('Triggering upgrade…').start();
      try {
        // all：缺省（无 version/include-stopped）不传 body —— 与既有全量升级
        // 语义逐字节一致；canary：rollout 白名单体，percentage 仅在给出时携带
        // （服务端缺省 50）。R2：all + --include-stopped 带 {includeStopped:true}。
        const allExtras =
          opts.version !== undefined || opts.includeStopped
            ? {
                ...(opts.version !== undefined ? { version: opts.version } : {}),
                ...(opts.includeStopped ? { includeStopped: true } : {}),
              }
            : undefined;
        const body =
          strategy === 'canary'
            ? {
                ...(opts.version !== undefined ? { version: opts.version } : {}),
                rollout: {
                  strategy,
                  ...(opts.percentage !== undefined ? { percentage: opts.percentage } : {}),
                },
              }
            : allExtras;
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
        // R2 §4.4：覆盖面分组如实回显（旧输出只报 succeeded/total，用户无从知道
        // 「仅部署」行也在覆盖内、stopped 有多少台被留下）。
        const cov = r.coverage;
        if (cov) {
          console.log(
            chalk.gray(
              `  coverage: running ${cov.running}, deploy-only ${cov.scheduled}, stopped ${cov.stopped}${opts.includeStopped ? ' (included)' : ''}, failed ${cov.failed}, in-flight ${cov.inFlight}`,
            ),
          );
        }
        // 在途跳过明细：黄字逐行列出（不是失败——exit code 不受影响）。
        for (const s of r.skipped ?? []) {
          console.log(
            chalk.yellow(
              `  skipped: ${s.deploymentId.slice(0, 12)} executor=${s.executorId ?? '-'} status=${s.status} reason=${s.reason}`,
            ),
          );
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
          // 存在 stopped 行且本次未纳入——显式指路（如实提示，不留「以为全升了」的误会）。
          if (!opts.includeStopped && (cov?.stopped ?? 0) > 0) {
            console.log(
              chalk.yellow(
                `  ⚠ ${cov!.stopped} stopped deployment(s) not covered — pass --include-stopped to include them`,
              ),
            );
          }
        }
      } catch (e: unknown) {
        emitError('Failed to trigger upgrade-all', e, { spinner });
      }
    });

  // ── R1（2026-10-24 部署模型评审 §4.2）：应用回滚拆出的两个显式动作 ──────
  // 「设为当前版本」只按版本快照恢复应用当前字段（绝不触碰部署行/设备）；
  // 「下发到设备」先做同一份字段恢复，再对部署行逐台走 upgrade 链。旧 POST
  // /applications/:id/rollback/:id 已标 deprecated alias（admin-web 已切双动作），
  // CLI 不再暴露旧端点——此前 CLI 本就没有 app rollback 子命令，保持不补。

  // acf app set-current-version <appId> <versionId>
  cmd.command('set-current-version <appId> <versionId>')
    .description(
      "Restore the application's current fields from a released version snapshot (version/commit/packageUrl/entrypoint/env/manifest — same mapping as the deprecated rollback). NEVER touches deployment rows or devices; to dispatch use: acf app deploy-version",
    )
    .option('--json', 'Emit raw JSON (CI-consumable)')
    .action(async (appId: string, versionId: string, opts: { json?: boolean }) => {
      // 安全半边（只改记录面）不设确认门——与 upgrade-all 的 canary 首步同口径。
      const spinner = ora('Setting current version…').start();
      try {
        const r = await post<SetCurrentVersionResult>(
          `/applications/${appId}/set-current-version`,
          { versionId },
        );
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }
        spinner.succeed(`Current version set to ${r.version}`);
        console.log(chalk.gray(`  versionId: ${r.versionId}  dispatched: ${r.dispatched} (no devices touched)`));
      } catch (e: unknown) {
        emitError('Failed to set current version', e, { spinner });
      }
    });

  // acf app deploy-version <appId> <versionId> [--executors <id1,id2>]
  cmd.command('deploy-version <appId> <versionId>')
    .description(
      'Restore the app fields from the version snapshot, then dispatch an upgrade to its deployment rows (default: ALL running rows, same as the deprecated rollback). Executors without a dispatchable row are reported as skipped, not errors',
    )
    .option('--executors <ids>', 'Comma-separated executor ids to dispatch to (default: all running deployment rows of the application)')
    .option('--json', 'Emit raw JSON (CI-consumable)')
    .option('-y, --yes', 'Skip the confirmation prompt (the dispatch restarts the selected deployments)', false)
    .action(async (appId: string, versionId: string, opts: { executors?: string; json?: boolean; yes?: boolean }) => {
      let executorIds: string[] | undefined;
      if (opts.executors !== undefined) {
        executorIds = opts.executors.split(',').map((s) => s.trim()).filter(Boolean);
        if (executorIds.length === 0) {
          emitUsageError('--executors must list at least one executor id (comma-separated)');
        }
      }
      // 下发半边会重启所选部署——与 upgrade-all 全量路径同款确认门。
      const scope = executorIds
        ? `${executorIds.length} named executor(s)`
        : 'ALL running deployments';
      if (
        !(await confirmDestructive(
          `Deploy version to ${scope} of ${appId}? (this restarts those deployments)`,
          { yes: opts.yes },
        ))
      ) {
        return;
      }
      const spinner = ora('Dispatching version…').start();
      try {
        const r = await post<DeployVersionResult>(`/applications/${appId}/deploy-version`, {
          versionId,
          ...(executorIds ? { executorIds } : {}),
        });
        spinner.stop();
        // upgrade_rejected = 有行在 upgrade 链被拒（真失败）；no_deployment /
        // not_running 是显式点名的预期跳过——CI 只对前者红。
        const rejected = r.skipped.filter((s) => s.reason === 'upgrade_rejected');
        if (opts.json) {
          console.log(JSON.stringify(r, null, 2));
          if (r.upgraded.length === 0 || rejected.length > 0) process.exitCode = 1;
          return;
        }
        if (r.upgraded.length === 0) {
          spinner.fail('No deployment was dispatched (all targets skipped)');
          for (const s of r.skipped) {
            console.error(chalk.red(`  ${s.executorId ?? s.deploymentId ?? '?'}: ${s.reason}${s.detail ? ` (${s.detail})` : ''}`));
          }
          process.exitCode = 1;
          return;
        }
        spinner.succeed(`Version ${r.version} dispatched: ${r.upgraded.length} deployment(s) upgrading`);
        for (const u of r.upgraded) {
          console.log(chalk.gray(`  ${u.deploymentId.slice(0, 12)}  executor: ${u.executorId ?? '-'}  ${u.executorAddress ?? ''}`));
        }
        if (r.skipped.length > 0) {
          console.error(chalk.yellow(`  ⚠ ${r.skipped.length} skipped:`));
          for (const s of r.skipped) {
            console.error(chalk.yellow(`  ${s.executorId ?? s.deploymentId ?? '?'}: ${s.reason}${s.detail ? ` (${s.detail})` : ''}`));
          }
          if (rejected.length > 0) process.exitCode = 1;
        }
      } catch (e: unknown) {
        emitError('Failed to deploy version', e, { spinner });
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
  // P8-R：被截版本「仍有设备保留」清单的展示上限——超出折叠为计数，与
  // admin-web ApplicationDetailPage 的 RETAINED_BUT_TRUNCATED_MAX_TAGS（10）同口径。
  const RETAINED_BUT_TRUNCATED_MAX = 10;
  cmd.command('releases <appId>')
    .description('List unified release history (version × latest deployment) for an application — the modern DEP-01 view; `app versions` is the legacy alias')
    .option('-p, --page <n>', 'Page number', '1')
    .option('-n, --page-size <n>', 'Page size (max 200, default 50)', '50')
    // --json 补面（UX 统一）：列表/信封形态 → 单行紧凑 JSON
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (appId: string, opts: { page?: string; pageSize?: string; json?: boolean }) => {
      const spinner = ora('Fetching releases…').start();
      try {
        // getReleases returns `{ data, total, page, pageSize, truncated, retainedButTruncated }`
        // （0a278da6：truncated=synthetic 聚合扫描到 5000 行上限被截；
        // retainedButTruncated=被截但仍有设备保留的版本号，字母序。）
        const data = await get<{
          data?: AppRelease[];
          list?: AppRelease[];
          total?: number;
          truncated?: boolean;
          retainedButTruncated?: string[];
        }>(
          `/applications/${appId}/releases`,
          { page: opts.page, pageSize: opts.pageSize },
        );
        spinner.stop();
        if (opts.json) {
          // 信封原样透传（truncated / retainedButTruncated 一并直出，CI 自行判断）
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
        // P8（对齐 admin-web Releases 截断告警条）：truncated=true = synthetic
        // 聚合扫描到 5000 行上限被截——表格用户必须看到「被截」事实，否则会把
        // 「看到的」当「全量」。--json 形态已在上方原样透传两字段，不走这里。
        if (data.truncated) {
          console.log(
            chalk.yellow(
              `⚠ 版本行数超上限被截断，仅显示前 ${list.length} 条；完整动作史见事件流（acf app releases --json 可拿 truncated/retainedButTruncated 原始字段）`,
            ),
          );
          // P8-R：被截版本里「仍有设备保留」的版本号显式列出——徽标行不在
          // 本页，不列出的话「设备还留着这版」的事实就从表格消失。超 10 个
          // 折叠计数，与前端 RETAINED_BUT_TRUNCATED_MAX_TAGS 口径一致。
          const retained = data.retainedButTruncated ?? [];
          if (retained.length > 0) {
            const shown = retained.slice(0, RETAINED_BUT_TRUNCATED_MAX).join(', ');
            const more = retained.length > RETAINED_BUT_TRUNCATED_MAX
              ? `（还有 ${retained.length - RETAINED_BUT_TRUNCATED_MAX} 个版本）`
              : '';
            console.log(chalk.yellow(`  被截断但仍有设备保留的版本: ${shown}${more}`));
          }
        }
      } catch (e: unknown) {
        emitError('Failed to list releases', e, { spinner });
      }
    });

  return cmd;
}
