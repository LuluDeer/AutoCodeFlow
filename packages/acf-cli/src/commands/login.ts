import { Command } from 'commander';
import * as readline from 'readline';
import { post, formatApiError } from '../client.js';
import { setApiUrl, setToken, setRefreshToken, showConfig } from '../config.js';
import { resetClient } from '../client.js';
import chalk from 'chalk';

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

// PK-27（DEEP_REVIEW 0ef3bbe）：交互式密码输入必须隐藏回显（否则旁窥/录屏即泄漏）。
// 用 readline 的 _writeToOutput 覆盖把回显吞掉——这是 Node 生态隐藏密码的标准做法，
// 不引入额外依赖。TTY 非交互（CI/管道）时退化为普通 question（无回显需求，因为
// 此时密码应来自 --password 或 ACF_PASSWORD env，而非人工键入）。
function hiddenPrompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (process.stdin.isTTY) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rlAny = rl as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: NodeJS.WriteStream = rlAny.output;
    rlAny._writeToOutput = (str: string) => {
      // 只回显提示符的换行，不回显键入字符；退格/回车照常处理。
      if (str === '\n') out.write('\n');
      else if (str === '\r') out.write('\n');
      else out.write('');
      return '';
    };
  }
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    }),
  );
}

export function loginCommand(): Command {
  const cmd = new Command('login')
    .description('Authenticate with the AutoCodeFlow API and save credentials')
    .option('--url <url>', 'API base URL (default: http://localhost:3105)')
    .option('--user <username>', 'Username')
    // PK-27（DEEP_REVIEW 0ef3bbe）：--password 明文会进 ps/shell history，标记 deprecated。
    // 仍保留以便一次性容器/CI 用（此时 ACF_PASSWORD env 更推荐，不进进程 argv）。
    .option('--password <password>', 'Password (DEPRECATED: visible in process list & shell history; prefer interactive hidden prompt or ACF_PASSWORD env)')
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

        // admin-api auth.service.generateTokens returns camelCase { accessToken, refreshToken }
        const data = await post<{ accessToken: string; refreshToken?: string }>('/auth/login', {
          username: username.trim(),
          password,
        });

        if (!data.accessToken) {
          throw new Error('Login response missing accessToken (unexpected auth payload)');
        }
        setToken(data.accessToken);
        // BUG-13: refreshToken 一并入库——access token 默认 15m 过期，
        // client 的 401 单飞自愈（/auth/refresh + 重放一次）依赖它，
        // 否则过期后全命令 401 只能重新 login。
        setRefreshToken(data.refreshToken ?? '');
        console.log(chalk.green('✔ Logged in successfully'));
        showConfig();
      } catch (e: unknown) {
        console.error(chalk.red('✗ Login failed:'), formatApiError(e));
        process.exit(1);
      }
    });
  return cmd;
}
