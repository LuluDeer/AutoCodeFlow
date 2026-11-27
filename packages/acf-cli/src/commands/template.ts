/**
 * `acf template` — browse server-side task templates and instantiate tasks
 * from them. Routes:
 *   GET  /task-templates
 *   POST /task-templates/:id/instantiate
 */
import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import { get, post } from '../client.js';
import { emitError, emitUsageError, UsageError } from '../ui.js';

interface TaskTemplate {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  category?: string | null;
  isOfficial?: boolean;
  config?: Record<string, unknown>;
}

interface InstantiatedTask {
  id: string;
  name: string;
  status: string;
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('expected a JSON object');
    }
    return value as Record<string, unknown>;
  } catch (err) {
    throw new UsageError(
      `Invalid ${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function templateCommand(): Command {
  const cmd = new Command('template').description(
    'Inspect task templates and create tasks from them',
  );

  cmd
    .command('list')
    .description('List official and custom task templates')
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (opts: { json?: boolean }) => {
      const spinner = ora('Fetching templates…').start();
      try {
        const rows = (await get<TaskTemplate[] | { items: TaskTemplate[] }>(
          '/task-templates',
        )) ?? [];
        spinner.stop();
        const list = Array.isArray(rows) ? rows : (rows.items ?? []);
        if (opts.json) {
          console.log(JSON.stringify(list, null, 2));
          return;
        }
        if (!list.length) {
          console.log(chalk.gray('No templates configured.'));
          return;
        }
        const table = new Table({
          head: ['Name', 'Key', 'Category', 'ID'],
        });
        for (const t of list) {
          table.push([
            t.name,
            t.key + (t.isOfficial ? ' (official)' : ''),
            t.category ?? '-',
            t.id,
          ]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        emitError('Failed to list templates', e, { spinner });
      }
    });

  cmd
    .command('use <id>')
    .description('Create a task from a template (name is required)')
    .option('--name <name>', 'Name for the new task')
    .option('--body <json>', 'Override fields merged on top of the template config')
    .option('--json', 'Emit the created task as JSON')
    .action(async (id: string, opts: { name?: string; body?: string; json?: boolean }) => {
      if (!opts.name) emitUsageError('Missing required --name <name>');
      const overrides = opts.body ? parseJsonObject(opts.body, '--body JSON') : {};
      const spinner = ora('Creating task from template…').start();
      try {
        const task = await post<InstantiatedTask>(`/task-templates/${id}/instantiate`, {
          ...overrides,
          name: opts.name,
        });
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(task, null, 2));
          return;
        }
        console.log(chalk.green(`✔ task created: ${task.id}`));
        console.log(
          chalk.gray(`  name: ${task.name}  status: ${task.status ?? '-'}`),
        );
      } catch (e: unknown) {
        emitError('Failed to create task from template', e, { spinner });
      }
    });

  return cmd;
}
