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
 *   acf executor list | get <id>
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
import { showConfig, setApiUrl, setToken } from './config';

const program = new Command();

program
  .name('acf')
  .description('AutoCodeFlow CLI — manage tasks, executions and applications')
  .version('1.0.0');

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
