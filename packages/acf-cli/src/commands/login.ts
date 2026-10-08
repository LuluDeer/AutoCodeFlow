import { Command } from 'commander';
import * as readline from 'readline';
import ora from 'ora';
import axios from 'axios';
import { post, get, resetClient } from '../client.js';
import { setApiUrl, setToken, setRefreshToken, showConfig, getApiUrl, clearAuth } from '../config.js';
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

/**
 * 交互式密码输入（回显遮蔽）。非交互路径不再走这里——由 promptOrFail 在
 * 更外层拦下并提示改用 ACF_PASSWORD（见 login action 的 password 分支）。
 */
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

/**
 * P0（CLI-AGENT-UX-AUDIT）：登录地址解析的单一事实源（导出供单测）。
 *
 * 优先级：显式 `--url` > `ACF_API_URL` env > 已存配置 > 内置默认值。
 * 前两者与磁盘配置都由 getApiUrl() 归一（其自身就是 env || store），
 * 因此这里只需在「显式 --url」与「其余」之间分流。
 *
 * 关键点：**不再对地址发交互 prompt**。地址有合理默认值，为它中断整条登录
 * 在自动化面只会制造困惑（旧行为下 agent 会拿到空串兜底的默认地址 + 假 exit 0）。
 */
export function resolveLoginUrl(explicit?: string): string {
  return explicit?.trim() || getApiUrl() || 'http://localhost:3105';
}

/**
 * P0（CLI-AGENT-UX-AUDIT）：非交互下需要人工输入时给出**可操作**的用法错误，
 * 而不是让 prompt 拿到 EOF 空串后静默继续。契约与 resolveTotpCode 的
 * 「stdin 非交互且缺 --code」分支完全一致（UsageError → 退出码 2）。
 *
 * @param question 交互提示语
 * @param alternative 非交互时应改用的旗标/环境变量（写进错误消息）
 */
export async function promptOrFail(
  question: string,
  alternative: string,
  promptFn: (question: string) => Promise<string> = prompt,
): Promise<string> {
  if (process.stdin.isTTY !== true) {
    throw new UsageError(
      `Cannot prompt for "${question.trim()}" — stdin is not interactive. ` +
        `Provide it with ${alternative} instead (required for CI / agent use).`,
    );
  }
  return promptFn(question);
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
        // P0（CLI-AGENT-UX-AUDIT）：URL 解析优先级此前是 `--url || prompt`——
        // 只要没传 --url 就一定发问，即便 ACF_API_URL / 磁盘配置已经给了地址。
        // stdin 非交互（agent / CI / `< NUL`）时 prompt 拿到空串、被
        // `|| 'http://localhost:3105'` 兜底，后续 username/password 同样问不出来，
        // 进程在某个 prompt 处静默 exit 0——**agent 以为自己登录成功了**，而
        // 落盘的 token 是空的，错误被推迟到下一个命令的 401 才暴露。
        //
        // 收敛为纯函数（可单测）：显式 --url > ACF_API_URL > 已存配置 > 默认值。
        // 只有四者都拿不到「非默认」地址、且 stdin 是 TTY 时才会问人；非 TTY
        // 一律用默认值继续（地址本就有合理默认，不该因为它中断整条登录）。
        const url = resolveLoginUrl(opts.url);
        setApiUrl(url.trim());
        resetClient();

        // 非交互下 username 无法发问：此时必须由 --user 提供，否则可操作报错
        // （与 TOTP 的 --code 同款契约），不再静默拿到空用户名。
        const username = opts.user || (await promptOrFail('Username: ', '--user <username>'));

        // PK-27 凭据来源优先级：--password（deprecated，告警） > ACF_PASSWORD env > 隐藏交互 prompt。
        let password: string;
        if (opts.password) {
          process.stderr.write(
            chalk.yellow('⚠ --password is visible in the process list and shell history — prefer ACF_PASSWORD env in CI.\n'),
          );
          password = opts.password;
        } else if (process.env.ACF_PASSWORD) {
          password = process.env.ACF_PASSWORD;
        } else {
          // 非交互下必须走 ACF_PASSWORD env（不进 argv、不落 shell history），
          // 不能退化成「问不出来就空密码发一次必然 401 的请求」。
          // 交互路径继续用 hiddenPrompt —— PK-27 的回显遮蔽不能因这次改造丢掉。
          if (process.stdin.isTTY !== true) {
            throw new UsageError(
              'Cannot prompt for the password — stdin is not interactive. ' +
                'Provide it with the ACF_PASSWORD environment variable instead (required for CI / agent use).',
            );
          }
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

/**
 * P1（CLI-AGENT-UX-AUDIT）：`acf whoami` —— 打印当前凭据的身份与角色。
 *
 * 为什么 agent 需要它：后端有大量 ADMIN-only 面（audit / sop / notification /
 * agent / executor-packages 全模块，以及所有应用写操作）。此前 agent 无法在
 * 开工前自检权限，只能靠「调用 → 403」逐个试错。profile 返回的是 AuthUser，
 * 其中 `role` 是**单值**（不是 roles 数组），ADMIN 判定按此单值。
 */
export function whoamiCommand(): Command {
  return new Command('whoami')
    .description('Show the identity and role behind the current credential (preflight before ADMIN-only commands)')
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (opts: { json?: boolean }) => {
      const spinner = ora('Fetching profile…').start();
      try {
        const me = await get<{
          id?: number;
          username?: string;
          role?: string;
          email?: string;
        }>('/auth/profile');
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(me, null, 2));
          return;
        }
        const isAdmin = me?.role === 'admin' || me?.role === 'ADMIN';
        console.log(chalk.bold('Current identity'));
        console.log('  Username :', me?.username ?? '-');
        console.log('  User ID  :', me?.id ?? '-');
        console.log('  Role     :', isAdmin ? chalk.yellow(me?.role) : (me?.role ?? '-'));
        console.log('  Email    :', me?.email ?? '-');
        console.log('  API URL  :', getApiUrl());
        if (!isAdmin) {
          console.log(
            chalk.gray(
              '  (not an ADMIN — audit / sop / notification / agent / executor-packages and application writes will answer 403)',
            ),
          );
        }
      } catch (e: unknown) {
        emitError('Failed to fetch profile', e, { spinner });
      }
    });
}

/**
 * P1（CLI-AGENT-UX-AUDIT）：`acf logout` —— 服务端吊销 refresh token 家族的
 * 同时清空本地凭据。
 *
 * 为什么 agent 需要它：access + refresh **双 token** 都落在磁盘 0600 文件里，
 * refresh 是长效的。共享机器 / 一次性容器上跑完不清，等于把一枚长效凭证留在
 * 盘上。此前面只有「再 login 一次覆盖」，没有出口。
 *
 * 语义：先尽力通知服务端（revoke all refresh tokens），**网络失败也照常清本地**
 * ——本地凭据必须确保被抹掉，不能因为服务端不可达就把 token 留在盘上。
 */
export function logoutCommand(): Command {
  return new Command('logout')
    .description('Revoke the session server-side and clear the locally stored credentials')
    .action(async () => {
      // ⚠ 顺序至关重要：client 的请求拦截器是**逐请求**读 token 的
      //（client.ts request interceptor → getToken()），所以必须先带着 token
      // 完成服务端吊销，**再**清本地。反过来（先 clearAuth 再 POST）会让注销
      // 请求不带 Authorization 头 → 必然 401 → 服务端吊销实际从未发生。
      let warned = false;
      try {
        // POST /auth/logout —— 吊销该用户的全部 refresh token（服务端语义）。
        await post('/auth/logout');
      } catch (e) {
        // 401 = 本来就没登录 / token 已失效，没有可吊销的会话，属正常收尾，
        // 不打扰用户。其余（网络不可达 / 5xx）才值得告警——注意此时本地凭据
        // **仍然会被清掉**（下方 finally），不能因为服务端不可达就把 token 留盘。
        const status = axios.isAxiosError(e) ? e.response?.status : undefined;
        if (status !== 401) {
          warned = true;
          process.stderr.write(
            chalk.yellow(
              '⚠ Could not reach the API to revoke the session server-side (the access token may remain valid until it expires) — local credentials were still cleared.\n',
            ),
          );
        }
      } finally {
        // 无论服务端结果如何，盘上的凭据都必须抹掉。
        clearAuth();
      }
      if (!warned) console.log(chalk.green('✔ Logged out — local credentials cleared'));
      else console.log(chalk.green('✔ Local credentials cleared'));
    });
}
