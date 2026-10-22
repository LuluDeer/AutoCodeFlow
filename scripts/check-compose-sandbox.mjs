/**
 * SEC-07 / DEEP-AUDIT D2-P1-1 回归守卫（2026-10 修订）。
 *
 * 背景：2026-09 曾把根 `docker-compose.yml` 的 executor-python 硬编码为
 * `TASK_SANDBOX: 'bwrap'`，本守卫当时钉死该值。2026-10 的真机复现发现：
 *   - 镜像不含 bubblewrap；
 *   - 即便装上，compose 的 cap_drop/no-new-privileges 与多数宿主 seccomp
 *     策略也不允许非特权 user namespaces；
 *   ⇒ 默认部署里**每个 Python 任务**都 fail-closed（sandbox_unavailable）。
 *
 * 修订后的契约：
 *   ① 基础 compose 默认 **不启用** bwrap：TASK_SANDBOX 必须是
 *      `${TASK_SANDBOX:-}`（或空串），绝不硬编码 'bwrap'；
 *   ② `docker-compose.secure.yml` 是显式 opt-in，必须设置 'bwrap'；
 *   ③ docs/deployment.md 必须保留 secure overlay + unprivileged userns +
 *      fail-closed 的前置/回退说明。
 *
 * 纯静态读取，不需要 docker / npm ci。
 *
 * 用法：
 *   node scripts/check-compose-sandbox.mjs             # 正式检查
 *   node scripts/check-compose-sandbox.mjs --selftest # 有齿自检（负例必须被检出）
 *
 * 退出码：全通过 0；任一失败 1。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/**
 * 从 compose 文本中抽取指定服务的 environment 映射。
 * 结构约定（与本仓 compose 一致）：services 下 `  <name>:` 为两空格缩进，
 * environment 为四空格，env 条目为六空格 `KEY: value`。
 * 返回 { [key]: rawValue }；找不到服务块返回 null。
 */
export function extractServiceEnv(composeText, serviceName) {
  const lines = composeText.split(/\r?\n/);
  const serviceRe = new RegExp(`^  ${serviceName}:`);
  const start = lines.findIndex((l) => serviceRe.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  \S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end);
  const envIdx = block.findIndex((l) => /^    environment:\s*$/.test(l));
  if (envIdx === -1) return {};
  const env = {};
  for (let i = envIdx + 1; i < block.length; i++) {
    if (/^\s*#/.test(block[i]) || block[i].trim() === '') continue;
    const m = block[i].match(/^      ([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/);
    if (!m) break;
    env[m[1]] = m[2];
  }
  return env;
}

/** 基础 compose 允许的默认值：显式空串，或由环境变量覆盖（默认空）。 */
export function isOptInSandboxValue(value) {
  return value === "''" || value === '""' || value === '${TASK_SANDBOX:-}';
}

const failures = [];
const report = (ok, name, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `\n   ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

function runFormalChecks() {
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const env = extractServiceEnv(compose, 'executor-python');
  report(env !== null, 'executor-python 服务块存在于 docker-compose.yml');
  if (env !== null) {
    report(
      env.TASK_SANDBOX !== undefined && isOptInSandboxValue(env.TASK_SANDBOX),
      "基础 compose 的 TASK_SANDBOX 默认关闭（'' 或 ${TASK_SANDBOX:-}）",
      `实际值: ${JSON.stringify(env.TASK_SANDBOX ?? '(未设置)')}`,
    );
    report(
      env.TASK_SANDBOX !== "'bwrap'",
      "基础 compose 不得硬编码 TASK_SANDBOX='bwrap'（会让默认部署所有 Python 任务 fail-closed）",
    );
  }

  const securePath = path.join(root, 'docker-compose.secure.yml');
  report(fs.existsSync(securePath), 'docker-compose.secure.yml 存在（显式 opt-in）');
  if (fs.existsSync(securePath)) {
    const secure = fs.readFileSync(securePath, 'utf8');
    const secureEnv = extractServiceEnv(secure, 'executor-python');
    report(
      secureEnv !== null && secureEnv.TASK_SANDBOX === "'bwrap'",
      "secure overlay 的 executor-python.TASK_SANDBOX === 'bwrap'",
      `实际值: ${JSON.stringify(secureEnv?.TASK_SANDBOX ?? '(未设置)')}`,
    );
  }

  const deploy = fs.readFileSync(path.join(root, 'docs', 'deployment.md'), 'utf8');
  const hasOverlayNote =
    deploy.includes('docker-compose.secure.yml') &&
    deploy.includes('unprivileged') &&
    deploy.includes('user namespaces') &&
    /bwrap/i.test(deploy) &&
    deploy.includes('fail-closed');
  report(
    hasOverlayNote,
    'deployment.md 保留 secure overlay + bwrap + unprivileged userns + fail-closed 说明',
  );
}

function runSelftest() {
  const base = (value) =>
    [
      'services:',
      '  executor-python:',
      '    environment:',
      `      TASK_SANDBOX: ${value}`,
      '  executor-node:',
      '    environment:',
      "      LOG_LEVEL: 'info'",
    ].join('\n');

  report(
    extractServiceEnv(base("''"), 'executor-python').TASK_SANDBOX === "''",
    '有齿：显式空串被识别为默认关闭',
  );
  report(
    extractServiceEnv(base('${TASK_SANDBOX:-}'), 'executor-python').TASK_SANDBOX ===
      '${TASK_SANDBOX:-}',
    '有齿：环境变量覆盖形态被识别',
  );
  report(!isOptInSandboxValue("'bwrap'"), '有齿：硬编码 bwrap 被判为非默认值');

  const noKey = [
    'services:',
    '  executor-python:',
    '    environment:',
    "      LOG_LEVEL: 'info'",
  ].join('\n');
  report(
    extractServiceEnv(noKey, 'executor-python').TASK_SANDBOX === undefined,
    '有齿：缺 TASK_SANDBOX 能被检出',
  );

  const secure = [
    'services:',
    '  executor-python:',
    '    environment:',
    "      TASK_SANDBOX: 'bwrap'",
  ].join('\n');
  report(
    extractServiceEnv(secure, 'executor-python').TASK_SANDBOX === "'bwrap'",
    '有齿：secure overlay 的 bwrap 被接受',
  );
}

if (process.argv.includes('--selftest')) {
  console.log('=== check-compose-sandbox selftest ===\n');
  runSelftest();
} else {
  console.log('=== SEC-07: compose 任务沙箱默认/opt-in 守卫 ===\n');
  runFormalChecks();
}

if (failures.length) {
  console.error(`\n${failures.length} 项失败: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\n全部通过');
