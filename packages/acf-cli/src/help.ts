/**
 * 集中式 help 体系：全 CLI 的命令示例表。
 *
 * 为什么集中：commander 15 已提供层级 help（用途一行 = description、参数表 =
 * usage/options、逐级 --help），这部分直接收编、不重造。缺的只有「每个命令
 * 至少一个示例」——若散在各命令文件里用 addHelpText 拼接，永远查不齐、也没法
 * 守卫。这里用一张以命令路径为键的表（'task list' → 示例行数组），由
 * `applyExamples` 在 index.ts 的命令分发处统一走树注入，src/__tests__/
 * ux-uniform.test.ts 再用真实命令树断言「每个叶子命令都有 Examples 块」——
 * 新增命令忘写示例会直接红。
 *
 * 键约定：空串 = 顶层 acf；其余为 'login'、'task list' 这样的空格分隔路径。
 */
import type { Command } from 'commander';

export const EXAMPLES: Record<string, string[]> = {
  '': [
    'acf login',
    'acf task trigger <taskId> --wait',
    'acf exec tail <execId>',
  ],
  login: [
    'acf login',
    'acf login --url https://acf.example.com --user admin',
    'ACF_PASSWORD=... acf login --user admin   # CI: password via env, not argv',
  ],
  'task list': [
    'acf task list --status active --page 1',
    'acf task list --json',
  ],
  'task get': ['acf task get <taskId>', 'acf task get <taskId> --json'],
  'task trigger': [
    'acf task trigger <taskId> --wait --wait-timeout 900',
  ],
  'task executions': [
    'acf task executions <taskId> -n 5',
    'acf task executions <taskId> --json',
  ],
  'task logs': [
    'acf task logs <execId> --tail 100',
    'acf task logs <execId> --from-line 200 -n 100',
  ],
  'task analyze': ['acf task analyze <taskId> <execId>'],
  'task suggest-schedule': ['acf task suggest-schedule <taskId>'],
  'task stats': ['acf task stats <taskId> --json'],
  'task versions': ['acf task versions <taskId> --json'],
  'task rollback': [
    'acf task rollback <taskId> --version <versionId>   # versionId from: acf task versions <taskId>',
  ],
  'task compare': ['acf task compare <taskId> <versionId1> <versionId2>'],
  'task create': [
    'acf task create --file task.json   # required: name, version, runtime, triggerType',
    "acf task create --json '{\"name\":\"nightly\",\"version\":\"1.0.0\",\"runtime\":\"node\",\"triggerType\":\"cron\",\"cronExpression\":\"0 2 * * *\"}'",
  ],
  'task update': ['acf task update <taskId> --file patch.json'],
  'task delete': ['acf task delete <taskId> -y'],
  'task pause': ['acf task pause <taskId>'],
  'task resume': ['acf task resume <taskId>'],
  'task kill': ['acf task kill <taskId> <execId>'],
  'task lint': [
    'acf task lint glue.js',
    'acf task lint script.py --language python',
  ],
  'app list': ['acf app list', 'acf app list --json'],
  'app get': ['acf app get <appId> --json'],
  'app create': [
    'acf app create --file app.json   # required: name, version, runtime',
  ],
  'app update': [
    'acf app update <appId> --json \'{"version":"2.0.0"}\'   # renaming is not supported by the backend',
  ],
  'app delete': ['acf app delete <appId> -y'],
  'app analyze': ['acf app analyze <appId>'],
  'app deploy': [
    "acf app deploy <appId> -e <executorId> -m daemon --env '{\"KEY\":\"value\"}'",
  ],
  'app deployments': ['acf app deployments <appId> -n 50 --json'],
  'app versions': ['acf app versions <appId> --json'],
  'executor list': ['acf executor list', 'acf executor list --json'],
  'executor get': ['acf executor get <executorId> --json'],
  'executor rotate': [
    'acf executor rotate executor-node --reason "quarterly rotation"',
  ],
  'executor offline': ['acf executor offline executor-node'],
  'deploy upgrade': ['acf deploy upgrade <deploymentId>'],
  'deploy stop': ['acf deploy stop <deploymentId>'],
  'audit list': [
    'acf audit list --action task.trigger --start-time 2026-01-01T00:00:00Z',
    'acf audit list --json',
  ],
  'exec tail': ['acf exec tail <execId>', 'acf exec tail <execId> --json'],
  'project list': ['acf project list', 'acf project list --json'],
  'project members': ['acf project members <projectId> --json'],
  'sop list': ['acf sop list --status published', 'acf sop list --json'],
  'sop show': ['acf sop show <sopId> --json'],
  'agent sessions': [
    'acf agent sessions --status waiting_input',
    'acf agent sessions --json',
  ],
  'config show': ['acf config show'],
  'config set-url': ['acf config set-url http://localhost:3105'],
  'config set-token': ['acf config set-token <token>   # prefer: acf login'],
};

/**
 * Walk the whole command tree and attach the matching Examples block to every
 * command that has one (leaf commands and the root). Called once from index.ts
 * after all commands are registered — the single wiring point.
 */
export function applyExamples(program: Command): void {
  const walk = (cmd: Command, path: string): void => {
    const lines = EXAMPLES[path];
    if (lines?.length) {
      cmd.addHelpText('after', `\nExamples:\n  ${lines.join('\n  ')}`);
    }
    for (const sub of cmd.commands) {
      walk(sub, path ? `${path} ${sub.name()}` : sub.name());
    }
  };
  walk(program, '');
}
