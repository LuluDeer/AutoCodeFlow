#!/usr/bin/env node
/**
 * ACF CLI — AutoCodeFlow command-line interface
 *
 * Usage:
 *   acf login                       # TOTP accounts: add --code <6 digits> (or prompt)
 *   acf task list
 *   acf task trigger <id> --wait
 *   acf task export <id> [-o file] | import <file> | batch <trigger|pause|resume|delete> --ids id1,id2
 *   acf task versions <id> | compare <id> <v1> <v2> | rollback <id> --version <vid>
 *   acf task analyze <taskId> <execId>
 *   acf task suggest-schedule <id>
 *   acf app list | create | update <id> | delete <id>
 *   acf app upload <pkg.zip> --name <name>
 *   acf app upgrade-all <appId> [--strategy canary --percentage N]
 *   acf app analyze <id>
 *   acf task webhook <enable|rotate|disable|status> <taskId>
 *   acf task glue <taskId> -f <file>
 *   acf approval list | approve <id> --note … | reject <id> | cancel <id>
 *   acf deploy upgrade <deploymentId> | stop <deploymentId>
 *   acf executor list | get <id> | rotate <name|id> | offline <name|id>
 *   acf exec tail <execId>
 *   acf task lint <file>
 *   acf audit list
 *   acf sop list | show <sopId>
 *   acf agent sessions
 *   acf apikey create --name <name> --scope <readonly|trigger|manage> [--expires <days>]
 *   acf apikey list | revoke <id>
 *   acf config show
 *
 * 退出码表（docs 详见 README.md「Exit codes」，单一事实源在 src/ui.ts 的
 * EXIT_CODES）：0 成功；1 运行失败；2 用法/参数错误；3 认证失败；
 * 4 网络失败；130 中断（SIGINT）。
 */
import { Command, CommanderError } from 'commander';
import { pathToFileURL } from 'node:url';
import chalk from 'chalk';
import { loginCommand, whoamiCommand, logoutCommand } from './commands/login.js';
import { tasksCommand } from './commands/tasks.js';
import { appsCommand } from './commands/apps.js';
import { executorsCommand } from './commands/executors.js';
import { deployCommand } from './commands/deploy.js';
import { auditCommand } from './commands/audit.js';
import { execCommand } from './commands/exec.js';
import { projectsCommand } from './commands/projects.js';
import { sopCommand } from './commands/sop.js';
import { agentCommand } from './commands/agent.js';
import { apikeysCommand } from './commands/apikeys.js';
import { approvalCommand } from './commands/approval.js';
import { showConfig, setApiUrl, setToken } from './config.js';
import { applyExamples } from './help.js';
import { EXIT_CODES, interruptExit } from './ui.js';
// 版本号单一事实源：直接读 package.json，而不是硬编码字面量。
//
// 原实现写死 `.version('1.0.0')`，而 package.json 是 `version-guard` 与
// release-please 唯一会 bump 的地方——两者必然漂移。实测证据：包名/版本改成
// `@autocodeflow/cli@1.4.3` 后，`npx acf --version` 仍打印 **1.0.0**。
// 这是发布物里最不该出错的一处：用户报 issue、我们排查兼容性、`acf` 自身
// 做版本相关的行为分支，读的都是这个数。
// `resolveJsonModule` 已在 tsconfig 打开；tsc 的 rootDir=src 会把 package.json
// 视为 src 之外的输入，故走运行时解析（发布物里 package.json 与 dist/ 同级，
// 路径稳定）。本包为 ESM（type: module），JSON 导入须带 import attribute。
// 2026-10 起不再经 Commander .version() 注册（详见下方 VERSION-HIJACK 注释），
// 但 pkg.version 仍是版本输出的唯一事实源——行为层守卫跑真实构建产物钉死。
import pkg from '../package.json' with { type: 'json' };

// 导出命令树供测试复用（结构守卫：每个叶子命令都必须有 Examples）。配合底部
// 的 main-guard，import 本文件不会触发 parseAsync。
export const program = new Command();

program
  .name('acf')
  .description('AutoCodeFlow CLI — manage tasks, executions, applications and projects');

// ---------------------------------------------------------------------------
// 版本号处理（VERSION-HIJACK，P1 修复）
// ---------------------------------------------------------------------------
// 根命令**不**注册 --version 选项：commander 的根层 parseOptions 会在派发子
// 命令之前扫描**全部**参数，一旦经 .version() 注册，`acf app upload --version
// 1.2.0` / `acf app upgrade-all --version 1.9.0` / `acf task rollback --version
// v9` 里的 --version 会在根层被匹配并 exit 0 打印 CLI 版本——上传/升级/回滚
// 根本没发生却不报错（2026-10 开发人员实测，三个子命令全部中招）。
//
// 修法：版本输出改由根命令的 unknownOption 覆盖接管——只有到达根层仍未被
// 任何子命令消费的 --version / -V（即 `acf --version` / `acf -V` 这类根级
// 请求）才打印 pkg.version 并以 0 退出；子命令自己的 --version 选项由各自的
// parseOptions 消费，互不干扰。pkg.version 仍是唯一事实源（行为层守卫
// release-metadata.test.ts 跑真实构建产物钉死，改回硬编码会转红）。
// 'before' 只挂在根命令的帮助上（子命令 help 不显示版本横幅——原 .version()
// 的版本 banner 同样是根级专属；'beforeAll' 会传播到所有子命令，太吵）。
program.addHelpText('before', `acf v${pkg.version}\n`);

// 根级 unknownOption 覆盖：`acf --version` / `acf -V` 会在根 _parseCommand 的
// checkForUnknownOptions 里走到这里（无子命令可派发），此时按 CLI 版本处理；
// 其余未知选项（含"某子命令树里没有 --version 选项"的情形）走 commander
// 原逻辑（报错 + 完整 help + 退出码 2）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const programAny = program as any;
const rootUnknownOption = programAny.unknownOption.bind(program);
programAny.unknownOption = (flag: string) => {
  if (flag === '--version' || flag === '-V') {
    console.log(pkg.version);
    process.exit(0);
  }
  return rootUnknownOption(flag);
};

// ---------------------------------------------------------------------------
// 解析期行为统一（全树，见下方 applyParseErrorBehavior 的说明）
// ---------------------------------------------------------------------------

// Global options that override stored config
program
  .option('--api-url <url>', 'Override API URL for this invocation (or set ACF_API_URL env var)')
  .option('--token <token>', 'Override auth token for this invocation (or set ACF_TOKEN env var)');

program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.opts();
  if (opts.apiUrl) process.env['ACF_API_URL'] = opts.apiUrl;
  if (opts.token) process.env['ACF_TOKEN'] = opts.token;
});

// ---- sub-commands ----
program.addCommand(loginCommand());
program.addCommand(whoamiCommand());
program.addCommand(logoutCommand());
program.addCommand(tasksCommand());
program.addCommand(appsCommand());
program.addCommand(executorsCommand());
program.addCommand(deployCommand());
program.addCommand(auditCommand());
program.addCommand(execCommand());
program.addCommand(projectsCommand());
program.addCommand(sopCommand());
program.addCommand(agentCommand());
program.addCommand(apikeysCommand());
program.addCommand(approvalCommand());

// acf config show / set
const configCmd = new Command('config').description('View or update CLI configuration');
configCmd
  .command('show')
  .description('Show current config (token is always masked — [set] / [not set])')
  // P2（CLI-AGENT-UX-AUDIT）：--json 让 agent 能解析当前配置（不改 [set]/[not set] 口径）
  .option('--json', 'Emit raw JSON (CI-consumable)')
  .action((opts: { json?: boolean }) => showConfig({ json: opts.json }));
configCmd.command('set-url <url>').description('Set API base URL').action((url) => {
  setApiUrl(url);
  console.log(chalk.green(`✔ API URL set to ${url}`));
});
configCmd.command('set-token <token>').description('Set auth token directly').action((token) => {
  setToken(token);
  console.log(chalk.green('✔ Token saved'));
  // 安全提示（与 login 的 --password 告警同风格）：命令行明文 token 会留在
  // shell history 与进程列表里；login（交互隐藏输入 + 落 0600 配置文件）或
  // ACF_TOKEN 环境变量（不进 argv）是更安全的通路。
  process.stderr.write(
    chalk.yellow(
      '⚠ A token passed on the command line can leak into shell history and the process list — prefer `acf login` or the ACF_TOKEN environment variable.\n',
    ),
  );
});
program.addCommand(configCmd);

// 集中式 help：把 help.ts 的 EXAMPLES 表按命令路径走树注入（每个命令至少一个
// 示例；覆盖面由 ux-uniform.test.ts 用本树做结构守卫）。
applyExamples(program);

/**
 * 解析期行为统一到整棵命令树：
 * - exitOverride：解析错误不再让 commander 内部直接 process.exit(1)，而是抛
 *   CommanderError 到 runCli 的 catch 统一映射退出码（--help/--version → 0，
 *   其余 → 2 用法错误）。--version 的行为由 release-metadata.test.ts 真实
 *   执行构建产物钉死，改动后跑全量测试即可发现回归。
 * - showHelpAfterError：缺参/未知命令/未知选项时在 error 行之后打印**该命令
 *   的完整 help**（含 Examples）——用户在报错现场就能拿到可操作的用法。
 * - configureOutput：error 行染红。
 *
 * 为什么走树补设而不是只在 program 上设一次：commander 只在 addCommand 时把
 * 这些设置拷贝给**直接子命令**（copyInheritedSettings），而孙子级（task get /
 * config show 等）在各命令工厂函数里创建，早于 addCommand——实测它们拿不到
 * exitOverride，深层缺参错误会绕过退出码映射直接 process.exit(1)，error 行也
 * 不染红。在整棵树装配完成后逐命令补设是唯一覆盖全深度的方式。
 */
function applyParseErrorBehavior(cmd: Command): void {
  cmd.exitOverride();
  cmd.showHelpAfterError();
  cmd.configureOutput({
    outputError: (str, write) => write(chalk.red(str)),
  });
  for (const sub of cmd.commands) applyParseErrorBehavior(sub);
}
applyParseErrorBehavior(program);

/**
 * Map a commander parse outcome to the CLI exit code.
 * `--help` / `--version` / `acf help <cmd>` 是用户主动要的正常出口 → 0；
 * 其余解析错误（缺参/未知命令/未知选项/非法取值）= 用法错误 → 2。
 */
export function parseErrorExitCode(e: unknown): number {
  if (e instanceof CommanderError) {
    return e.exitCode === 0 ? EXIT_CODES.OK : EXIT_CODES.USAGE;
  }
  return EXIT_CODES.GENERIC;
}

// 仅当本文件是进程入口时才启动解析。测试需要 import 本文件复用**真实**命令树
// （example 覆盖守卫不能靠复刻一份会漂移的镜像树），main-guard 让 import 无
// 副作用；正常执行路径（node dist/index.js、tsx src/index.ts、npm bin）下
// argv[1] 与本模块 URL 指向同一文件，守卫恒真。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // SIGINT 统一出口：Ctrl+C 补换行（spinner 帧不留半行）并以 128+SIGINT 惯例
  // 码 130 退出。交互 readline 的 raw 模式不走进程信号，由各 prompt 内的
  // rl.on('SIGINT') 接住后也汇入同一个 interruptExit。
  process.on('SIGINT', () => interruptExit());
  program.parseAsync(process.argv).catch((e: unknown) => {
    if (e instanceof CommanderError) {
      // error 行与 help 已由 commander 经 outputError/print 写出，这里只做
      // 退出码映射，不重复打印。
      process.exit(parseErrorExitCode(e));
    }
    console.error(chalk.red('Error:'), e instanceof Error ? e.message : String(e));
    process.exit(EXIT_CODES.GENERIC);
  });
}
