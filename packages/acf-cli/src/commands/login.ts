import { Command } from 'commander';
import * as readline from 'readline';
import { post, formatApiError } from '../client';
import { setApiUrl, setToken, setRefreshToken, showConfig } from '../config';
import { resetClient } from '../client';
import chalk from 'chalk';

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

export function loginCommand(): Command {
  const cmd = new Command('login')
    .description('Authenticate with the AutoCodeFlow API and save credentials')
    .option('--url <url>', 'API base URL (default: http://localhost:3105)')
    .option('--user <username>', 'Username')
    .option('--password <password>', 'Password')
    .action(async (opts) => {
      try {
        const url = opts.url || await prompt('API URL [http://localhost:3105]: ') || 'http://localhost:3105';
        setApiUrl(url.trim());
        resetClient();

        const username = opts.user || await prompt('Username: ');
        const password = opts.password || await prompt('Password: ');

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
