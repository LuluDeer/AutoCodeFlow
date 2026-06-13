import { Command } from 'commander';
import * as readline from 'readline';
import { post } from '../client';
import { setApiUrl, setToken, showConfig } from '../config';
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

        const data = await post<{ access_token: string }>('/auth/login', {
          username: username.trim(),
          password,
        });

        setToken(data.access_token);
        console.log(chalk.green('✔ Logged in successfully'));
        showConfig();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(chalk.red('✗ Login failed:'), msg);
        process.exit(1);
      }
    });
  return cmd;
}
