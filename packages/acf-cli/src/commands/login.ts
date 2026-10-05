import { Command } from 'commander';
import * as readline from 'readline';
import { post, resetClient } from '../client.js';
import { setApiUrl, setToken, setRefreshToken, showConfig } from '../config.js';
import { emitError, interruptExit, UsageError } from '../ui.js';
import chalk from 'chalk';

/**
 * admin-api 认证响应形状（camelCase）：
 * - 普通登录 → { accessToken, refreshToken }；
 * - SEC-03 已启用 TOTP 的用户 → 200 + { totpRequired: true }（不发 token，
 *   契约刻意为 200 而非 401，避免与「密码错误」混淆——见 docs/api-reference.md
 *   「TOTP 两步验证语义约定」）。二段登录走 POST /auth/totp/verify。
 */
interface LoginTokens {
  accessToken: string;
  refreshToken?: string;
}
type LoginResponse = LoginTokens | { totpRequired: true };

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // readline 终端模式（raw mode）下 Ctrl+C 不产生进程级 SIGINT 信号，而是触发
  // rl 的 'SIGINT' 事件；若无监听，readline 只是 pause，login 会假死不退。
  // 这里显式接住，与全局中断出口同码（130）。
  rl.on('SIGINT', () => interruptExit());
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

// PK-27（DEEP_REVIEW 0ef3bbe）：交互式密码输入必须隐藏回显（否则旁窥/录屏即泄漏）。
// 用 readline 的 _writeToOutput 覆盖把回显吞掉——这是 Node 生态隐藏密码的标准做法，
// 不引入额外依赖。TTY 非交互（CI/管道）时退化为普通 question（无回显需求，因为
// 此时密码应来自 --password 或 ACF_PASSWORD env，而非人工键入）。
//
// UX 打磨（本轮）：遮蔽逻辑抽成独立函数并导出——「密码不回显」是安全语义，
// 值得一个函数级不回显断言（ux-uniform.test.ts），内联在闭包里则测不到。
export function maskEcho(rl: readline.Interface, isTTY: boolean = process.stdin.isTTY === true): void {
  if (!isTTY) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rlAny = rl as any;
  const out: NodeJS.WriteStream = rlAny.output;
  rlAny._writeToOutput = (str: string) => {
    // 只回显提示符的换行，不回显键入字符；退格/回车照常处理。
    if (str === '\n') out.write('\n');
    else if (str === '\r') out.write('\n');
    else out.write('');
    return '';
  };
}

function hiddenPrompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // 同上：raw 模式 Ctrl+C 显式接住，避免密码输入中 Ctrl+C 假死。
  rl.on('SIGINT', () => interruptExit());
  maskEcho(rl);
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    }),
  );
}

// 6 位码形态校验（TOTP 契约：HMAC-SHA1/6 位数字）。本地只判「形态」，
// 码对不对由服务端 /auth/totp/verify 判（错码 → 401 → 退出码 3）。
function assertTotpCodeFormat(code: string, source: '--code' | 'prompt'): void {
  if (!/^\d{6}$/.test(code)) {
    const label = source === '--code' ? '--code' : 'Expected';
    throw new UsageError(
      source === '--code'
        ? `${label} must be a 6-digit TOTP code (got "${code}")`
        : `${label} a 6-digit TOTP code (got "${code}")`,
    );
  }
}

// SEC-03：TOTP 登录第二段的 6 位码获取。
// - --code 提供 → 直接使用（CI/非交互场景，不碰 stdin）；
// - 未提供且 stdin 非交互（TTY 检测，与 maskEcho 同判据）→ 可操作报错
//   （UsageError → 退出码 2），明示如何用 --code 完成；
// - 其余 → 交互式 prompt（6 位码是一次性短效凭证，不需要像密码那样遮蔽回显）。
// 本地形态错误一律 throw UsageError（而非 emitUsageError）：调用方 login 的
// action 在 try/catch 里统一走 emitError 出口，UsageError 会被映射到退出码 2
//（与 task create --file 的本地 payload 错误同一套路）。
// 导出供单测注入 promptFn（TTY 交互路径无法在测试里驱动真实 stdin）。
export async function resolveTotpCode(
  opts: { code?: string },
  promptFn: (question: string) => Promise<string> = prompt,
): Promise<string> {
  if (opts.code) {
    const code = opts.code.trim();
    assertTotpCodeFormat(code, '--code');
    return code;
  }
  if (process.stdin.isTTY !== true) {
    throw new UsageError(
      'This account has TOTP enabled and stdin is not interactive (no prompt can be shown). ' +
        'Pass the 6-digit code with --code <code>, e.g. acf login --user admin --code 123456.',
    );
  }
  const code = (await promptFn('TOTP code (6 digits): ')).trim();
  assertTotpCodeFormat(code, 'prompt');
  return code;
}

export function loginCommand(): Command {
  const cmd = new Command('login')
    .description('Authenticate with the AutoCodeFlow API and save credentials')
    .option('--url <url>', 'API base URL (default: http://localhost:3105)')
    .option('--user <username>', 'Username')
    // PK-27（DEEP_REVIEW 0ef3bbe）：--password 明文会进 ps/shell history，标记 deprecated。
    // 仍保留以便一次性容器/CI 用（此时 ACF_PASSWORD env 更推荐，不进进程 argv）。
    .option('--password <password>', 'Password (DEPRECATED: visible in process list & shell history; prefer interactive hidden prompt or ACF_PASSWORD env)')
    // SEC-03：TOTP 二段登录的 6 位动态码。交互终端下可省略（会 prompt）；
    // CI/非交互场景必须提供（stdin 非 TTY 且无 --code 时直接报用法错误）。
    .option('--code <code>', '6-digit TOTP code (second factor). Required in non-interactive sessions when the account has TOTP enabled')
    .action(async (opts) => {
      try {
        const url = opts.url || await prompt('API URL [http://localhost:3105]: ') || 'http://localhost:3105';
        setApiUrl(url.trim());
        resetClient();

        const username = opts.user || await prompt('Username: ');

        // PK-27 凭据来源优先级：--password（deprecated，告警） > ACF_PASSWORD env > 隐藏交互 prompt。
        let password: string;
        if (opts.password) {
          process.stderr.write(
            chalk.yellow('⚠ --password 会出现在进程列表与 shell 历史中；CI 场景请改用 ACF_PASSWORD 环境变量。\n'),
          );
          password = opts.password;
        } else if (process.env.ACF_PASSWORD) {
          password = process.env.ACF_PASSWORD;
        } else {
          password = await hiddenPrompt('Password: ');
        }

        // --code 形态本地预检（在发起任何网络请求之前）：坏格式直接报用法错误，
        // 不消耗服务端登录限流（login 20/min、totp/verify 10/min 都是稀缺预算）。
        if (opts.code) assertTotpCodeFormat(String(opts.code).trim(), '--code');

        // admin-api auth.service.generateTokens returns camelCase { accessToken, refreshToken }.
        // SEC-03: TOTP 已启用用户返回 200 + { totpRequired: true }（无 token），
        // 进入二段流程：username+password+code 复验后签发双 token。
        const data = await post<LoginResponse>('/auth/login', {
          username: username.trim(),
          password,
        });

        let tokens: LoginTokens;
        if ('accessToken' in data && data.accessToken) {
          tokens = data;
        } else if ((data as { totpRequired?: boolean }).totpRequired === true) {
          const code = await resolveTotpCode(opts);
          // 契约（api-reference.md / TotpVerifyDto）：{ username, password, code }，
          // 响应与普通登录同形（双 token）。错码 → 401（计入登录失败锁定），
          // 走下方统一的 Login failed 错误出口（退出码 3）。
          tokens = await post<LoginTokens>('/auth/totp/verify', {
            username: username.trim(),
            password,
            code,
          });
        } else {
          throw new Error('Login response missing accessToken (unexpected auth payload)');
        }

        setToken(tokens.accessToken);
        // BUG-13: refreshToken 一并入库——access token 默认 15m 过期，
        // client 的 401 单飞自愈（/auth/refresh + 重放一次）依赖它，
        // 否则过期后全命令 401 只能重新 login。
        setRefreshToken(tokens.refreshToken ?? '');
        console.log(chalk.green('✔ Logged in successfully'));
        showConfig();
      } catch (e: unknown) {
        // 统一错误出口：401（密码错/TOTP 码错/token 失效）→ 退出码 3，
        // 网络不通 → 4，其余 → 1（见 ui.ts 的 EXIT_CODES 表）。
        emitError('Login failed', e);
      }
    });
  return cmd;
}
