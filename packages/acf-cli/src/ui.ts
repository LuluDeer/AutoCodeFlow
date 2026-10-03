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
import { classifyApiError, formatApiError } from './client.js';

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
  fail(message?: string): unknown;
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
 * 统一错误出口。有 spinner 时 `spinner.fail(scope)`（失败行与进行中的转圈
 * 原位收尾）；无 spinner 时打 `✗ scope`。错误详情一律走 formatApiError，
 * 保证 401/网络/后端 message 的呈现全 CLI 一致。
 */
export function emitError(
  scope: string,
  e: unknown,
  opts: { spinner?: Failable } = {},
): never {
  if (opts.spinner) {
    opts.spinner.fail(scope);
  } else {
    console.error(chalk.red(`✗ ${scope}`));
  }
  console.error(chalk.red(formatApiError(e)));
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
