// AutoCodeFlow 配置验证脚本（临时，交付前自检用）
// 1) YAML 语法解析所有改动的 YAML 文件
// 2) 提取 docker-compose.yml / infra compose 的 ${VAR...} 插值，核对 .env.example
const fs = require('fs');
const path = require('path');
const yaml = require('E:/softwareData/coding/AutoCodeFlow/apps/admin-web/node_modules/js-yaml');

const ROOT = 'E:/softwareData/coding/AutoCodeFlow';
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
