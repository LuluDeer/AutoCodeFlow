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
  whoami: [
    'acf whoami   # preflight: role + API URL behind the current credential',
    'acf whoami --json',
  ],
  logout: [
    'acf logout   # revoke server-side + clear the local credential file',
  ],
  login: [
    'acf login',
    'acf login --url https://acf.example.com --user admin',
    'ACF_PASSWORD=... acf login --user admin   # CI: password via env, not argv',
    'acf login --user admin --code 123456   # TOTP-enabled account (second factor)',
  ],
  'task list': [
    'acf task list --status active --page 1',
    'acf task list --json',
    'acf task list --search nightly   # matches name OR description (q param)',
  ],
  'task get': ['acf task get <taskId>', 'acf task get <taskId> --json'],
  'task trigger': [
    'acf task trigger <taskId> --wait --wait-timeout 900',
    'acf task trigger <taskId> --params \'{"KEY":"value"}\'   # per-run param overrides (replaces task defaults)',
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
    'acf task create --file task.json   # required: name, triggerType (runtime is optional server-side)',
    "acf task create --body '{\"name\":\"nightly\",\"runtime\":\"node\",\"triggerType\":\"cron\",\"cronExpression\":\"0 2 * * *\"}'   # note: there is NO `version` field on the task body — use `currentVersion` if you need one",
    "acf task create --body '{\"name\":\"sync\",\"runtime\":\"python\",\"triggerType\":\"cron\",\"cronExpression\":\"0 8 * * *\",\"params\":{\"REPLACE_EXISTING\":true,\"retries\":3,\"target\":\"nightly\"}}'   # params inject as AUTOFLOW_<KEY> env vars, JSON-stringified: booleans/numbers bare ('true','3'), strings quoted ('\"nightly\"')",
  ],
  'task update': ['acf task update <taskId> --file patch.json'],
  'task delete': ['acf task delete <taskId> -y'],
  'task pause': ['acf task pause <taskId>'],
  'task resume': ['acf task resume <taskId>'],
  'task export': [
    'acf task export <taskId>',
    'acf task export <taskId> -o task.json   # payload is accepted verbatim by: acf task import task.json',
  ],
  'task import': [
    'acf task import task.json',
    'cat task.json | acf task import -   # "-" reads stdin; the new task starts paused',
  ],
  'task batch': [
    'acf task batch trigger --ids id1,id2,id3',
    'acf task batch pause <id1> <id2>',
  ],
  'task kill': ['acf task kill <taskId> <execId>'],
  'task webhook': [
    'acf task webhook enable <taskId>   # prints the webhook URL + secret ONCE',
    'acf task webhook rotate <taskId>   # old secret dies immediately, new one printed once',
    'acf task webhook status <taskId>   # url + enabled, without touching the secret',
    'acf task webhook disable <taskId>',
  ],
  'task glue': [
    'acf task glue <taskId> -f glue.js   # language inferred from the extension (.js → javascript)',
    'cat glue.py | acf task glue <taskId> --stdin --language python',
  ],
  'task lint': [
    'acf task lint glue.js',
    'acf task lint script.py --language python',
  ],
  'app list': ['acf app list', 'acf app list --json'],
  'app get': ['acf app get <appId> --json'],
  'app create': [
    'acf app create --body \'{"name":"my-app","version":"1.0.0","runtime":"python"}\'   # required: name, version, runtime',
  ],
  'app update': [
    'acf app update <appId> --body \'{"version":"2.0.0"}\'   # renaming is not supported by the backend',
  ],
  'app delete': ['acf app delete <appId> -y'],
  'app analyze': ['acf app analyze <appId>'],
  'app releases': [
    'acf app releases <appId>   # DEP-01 unified view: version × latest deployment (modern; `app versions` is the legacy alias)',
    'acf app releases <appId> -n 200 --json',
  ],
  'app deploy': [
    "acf app deploy <appId> -m scheduled   # deploy-only — middleware/cron triggers it later (default; entry script does NOT start at deploy)",
    "acf app deploy <appId> -m daemon --env '{\"KEY\":\"value\"}'   # resident process — entry script STARTS at deploy, auto-restarts on crash (CLI warns)",
    "acf app deploy <appId> -m deploy-only   # alias of scheduled — self-documenting 'deploy, don't run'",
  ],
  'app deployments': ['acf app deployments <appId> -n 50 --json'],
  'app versions': ['acf app versions <appId> --json'],
  'app upload': [
    'acf app upload ./dist/app.zip --name my-app',
    'acf app upload ./dist/app.zip --name my-app --runtime python --version 1.2.0 --json',
  ],
  'app upgrade-all': [
    'acf app upgrade-all <appId>   # full rolling upgrade (default, no body)',
    'acf app upgrade-all <appId> --strategy canary --percentage 20   # canary first, auto-promote after probe',
  ],
  'executor list': ['acf executor list', 'acf executor list --json'],
  'executor get': ['acf executor get <executorId> --json'],
  'executor rotate': [
    'acf executor rotate executor-node --reason "quarterly rotation"',
  ],
  'executor offline': ['acf executor offline executor-node'],
  'deploy upgrade': ['acf deploy upgrade <deploymentId>'],
  'deploy stop': ['acf deploy stop <deploymentId>'],
  'deploy list': [
    'acf deploy list   # same data as: acf app deployments (deployments live under app in the command tree)',
    'acf deploy list <appId> -n 50 --json',
  ],
  'deploy remove': [
    'acf deploy remove <deploymentId> -y   # delete a FINISHED record (failed/stopped only); running/in-flight rows are refused with 409',
  ],
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
  'apikey create': [
    'acf apikey create --name ci-deploy --scope trigger',
    'acf apikey create --name nightly --scope readonly --expires 90   # plaintext is echoed ONCE',
  ],
  'apikey list': ['acf apikey list', 'acf apikey list --json'],
  'apikey revoke': ['acf apikey revoke 3'],
  'approval list': [
    'acf approval list   # pending queue (default)',
    'acf approval list --status rejected --json',
  ],
  'approval approve': [
    'acf approval approve <deploymentId> --note "change window approved"   # second person: approver ≠ requester',
  ],
  'approval reject': ['acf approval reject <deploymentId> --note "wrong version"'],
  'approval cancel': ['acf approval cancel <deploymentId>   # withdraw your own pending request'],
  'mutex list': [
    'acf mutex list   # the same options the console shows in the app-form dropdown (id + attached app count)',
    'acf mutex list --json',
  ],
  'mutex create': [
    'acf mutex create --name ziniao-browser   # default: 1 concurrent per device (serial on one device)',
    'acf mutex create --name sso-account --scope global   # platform-wide serial (single-sign-on takeover)',
    'acf mutex create --name browser --max-concurrent 2 --description "2 browser slots per device"',
  ],
  'mutex update': [
    'acf mutex update <groupId> --max-concurrent 3',
    'acf mutex update <groupId> --scope global   # tighten immediately; waiting executions are re-dispatched',
  ],
  'mutex delete': [
    'acf mutex delete <groupId>   # refuses (409) while apps are attached — lists how many',
    'acf mutex delete <groupId> --force -y   # attached apps silently lose the constraint',
  ],
  'config show': ['acf config show', 'acf config show --json'],
  'config set-url': ['acf config set-url http://localhost:3105'],
  // 刻意**不**演示 `set-token <明文>`：命令行 token 会进 shell history 与进程列表。
  // 帮助里的示例是 agent 最常照抄的东西，所以这里只给安全通路。
  'config set-token': [
    'ACF_TOKEN=<jwt> acf task list   # preferred: env var, never touches argv/history',
    'acf login                       # or: interactive hidden prompt, stored 0600',
  ],
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
