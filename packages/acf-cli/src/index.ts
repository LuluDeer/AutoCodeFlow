#!/usr/bin/env node
/**
 * ACF CLI — AutoCodeFlow command-line interface
 *
 * Usage:
 *   acf login
 *   acf task list
 *   acf task trigger <id> --wait
 *   acf task versions <id> | compare <id> <v1> <v2> | rollback <id> --version <vid>
 *   acf task analyze <taskId> <execId>
 *   acf task suggest-schedule <id>
 *   acf app list | create | update <id> | delete <id>
 *   acf app analyze <id>
 *   acf deploy upgrade <deploymentId> | stop <deploymentId>
 *   acf executor list | get <id> | rotate <name|id> | offline <name|id>
 *   acf exec tail <execId>
 *   acf task lint <file>
 *   acf audit list
 *   acf config show
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { loginCommand } from './commands/login';
import { tasksCommand } from './commands/tasks';
import { appsCommand } from './commands/apps';
import { executorsCommand } from './commands/executors';
import { deployCommand } from './commands/deploy';
import { auditCommand } from './commands/audit';
import { execCommand } from './commands/exec';
import { projectsCommand } from './commands/projects';
import { showConfig, setApiUrl, setToken } from './config';
// 版本号单一事实源：直接读 package.json，而不是硬编码字面量。
//
// 原实现写死 `.version('1.0.0')`，而 package.json 是 `version-guard` 与
// release-please 唯一会 bump 的地方——两者必然漂移。实测证据：包名/版本改成
// `@autocodeflow/cli@1.4.3` 后，`npx acf --version` 仍打印 **1.0.0**。
// 这是发布物里最不该出错的一处：用户报 issue、我们排查兼容性、`acf` 自身
// 做版本相关的行为分支，读的都是这个数。
// `resolveJsonModule` 已在 tsconfig 打开；tsc 的 rootDir=src 会把 package.json
// 视为 src 之外的输入，故用 require 走运行时解析（发布物里 package.json 与
// dist/ 同级，路径稳定）。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json') as { version: string };

const program = new Command();

program
  .name('acf')
  .description('AutoCodeFlow CLI — manage tasks, executions, applications and projects')
  .version(pkg.version);

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
program.addCommand(tasksCommand());
program.addCommand(appsCommand());
program.addCommand(executorsCommand());
program.addCommand(deployCommand());
program.addCommand(auditCommand());
program.addCommand(execCommand());
program.addCommand(projectsCommand());

// acf config show / set
const configCmd = new Command('config').description('View or update CLI configuration');
configCmd.command('show').description('Show current config').action(() => showConfig());
configCmd.command('set-url <url>').description('Set API base URL').action((url) => {
  setApiUrl(url);
  console.log(chalk.green(`✔ API URL set to ${url}`));
});
configCmd.command('set-token <token>').description('Set auth token directly').action((token) => {
  setToken(token);
  console.log(chalk.green('✔ Token saved'));
});
program.addCommand(configCmd);

// Better error display
program.configureOutput({
  outputError: (str, write) => write(chalk.red(str)),
});

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(chalk.red('Error:'), e instanceof Error ? e.message : String(e));
  process.exit(1);
});
