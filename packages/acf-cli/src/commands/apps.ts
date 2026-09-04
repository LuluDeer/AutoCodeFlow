import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import { get, post, put, del, formatApiError } from '../client';

interface Application {
  id: string;
  name: string;
  status: string;
  version?: string;
  runtime?: string;
  gitRepo?: string;
  gitBranch?: string;
  gitCommit?: string;
  description?: string;
  entrypoint?: string;
  packageUrl?: string;
}

interface Deployment {
  id: string;
  applicationId: string;
  executorId?: string;
  status: string;
  runMode?: string;
}

function statusColor(s: string): string {
  if (s === 'running') return chalk.green(s);
  if (s === 'stopped') return chalk.gray(s);
  if (s === 'error' || s === 'failed') return chalk.red(s);
  if (s === 'deploying') return chalk.cyan(s);
  return chalk.yellow(s);
}

/** Load a JSON payload from --file (preferred) or --json. */
async function loadJsonBody(json?: string, file?: string): Promise<unknown> {
  const fs = await import('fs/promises');
  const raw = file ? await fs.readFile(file, 'utf-8') : json;
  if (raw === undefined) {
    throw new Error('Missing JSON payload (provide --json or --file)');
  }
  try {
    return JSON.parse(raw);
  } catch (e: unknown) {
    throw new Error(`Invalid JSON payload: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function appsCommand(): Command {
  const cmd = new Command('app').description('Manage applications');

  // acf app list
  cmd.command('list')
    .description('List all applications')
    .action(async () => {
      const spinner = ora('Fetching applications…').start();
      try {
        const data = await get<{ list: Application[]; total: number }>('/applications');
        spinner.stop();
        const apps: Application[] = Array.isArray(data) ? data : (data.list ?? []);
        const table = new Table({
          head: ['ID', 'Name', 'Status', 'Version', 'Git Repo', 'Branch'],
          colWidths: [14, 26, 12, 10, 28, 14],
          style: { head: ['cyan'] },
        });
        for (const a of apps) {
          table.push([
            a.id.slice(0, 12),
            a.name,
            statusColor(a.status),
            a.version ?? '-',
            a.gitRepo ?? '-',
            a.gitBranch ?? '-',
          ]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        spinner.fail('Failed to list applications');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf app get <id>
  cmd.command('get <id>')
    .description('Show application details')
    .action(async (id) => {
      const spinner = ora('Fetching application…').start();
      try {
        const a = await get<Application>(`/applications/${id}`);
        spinner.stop();
        console.log(chalk.bold('Application Details'));
        console.log('  ID          :', a.id);
        console.log('  Name        :', a.name);
        console.log('  Status      :', statusColor(a.status));
        console.log('  Version     :', a.version ?? '-');
        console.log('  Runtime     :', a.runtime ?? '-');
        console.log('  Git Repo    :', a.gitRepo ?? '-');
        console.log('  Git Branch  :', a.gitBranch ?? '-');
        console.log('  Git Commit  :', a.gitCommit ?? '-');
        console.log('  Entrypoint  :', a.entrypoint ?? '-');
        console.log('  Package URL :', a.packageUrl ?? '-');
        console.log('  Description :', a.description ?? '-');
      } catch (e: unknown) {
        spinner.fail('Failed');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf app create
  cmd.command('create')
    .description('Create an application (JSON payload via --json or --file; required: name, version, runtime)')
    .requiredOption('--json <body>', 'Application body as JSON string')
    .option('--file <path>', 'Read application body from a JSON file (overrides --json)')
    .action(async (opts) => {
      const spinner = ora('Creating application…').start();
      try {
        const body = await loadJsonBody(opts.json, opts.file);
        const a = await post<Application>('/applications', body);
        spinner.succeed(`Application created: ${a.id}`);
        console.log(chalk.gray(`  name: ${a.name}  version: ${a.version ?? '-'}  status: ${statusColor(a.status)}`));
      } catch (e: unknown) {
        spinner.fail('Failed to create application');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf app update <id>
  cmd.command('update <id>')
    .description(
      'Update an application (JSON payload via --json or --file). ' +
        'Accepted fields: description, version, runtime, status, gitRepo, gitBranch, gitCommit, manifest, env, entrypoint, packageUrl, webhookSecret. ' +
        'NOTE: the backend UpdateApplicationDto has no `name` field — renaming is not supported.',
    )
    .requiredOption('--json <body>', 'Application patch body as JSON string')
    .option('--file <path>', 'Read application patch body from a JSON file (overrides --json)')
    .action(async (id, opts) => {
      const spinner = ora('Updating application…').start();
      try {
        const body = (await loadJsonBody(opts.json, opts.file)) as Record<string, unknown>;
        // UpdateApplicationDto has no `name` — with forbidNonWhitelisted the
        // API would answer 400 "property name should not exist". Fail early
        // with an actionable message instead.
        if (body && typeof body === 'object' && 'name' in body) {
          throw new Error(
            'Application update does not support renaming: the backend UpdateApplicationDto has no `name` field. ' +
              'Remove "name" from the payload.',
          );
        }
        const a = await put<Application>(`/applications/${id}`, body);
        spinner.succeed(`Application updated: ${a.id}`);
        console.log(chalk.gray(`  name: ${a.name}  version: ${a.version ?? '-'}  status: ${statusColor(a.status)}`));
      } catch (e: unknown) {
        spinner.fail('Failed to update application');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf app delete <id>
  cmd.command('delete <id>')
    .description('Delete an application')
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .action(async (id, opts) => {
      if (!opts.yes) {
        const readline = await import('readline/promises');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(`Delete application ${id}? [y/N] `);
        rl.close();
        if (!/^y(es)?$/i.test(answer)) {
          console.log(chalk.yellow('Aborted.'));
          return;
        }
      }
      const spinner = ora('Deleting application…').start();
      try {
        await del(`/applications/${id}`);
        spinner.succeed(`Application ${id} deleted`);
      } catch (e: unknown) {
        spinner.fail('Failed to delete application');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf app analyze <id>
  cmd.command('analyze <id>')
    .description('Run AI health analysis on an application')
    .action(async (id) => {
      const spinner = ora('Running AI health analysis…').start();
      try {
        const result = await post<{
          appId: string;
          appName: string;
          analysis: string;
          stats: { totalTasks: number; avgSuccessRate: number; avgDuration: number; criticalTasks: string[] };
        }>(`/applications/${id}/analyze`);
        spinner.stop();
        console.log(chalk.bold(`\nAI Health Analysis — ${result.appName}`));
        console.log(chalk.gray('─'.repeat(60)));
        console.log(`  Total tasks     : ${result.stats.totalTasks}`);
        console.log(`  Avg success rate: ${chalk.green(result.stats.avgSuccessRate + '%')}`);
        console.log(`  Avg duration    : ${result.stats.avgDuration}ms`);
        if (result.stats.criticalTasks.length > 0) {
          console.log(`  Critical tasks  : ${chalk.red(result.stats.criticalTasks.join(', '))}`);
        }
        console.log();
        console.log(result.analysis);
      } catch (e: unknown) {
        spinner.fail('Analysis failed');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf app deploy <id>
  cmd.command('deploy <id>')
    .description('Deploy an application to an executor (auto-selects the lowest-load online executor when --executor is omitted)')
    .option('-e, --executor <executorId>', 'Pin to a specific executor')
    .option('-m, --run-mode <mode>', 'Run mode: once | daemon | scheduled', 'daemon')
    .option('--env <json>', 'Env var overrides as JSON, e.g. \'{"KEY":"value"}\'')
    .option('--start-command <cmd>', 'Startup command override (defaults to manifest entrypoint)')
    .action(async (id, opts) => {
      const spinner = ora('Triggering deployment…').start();
      try {
        const body: Record<string, unknown> = { runMode: opts.runMode };
        if (opts.executor) body.executorId = opts.executor;
        if (opts.env) body.env = JSON.parse(opts.env);
        if (opts.startCommand) body.startCommand = opts.startCommand;
        const dep = await post<{ id?: string; status?: string; executorId?: string }>(
          `/app-deployments/applications/${id}/deploy`,
          body,
        );
        spinner.succeed('Deployment triggered');
        console.log(chalk.gray(`  deployment: ${dep?.id ?? '-'}  status: ${dep?.status ?? '-'}  executor: ${dep?.executorId ?? 'auto'}`));
      } catch (e: unknown) {
        spinner.fail('Deployment failed');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf app deployments [appId]
  cmd.command('deployments [appId]')
    .description('List deployments (optionally filtered by application)')
    .option('-p, --page <n>', 'Page number', '1')
    .option('-n, --page-size <n>', 'Page size', '20')
    .action(async (appId, opts) => {
      const spinner = ora('Fetching deployments…').start();
      try {
        // app-deployment.service.findAll returns `{ data, total }`
        const data = await get<{ data?: Deployment[]; list?: Deployment[]; total?: number }>('/app-deployments', {
          ...(appId ? { applicationId: appId } : {}),
          page: opts.page,
          pageSize: opts.pageSize,
        });
        spinner.stop();
        const list: Deployment[] = Array.isArray(data) ? data : (data.data ?? data.list ?? []);
        const table = new Table({
          head: ['Deployment', 'App', 'Executor', 'Status', 'RunMode'],
          colWidths: [14, 14, 14, 12, 11],
          style: { head: ['cyan'] },
        });
        for (const d of list) {
          table.push([
            d.id.slice(0, 12),
            d.applicationId?.slice(0, 12) ?? '-',
            d.executorId?.slice(0, 12) ?? '-',
            statusColor(d.status),
            d.runMode ?? '-',
          ]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        spinner.fail('Failed to list deployments');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf app versions <id>
  cmd.command('versions <id>')
    .description('Show application version history')
    .action(async (id) => {
      const spinner = ora('Fetching version history…').start();
      try {
        // getVersionHistory returns `commit` / `deployedAt` (no gitCommit / changeNote)
        const versions = await get<
          Array<{ id: string; version: string; commit?: string; deployedAt?: string; createdAt?: string; status?: string }>
        >(`/applications/${id}/versions`);
        spinner.stop();
        const table = new Table({
          head: ['Version', 'Commit', 'Deployed', 'Status'],
          colWidths: [12, 14, 25, 12],
          style: { head: ['cyan'] },
        });
        for (const v of versions) {
          table.push([
            v.version,
            v.commit?.slice(0, 12) ?? '-',
            new Date(v.deployedAt ?? v.createdAt ?? '').toLocaleString(),
            v.status ?? '-',
          ]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        spinner.fail('Failed to list versions');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  return cmd;
}
