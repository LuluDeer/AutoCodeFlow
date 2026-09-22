/**
 * DEEP-AUDIT D2-P1-1（2026-09-22）回归守卫：compose 部署路径必须显式启用 bwrap。
 *
 * 为什么需要：apps/executor-python/config.py:258 注释声称「生产容器由
 * docker-compose 显式开启 bwrap」，而根 docker-compose.yml 的 executor-python
 * env 块此前从未设置 TASK_SANDBOX——最强隔离层在生产路径默认关闭，注释与
 * 实际安全姿态漂移。本守卫钉死两件事，任何一处回退即红：
 *
 *   ① 根 docker-compose.yml 的 executor-python 服务 environment 必须含
 *      TASK_SANDBOX: 'bwrap'（结构性解析，不靠整文件文本搜索，避免命中注释）；
 *   ② docs/deployment.md「容器安全」段必须保留 unprivileged userns 前置验证
 *      与 fail-closed 说明（文档承诺不随改注释/改文案丢失）。
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
 * 结构约定（与本仓 docker-compose.yml 一致）：services 下 `  <name>:` 为
 * 两空格缩进，其 environment 为四空格，env 条目为六空格 `KEY: value`。
 * 返回 { [key]: rawValue }；找不到服务块返回 null。
 */
export function extractServiceEnv(composeText, serviceName) {
  const lines = composeText.split(/\r?\n/);
  const serviceRe = new RegExp(`^  ${serviceName}:`);
  const start = lines.findIndex((l) => serviceRe.test(l));
  if (start === -1) return null;
  // 服务块范围：从 start+1 到下一个同样两空格缩进的顶层服务键（^  \S）为止
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
    if (/^\s*#/.test(block[i]) || block[i].trim() === '') continue; // 注释/空行跳过
    const m = block[i].match(/^      ([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/);
    if (!m) break; // env 块结束（下一段缩进/同级键）
    env[m[1]] = m[2];
  }
  return env;
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
      env.TASK_SANDBOX === "'bwrap'",
      "executor-python.environment.TASK_SANDBOX === 'bwrap'",
      `实际值: ${JSON.stringify(env.TASK_SANDBOX ?? '(未设置)')}`,
    );
  }

  const deploy = fs.readFileSync(path.join(root, 'docs', 'deployment.md'), 'utf8');
  const hasUsernsNote =
    deploy.includes('unprivileged') &&
    deploy.includes('user namespaces') &&
    /bwrap/i.test(deploy) &&
    deploy.includes('fail-closed');
  report(
    hasUsernsNote,
    'deployment.md 保留 bwrap + unprivileged userns 前置验证 + fail-closed 说明',
  );
}

function runSelftest() {
  // 有齿：检测器对「缺 TASK_SANDBOX」的负例必须报缺失，对「值错误」也必须报错，
  // 防止正式检查恒真（空洞通过）。
  const noSandbox = [
    'services:',
    '  executor-python:',
    '    environment:',
    "      LOG_LEVEL: 'info'",
    '      PYPI_REGISTRY_URL: http://x',
    '  executor-node:',
    '    environment:',
    "      TASK_SANDBOX: 'bwrap'",
  ].join('\n');
  const env1 = extractServiceEnv(noSandbox, 'executor-python');
  const missingOk = env1.TASK_SANDBOX === undefined;
  report(missingOk, '有齿：缺 TASK_SANDBOX 的块能被检出未设置', `env=${JSON.stringify(env1)}`);

  const wrongValue = [
    'services:',
    '  executor-python:',
    '    environment:',
    "      TASK_SANDBOX: ''",
  ].join('\n');
  const env2 = extractServiceEnv(wrongValue, 'executor-python');
  report(
    env2.TASK_SANDBOX === "''" && env2.TASK_SANDBOX !== "'bwrap'",
    '有齿：TASK_SANDBOX 为空值的块能被识别为非 bwrap',
    `env=${JSON.stringify(env2)}`,
  );

  const good = [
    'services:',
    '  executor-python:',
    '    environment:',
    "      TASK_SANDBOX: 'bwrap'",
  ].join('\n');
  const env3 = extractServiceEnv(good, 'executor-python');
  report(env3.TASK_SANDBOX === "'bwrap'", '有齿：正确块被接受');
}

if (process.argv.includes('--selftest')) {
  console.log('=== check-compose-sandbox selftest ===\n');
  runSelftest();
} else {
  console.log('=== DEEP-AUDIT D2-P1-1: compose bwrap 启用守卫 ===\n');
  runFormalChecks();
}

if (failures.length) {
  console.error(`\n${failures.length} 项失败: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\n全部通过');
