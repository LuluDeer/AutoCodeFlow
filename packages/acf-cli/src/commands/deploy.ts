import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { post, formatApiError } from '../client';

interface Deployment {
  id: string;
  applicationId?: string;
  executorId?: string;
  status: string;
  runMode?: string;
}

export function deployCommand(): Command {
  const cmd = new Command('deploy').description('Manage application deployments (upgrade / stop running instances)');

  // acf deploy upgrade <deploymentId>
  cmd.command('upgrade <deploymentId>')
    .description('Trigger an overlay upgrade for a running deployment (pulls the latest application version)')
    .action(async (deploymentId) => {
      const spinner = ora('Triggering upgrade…').start();
      try {
        // POST /app-deployments/:id/upgrade — AppDeploymentController.upgrade
        const dep = await post<Deployment>(`/app-deployments/${deploymentId}/upgrade`);
        spinner.succeed(`Upgrade triggered for deployment ${deploymentId}`);
        console.log(chalk.gray(`  status: ${dep?.status ?? '-'}  executor: ${dep?.executorId ?? '-'}`));
      } catch (e: unknown) {
        spinner.fail('Failed to trigger upgrade');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  // acf deploy stop <deploymentId>
  cmd.command('stop <deploymentId>')
    .description('Stop a running deployment')
    .action(async (deploymentId) => {
      const spinner = ora('Stopping deployment…').start();
      try {
        // POST /app-deployments/:id/stop — AppDeploymentController.stop
        const dep = await post<Deployment>(`/app-deployments/${deploymentId}/stop`);
        spinner.succeed(`Deployment ${deploymentId} stopped`);
        console.log(chalk.gray(`  status: ${dep?.status ?? '-'}`));
      } catch (e: unknown) {
        spinner.fail('Failed to stop deployment');
        console.error(chalk.red(formatApiError(e)));
        process.exit(1);
      }
    });

  return cmd;
}
