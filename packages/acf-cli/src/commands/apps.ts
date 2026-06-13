import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import { get, post } from '../client';

interface Application {
  id: string;
  name: string;
  status: string;
  gitRepo?: string;
  gitBranch?: string;
  description?: string;
}

function statusColor(s: string): string {
  if (s === 'running') return chalk.green(s);
  if (s === 'stopped') return chalk.gray(s);
  if (s === 'error' || s === 'failed') return chalk.red(s);
  if (s === 'deploying') return chalk.cyan(s);
  return chalk.yellow(s);
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
          head: ['ID', 'Name', 'Status', 'Git Repo', 'Branch'],
          colWidths: [14, 28, 12, 30, 15],
          style: { head: ['cyan'] },
        });
        for (const a of apps) {
          table.push([
            a.id.slice(0, 12),
            a.name,
            statusColor(a.status),
            a.gitRepo ?? '-',
            a.gitBranch ?? '-',
          ]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        spinner.fail('Failed to list applications');
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
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
        console.log('  Git Repo    :', a.gitRepo ?? '-');
        console.log('  Git Branch  :', a.gitBranch ?? '-');
        console.log('  Description :', a.description ?? '-');
      } catch (e: unknown) {
        spinner.fail('Failed');
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
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
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    });

  // acf app deploy <id>
  cmd.command('deploy <id>')
    .description('Trigger a deployment for an application')
    .requiredOption('--repo <gitRepo>', 'Git repository URL')
    .option('--branch <branch>', 'Git branch', 'main')
    .option('--commit <sha>', 'Git commit SHA')
    .action(async (id, opts) => {
      const spinner = ora('Triggering deployment…').start();
      try {
        await post(`/applications/${id}/deploy`, {
          gitRepo: opts.repo,
          gitBranch: opts.branch,
          gitCommit: opts.commit,
        });
        spinner.succeed('Deployment triggered');
      } catch (e: unknown) {
        spinner.fail('Deployment failed');
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    });

  return cmd;
}
