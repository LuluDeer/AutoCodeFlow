// AutoCodeFlow 配置验证脚本（交付前自检用）
// 1) YAML 语法解析所有改动的 YAML 文件
// 2) 提取 docker-compose.yml / infra compose 的 ${VAR...} 插值，核对 .env.example
//
// PORTABLE（审计 P2，2026-10-17）：此前 `require` 与 `ROOT` 都写死了作者本机的
// 绝对路径（`E:/softwareData/coding/AutoCodeFlow/...`）——在任何其它机器/CI
// 上，`require` 直接 MODULE_NOT_FOUND 崩掉，而 `ROOT` 若碰巧存在还会静默读
// **别人的仓库**。现改为：
//   · ROOT 取脚本所在目录的上一级（本脚本位于 <repo>/scripts/）；
//   · js-yaml 先按正常解析（依赖提升/本地 node_modules 都能命中），
//     失败再回落到已知的 workspace 内位置，最后才报可行动的错。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function requireJsYaml() {
  const candidates = [
    'js-yaml', // 正常解析：根 node_modules / 依赖提升 / pnpm 软链
  ];
  // 回落：js-yaml 是多个 workspace 的传递依赖，位置随 lockfile 变动
  // （原先写死的 apps/admin-web 已不再持有它——这正是写死路径的脆弱之处）。
  // 扫一遍已知 workspace 的 node_modules，命中即用。
  for (const ws of [
    'apps/admin-api',
    'apps/admin-web',
    'apps/executor-node',
    'apps/executor-desktop',
    'packages/autocodeflow-node-sdk',
  ]) {
    candidates.push(path.join(ROOT, ws, 'node_modules', 'js-yaml'));
  }
  candidates.push(path.join(ROOT, 'node_modules', 'js-yaml'));

  const errors = [];
  for (const spec of candidates) {
    try {
      return require(spec);
    } catch (e) {
      errors.push(`${spec}: ${e.code || e.message}`);
    }
  }
  console.error(
    '[verify-config] 无法加载 js-yaml。请先在仓库根目录安装依赖（npm ci）。尝试过：\n  ' +
      errors.join('\n  '),
  );
  process.exit(2);
}

const yaml = requireJsYaml();
const yamlFiles = [
  'docker-compose.yml',
  'docker-compose.staging.yml',
  'infra/docker-compose.yml',
  'config/monitoring/prometheus.yml',
  'config/monitoring/alerts.yml',
  'config/monitoring/alertmanager.yml',
  'config/monitoring/loki.yml',
  'config/monitoring/promtail.yml',
  'config/monitoring/grafana/datasources.yml',
  '.github/workflows/release.yml',
  '.github/workflows/ci.yml',
];

let failed = false;

// ── 1) YAML parse ──
for (const f of yamlFiles) {
  const p = path.join(ROOT, f);
  try {
    const doc = yaml.load(fs.readFileSync(p, 'utf8'));
    console.log(`YAML OK   ${f}`);
  } catch (e) {
    failed = true;
    console.log(`YAML FAIL ${f}: ${e.message.split('\n')[0]}`);
  }
}

// ── 2) env 插值一致性 ──
const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
const envKeys = new Set();
for (const line of envExample.split('\n')) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
  if (m) envKeys.add(m[1]);
}
const envWithDefault = new Set(); // 带 :- 默认值的变量（缺失也不报错）
for (const line of envExample.split('\n')) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
  if (m && line.slice(m[1].length + 1) !== '') envWithDefault.add(m[1]);
}

for (const f of ['docker-compose.yml', 'infra/docker-compose.yml']) {
  const content = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const re = /\$\{([A-Z][A-Z0-9_]*)(?::(-|\?)([^}]*))?\}/g;
  const found = new Map();
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    const op = m[2]; // '-' 或 '?'，undefined 表示无默认
    if (!found.has(name)) found.set(name, { required: false, hasDefault: false });
    if (op === '?') found.get(name).required = true;
    if (op !== undefined) found.get(name).hasDefault = true;
  }
  console.log(`\n-- ${f} 引用的环境变量 --`);
  for (const [name, info] of [...found.entries()].sort()) {
    const defined = envKeys.has(name);
    const hasDefault = info.hasDefault || envWithDefault.has(name);
    // 判定：无任何默认值且未在 .env.example 定义 → 会静默插值为空串（问题）；
    // 带 :- 缺省值的变量未列在 .env.example 是既有设计（缺省即可用），不算失败
    const bad = !hasDefault && !defined;
    const status = bad ? '❌ 无默认值且未定义' : (info.required && !hasDefault && !envWithDefault.has(name) ? '⚠ 必填(:?) 且缺省为空' : '✓');
    if (bad) failed = true;
    console.log(`  ${name.padEnd(32)} ${info.required ? 'REQUIRED' : 'optional'} ${status}`);
  }
}

console.log(failed ? '\n=== 存在失败项 ===' : '\n=== 全部通过 ===');
process.exit(failed ? 1 : 0);
