import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';
import { get, formatApiError } from '../client';

/** 与后端 ProjectViewRow 对齐（AUTH-02-B 读面过滤视图）。 */
interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  myRole: 'viewer' | 'editor' | 'admin' | null;
}

interface MemberRow {
  id: string;
  projectId: string;
  userId: number;
  role: 'viewer' | 'editor' | 'admin';
  createdAt: string;
}

const ROLE_COLOR: Record<string, (s: string) => string> = {
  admin: chalk.yellow,
  editor: chalk.cyan,
  viewer: chalk.gray,
};

function roleText(role: string | null): string {
  if (!role) return '-';
  return (ROLE_COLOR[role] ?? ((x: string) => x))(role);
}

/**
 * AUTH-02-B（R18）：项目域只读命令。读面与后端一致（列表按主体过滤；
 * 成员列表要求成员身份）。成员写面为 ADMIN-only，不在 CLI 暴露。
 */
export function projectsCommand(): Command {
  const cmd = new Command('project').description('Inspect projects and members (read-only)');

  cmd
    .command('list')
    .description('List projects visible to the current credential (with your role)')
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (opts) => {
      const spinner = ora('Fetching projects…').start();
      try {
        const rows = (await get('/projects')) as ProjectRow[];
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        if (!rows.length) {
          console.log(chalk.gray('No projects visible.'));
          return;
        }
        const table = new Table({
          head: ['Name', 'My role', 'Description', 'Created'],
        });
        for (const r of rows) {
          table.push([
            r.name,
            roleText(r.myRole),
            r.description ?? '-',
            new Date(r.createdAt).toISOString().slice(0, 10),
          ]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        spinner.stop();
        console.error(chalk.red(formatApiError(e)));
        process.exitCode = 1;
      }
    });

  cmd
    .command('members <projectId>')
    .description('List members (userId + role) of one project')
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(async (projectId: string, opts) => {
      const spinner = ora('Fetching members…').start();
      try {
        const rows = (await get(`/projects/${projectId}/members`)) as MemberRow[];
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        if (!rows.length) {
          console.log(chalk.gray('No members.'));
          return;
        }
        const table = new Table({
          head: ['User ID', 'Role', 'Since'],
        });
        for (const r of rows) {
          table.push([r.userId, roleText(r.role), new Date(r.createdAt).toISOString().slice(0, 10)]);
        }
        console.log(table.toString());
      } catch (e: unknown) {
        spinner.stop();
        console.error(chalk.red(formatApiError(e)));
        process.exitCode = 1;
      }
    });

  return cmd;
}
