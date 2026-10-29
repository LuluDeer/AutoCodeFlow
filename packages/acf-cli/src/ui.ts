/**
 * Unified terminal-output / exit-code layer for the CLI.
 *
 * 背景：10 个命令文件此前各自复制同一套「spinner.fail → console.error(red) →
 * process.exit(1)」三连（约 40 处），失败类别（认证/网络/服务端/参数）全部挤在
 * 退出码 1 里，CI 无法分类处理。本层把出口收敛为一个帮手：
 * - 错误分类在 client 层做一次（classifyApiError），这里只负责映射退出码；
 * - 人读文案沿用 formatApiError（含后端 message 与「下一步动作」提示）；
 * - spinner 的 scope 文案由调用方传入，保持各命令既有的失败措辞。
 */
import chalk from 'chalk';
import { writeSync } from 'node:fs';
import { classifyApiError, formatApiError } from './client.js';
import { classifyErrorCode, extractApiErrorInfo } from './error-code.js';

/**
 * CLI 退出码表（README.md「Exit codes」为同一张表的人读版，两处必须同步改）：
 * 0  成功（含 --help / --version）
 * 1  运行失败：服务端拒绝（400/403/404/409/5xx）、失败终态（--wait）、
 *    lint 语法错误、非 UsageError 的本地错误
 * 2  用法/参数错误：缺参、未知命令/选项、非法取值（commander 解析层），
 *    以及本地参数派生错误（lint 无法推断语言、JSON payload 解析失败）
 * 3  认证失败：401（凭据缺失/过期且 401 自愈失败）→ 运行 acf login
 * 4  网络失败：连接不通/超时/DNS → 检查 --api-url / ACF_API_URL
 * 130 中断（SIGINT / Ctrl+C，128+2 惯例）
 */
export const EXIT_CODES = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  AUTH: 3,
  NETWORK: 4,
  INTERRUPTED: 130,
} as const;

/**
 * 本地参数/负载层面的用法错误。与服务端拒绝区分开，让脚本能区分
 * 「我的命令写错了（2）」和「服务端没答应（1）」。命令层抛出本类型，
 * exitCodeFor 统一识别，不需要每个 catch 各自判断。
 */
export class UsageError extends Error {}

/** spinner 的最小结构面（ora 实例天然满足），避免 ui 层反向依赖 ora。 */
interface Failable {
  fail?(message?: string): unknown;
  /** `--json` 失败时用它收尾：不能把 "✗ scope" 这行人读文本写进 JSON stderr。 */
  stop?(): unknown;
}

/**
 * Map a thrown error to its exit code. `UsageError`（本地用法错误）优先——
 * 它不是 axios 错误，若先走 classifyApiError 会被误归为 GENERIC。
 */
export function exitCodeFor(e: unknown): number {
  if (e instanceof UsageError) return EXIT_CODES.USAGE;
  switch (classifyApiError(e)) {
    case 'auth':
      return EXIT_CODES.AUTH;
    case 'network':
      return EXIT_CODES.NETWORK;
    default:
      return EXIT_CODES.GENERIC;
  }
}

/**
 * 取值型选项（`option('<flag> <placeholder>')` 形态，值是一段任意字符串）。
 *
 * 为什么要这张表：`--json` 只有作为**独立开关 token** 才代表「JSON 输出模
 * 式」。而 `--description <text>` / `--note <text>` / `--body <json>` 的取值
 * 完全可能是字面量 `--json`（`acf task update t1 --description '--json'`），
 * 旧实现 `argv.includes('--json')` 会把这种取值当成开关，整条 CLI 的错误输出
 * 面就从人读文案翻成 JSON。
 *
 * 只列**长**选项与单字母短选项；`--flag=value` 由调用方按 `=` 跳过（见下）。
 * 新增取值型选项时同步补这里（漏补只会回到旧行为，不会破坏既有调用）。
 */
const VALUE_TAKING_OPTIONS: ReadonlySet<string> = new Set([
  '-a', '-e', '-f', '-k', '-m', '-n', '-o', '-p', '-s',
  '--action', '--api-url', '--application', '--body', '--code',
  '--description', '--end-time', '--env', '--executor', '--executors',
  '--file', '--from-line', '--ids', '--kind', '--keyword', '--language',
  '--limit', '--name', '--note', '--output', '--page', '--page-size',
  '--params', '--password', '--reason', '--resource', '--runtime', '--scope',
  '--search', '--start-command', '--start-time', '--status', '--strategy',
  '--tail', '--token', '--url', '--user', '--user-id', '--username', '--version',
]);

/**
 * 当前进程是不是 `--json` 调用（决定失败时给人读文案还是结构化 JSON）。
 *
 * 为什么读 argv 而不是让 70 多个 `emitError` 调用点各自传 opts.json：那些
 * 调用点分布在 10 个命令文件里、且多数 catch 块拿不到 opts（action 形参各不
 * 相同），逐个补参既是一次大 diff，也必然漏掉几处（漏一处就是"某个命令的
 * --json 错误不是 JSON"）。argv 是**唯一**能覆盖全部出口的位置。
 *
 * P3（本轮）：只认**独立选项 token**——① `--opt=value` 是单 token 形态（值不
 * 会独立成 token，`--json=false` 也因此保持既有「非 JSON 模式」语义）；② 取
 * 值型选项后面的那个 token 是值，跳过。
 */
export function isJsonInvocation(
  argv: readonly string[] = process.argv,
): boolean {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token.includes('=')) continue;
    if (VALUE_TAKING_OPTIONS.has(token)) {
      i += 1; // 跳过该选项的值（即便它字面量是 "--json"）
      continue;
    }
    if (token === '--json') return true;
  }
  return false;
}

/**
 * 把一行文本**同步**写到 stderr（fd 2，短写自动续写）。
 *
 * 为什么不用 `console.error` / `process.stderr.write`：二者是流写入，在管道
 * 或文件（非阻塞/异步队列）下，紧随其后的 `process.exit()` 会丢掉尚未 flush
 * 的尾部——`--json` 的机读契约（stderr 必须是一行可 parse 的 JSON）随之破
 * 裂。`writeSync` 把字节直接交给内核，退出前必定落地。
 *
 * 为什么不干脆只用 `process.exitCode`（exec.ts / tasks.ts 的口径）：错误出口
 * 必须**同步终止**调用方的 action —— tasks.ts 的 `--wait` 轮询在 catch 里调
 * emitError 表示「确定性失败，别再轮询」，若它只是返回，401 会被轮询拖成
 * 「超时」。因此保留 exit，但把写操作换成不可丢的同步写。
 */
function writeStderrSyncLine(line: string): void {
  const fd = typeof process.stderr.fd === 'number' ? process.stderr.fd : 2;
  const buf = Buffer.from(`${line}\n`, 'utf8');
  let offset = 0;
  try {
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    }
  } catch {
    // stderr 已关闭（EPIPE/EBADF）：还能怎样，按原退出码收场即可——不能让
    // 错误出口自己抛异常，那会把退出码改写成 1。
  }
}

/**
 * `--json` 失败时的结构化错误体（字段名与 admin-api 错误响应体对齐：
 * `code` = HTTP 状态、`errorCode` = 稳定码、`params` = 插值参数）。
 *
 * 只写入**存在**的键（无码时不出现 `errorCode`），脚本用 `!== undefined`
 * 或 `in` 都能可靠判断；`exitCode` 与进程真实退出码同源（exitCodeFor）。
 */
export function apiErrorToJson(
  scope: string,
  e: unknown,
): Record<string, unknown> {
  const info = extractApiErrorInfo(e);
  const category = classifyErrorCode(info.errorCode);
  const payload: Record<string, unknown> = { ok: false, scope };
  if (info.status !== undefined) payload['code'] = info.status;
  if (info.errorCode !== undefined) payload['errorCode'] = info.errorCode;
  if (category !== null) payload['category'] = category;
  if (info.params !== undefined) payload['params'] = info.params;
  payload['message'] =
    info.message ?? (e instanceof Error ? e.message : String(e));
  payload['exitCode'] = exitCodeFor(e);
  return payload;
}

/**
 * 统一错误出口。有 spinner 时 `spinner.fail(scope)`（失败行与进行中的转圈
 * 原位收尾）；无 spinner 时打 `✗ scope`。错误详情一律走 formatApiError，
 * 保证 401/网络/后端 message 的呈现全 CLI 一致。
 *
 * R31-E1: `--json` 调用（或显式 `opts.json`）改为往 **stderr** 打一行结构化
 * JSON（含 `errorCode` / `params` / `code` / `exitCode`），stdout 仍只留
 * 成功载荷（CI 的 `| jq` 不被污染）；无码时该键不出现，其余语义（退出码、
 * 人类可读输出的文案）完全不变。
 */
export function emitError(
  scope: string,
  e: unknown,
  opts: { spinner?: Failable; json?: boolean } = {},
): never {
  const json = opts.json ?? isJsonInvocation();
  if (json) {
    // 不调 fail(scope)：那会把 "✗ scope" 这人读行混进 JSON stderr。
    if (opts.spinner) opts.spinner.stop?.();
    // P3（本轮）：同步写 fd 2 而不是 console.error —— 见 writeStderrSyncLine
    // 的注释（管道/文件下未 flush 的尾部会被下面的 exit 丢掉）。
    writeStderrSyncLine(JSON.stringify(apiErrorToJson(scope, e)));
  } else {
    if (opts.spinner) {
      opts.spinner.fail?.(scope);
    } else {
      console.error(chalk.red(`✗ ${scope}`));
    }
    console.error(chalk.red(formatApiError(e)));
  }
  process.exit(exitCodeFor(e));
}

/**
 * 本地用法错误出口（不涉及 API 调用）。第二条提示固定指向 `--help`——
 * 每个叶子命令的帮助里都有示例，用户不需要去翻文档。
 */
export function emitUsageError(message: string): never {
  console.error(chalk.red(`✗ ${message}`));
  console.error(chalk.gray("Run the command with '--help' to see usage and examples."));
  process.exit(EXIT_CODES.USAGE);
}

/**
 * 中断（SIGINT / Ctrl+C）统一出口：补一个换行让被 spinner/提示符啃掉一半的
 * 输出行完整落地，退出码 130。进程级 handler 与交互 readline 的 raw 模式
 * `rl.on('SIGINT')` 共用这一个出口。
 */
export function interruptExit(): never {
  process.stderr.write('\n');
  process.exit(EXIT_CODES.INTERRUPTED);
}

/**
 * 破坏性操作的交互确认 —— 三处 delete 此前各自内联 readline.question，
 * 在 stdin 非交互（agent / CI / `< NUL`）时会**静默假绿**：
 *
 *   $ acf app delete <id> < NUL
 *   Delete application <id>? [y/N]        <- 提示打出后立刻 EOF
 *   $ echo $?                             -> 0，且既无 "Aborted." 也无错误行
 *
 * 后果是自动化面最危险的一类失败：agent 把「什么都没删」读成「删除成功」，
 * 继续跑下游步骤。根因是 readline 在 EOF 时以空串 resolve（不是 reject），
 * 调用方的 `/^y(es)?$/` 判否后走 "Aborted." 分支——而该分支在 Windows 上
 * 连输出都会丢，进程以 0 收场。
 *
 * 语义（与 login 的 TOTP 非交互分支同一思路，收敛到一处）：
 * - `--yes` 给定 → 直接放行，不碰 stdin（脚本显式表态的唯一通路）；
 * - stdin 非 TTY → **拒绝**并给可操作错误（UsageError → 退出码 2）。既不
 *   静默通过（会误删）也不静默取消（会假绿）；
 * - stdin 是 TTY → 交互提问；除 y/yes 外一律视为主动放弃，返回 false，
 *   由调用方原样 return（退出码 0 —— README 已把「主动放弃确认」归入成功）。
 *
 * @returns true = 继续执行；false = 用户主动放弃（调用方应直接 return）。
 */
export async function confirmDestructive(
  question: string,
  opts: { yes?: boolean } = {},
): Promise<boolean> {
  if (opts.yes) return true;
  if (process.stdin.isTTY !== true) {
    emitUsageError(
      'Confirmation cannot be read: stdin is not interactive. ' +
        'Re-run with --yes (-y) to confirm this destructive operation in non-interactive use ' +
        '(CI / agent / piped stdin).',
    );
  }
  const readline = await import('readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // raw 模式下 Ctrl+C 触发 rl 'SIGINT' 而非进程信号；无监听只会 pause，
  // 确认提示处会假死。接住并走统一中断出口（130）。
  rl.on('SIGINT', () => interruptExit());
  let answer: string;
  try {
    answer = await rl.question(`${question} [y/N] `);
  } finally {
    rl.close();
  }
  if (!/^y(es)?$/i.test(answer)) {
    console.log(chalk.yellow('Aborted.'));
    return false;
  }
  return true;
}
