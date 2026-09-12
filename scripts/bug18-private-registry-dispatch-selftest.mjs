/**
 * BUG-18 真机验证（executor 侧）：真实私服 + 真实 executor 代码路径的依赖安装链路。
 *
 * 与 bug18-private-registry-selftest.mjs（注册表侧：npm/pip 直连私服）互补：
 * 本脚本把 **executor-node 真实进程** 拉起来，用一个 requirements 指向私服的
 * 任务走 POST /api/execute，验证三件此前只有单测覆盖的事：
 *   ① 依赖确实从私服（Verdaccio，需 auth token）装上，产物落任务目录；
 *   ② 凭据（.npmrc 里的 _authToken）**不落任务工作树**；
 *   ③ 临时 npm 配置目录用后即删（os.tmpdir 无 autocodeflow-npm-* 残留）。
 *
 * 仍不覆盖（如实）：admin-api → executor 的完整平台派发链路（需起 admin-api + DB）。
 *
 * 前置：docker（本地已有 verdaccio/verdaccio:5 镜像）+ npm + `npm run build:node` 产物。
 * 用法：node scripts/bug18-private-registry-dispatch-selftest.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const EXECUTOR_PORT = Number(process.env.BUG18_EXECUTOR_PORT || 8099);
const FIXTURE = '@autoflow/bug18-exec-fixture';
const NPM_USER = 'bug18exec';
const NPM_PASS = 'bug18-exec-pass';

/**
 * executor-node 经 dotenvx 注入 apps/executor-node/.env（注入值覆盖进程 env，
 * 故无法用 spawn env 关掉鉴权）——按 config.ts 的同一优先级
 * （EXECUTOR_SHARED_TOKEN → EXECUTOR_SECRET）读取静态 token 作为本脚本调用
 * /api/execute 的凭据（不打印其值）。
 */
function readExecutorToken() {
  const pick = (key) => {
    const m = new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm').exec(envText);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  let envText = '';
  try {
    envText = readFileSync(path.join(REPO_ROOT, 'apps/executor-node/.env'), 'utf8');
  } catch {
    /* 无 .env 则走进程 env */
  }
  return pick('EXECUTOR_SHARED_TOKEN') || pick('EXECUTOR_SECRET')
    || process.env.EXECUTOR_SHARED_TOKEN || process.env.EXECUTOR_SECRET || '';
}
const INSTALL_TIMEOUT_MS = 120_000;

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? '✔' : '✘'} ${name}${pass || !detail ? '' : `\n    ${String(detail).slice(0, 800)}`}`);
}
function skip(name, reason) {
  results.push({ name, pass: null });
  console.log(`- ${name}（跳过：${reason}）`);
}
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, ...opts });
}
function hasCommand(cmd) {
  return run('sh', ['-c', `command -v ${cmd}`]).status === 0;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  return false;
}

/** 递归查找指定文件名（可跳过若干目录名） */
function findFile(root, name, skipDirs = new Set()) {
  if (!existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        stack.push(p);
      } else if (e.name === name) {
        return p;
      }
    }
  }
  return null;
}

/** 任务目录内是否存在包含 needle 的文本文件（默认跳过 node_modules 内的正常依赖） */
function dirContainsSecret(root, needle, skipDirs = new Set(['node_modules'])) {
  if (!existsSync(root)) return false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        stack.push(p);
      } else {
        try {
          if (statSync(p).size < 1_000_000 && readFileSync(p, 'utf8').includes(needle)) return true;
        } catch {
          /* 二进制/不可读 */
        }
      }
    }
  }
  return false;
}

function tmpNpmConfigDirs() {
  return readdirSync(tmpdir()).filter((n) => n.startsWith('autocodeflow-npm-'));
}

const temp = mkdtempSync(path.join(tmpdir(), 'acf-bug18-exec-'));
const storage = path.join(temp, 'storage');
const packageDir = path.join(temp, 'package');
const authRc = path.join(temp, 'auth.npmrc');
const taskWorkDirRoot = path.join(temp, 'tasks');
const container = `acf-bug18-exec-${process.pid}`;
const state = { executorChild: null, containerStarted: false };

function cleanup(removeTemp) {
  try {
    state.executorChild?.kill('SIGTERM');
  } catch {
    /* noop */
  }
  if (state.containerStarted) run('docker', ['rm', '-f', container], { timeout: 30_000 });
  // 全部断言通过时回收临时目录；失败时保留供取证
  if (removeTemp) {
    try {
      rmSync(temp, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
}

async function main() {
  if (!existsSync(path.join(REPO_ROOT, 'apps/executor-node/dist/main.js'))) {
    skip('executor 侧真机派发', 'apps/executor-node/dist/main.js 不存在（先跑 npm run build:node）');
    return 0;
  }
  if (!hasCommand('docker') || !hasCommand('npm')) {
    skip('executor 侧真机派发', 'docker 或 npm 不可用');
    return 0;
  }
  if (run('docker', ['image', 'inspect', 'verdaccio/verdaccio:5'], { timeout: 20_000 }).status !== 0) {
    skip('executor 侧真机派发', 'verdaccio/verdaccio:5 镜像不在本地');
    return 0;
  }

  // ── Verdaccio + fixture 发布 ──────────────────────────────────────────
  mkdirSync(storage, { recursive: true, mode: 0o777 });
  chmodSync(storage, 0o777);
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(taskWorkDirRoot, { recursive: true });
  writeFileSync(path.join(storage, 'htpasswd'), '', { mode: 0o666 });
  writeFileSync(
    path.join(temp, 'config.yaml'),
    `storage: /verdaccio/storage\nauth:\n  htpasswd:\n    file: /verdaccio/storage/htpasswd\n    max_users: 100\npackages:\n  '**':\n    access: $authenticated\n    publish: $authenticated\n    unpublish: $authenticated\nweb:\n  enabled: false\nlisten: 0.0.0.0:4873\nlog: { type: stdout, format: pretty, level: warn }\n`,
  );
  const docker = run('docker', [
    'run', '-d', '--rm', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '--name', container, '-p', '127.0.0.1:0:4873',
    '-v', `${storage}:/verdaccio/storage`,
    '-v', `${path.join(temp, 'config.yaml')}:/verdaccio/conf/config.yaml:ro`,
    'verdaccio/verdaccio:5',
  ], { timeout: 60_000 });
  state.containerStarted = docker.status === 0;
  if (!state.containerStarted) throw new Error(`verdaccio 启动失败：${docker.stdout}\n${docker.stderr}`);
  const portOut = run('docker', ['port', container, '4873/tcp']);
  const port = Number.parseInt(portOut.stdout.trim().split(':').pop(), 10);
  const registry = `http://127.0.0.1:${port}/`;
  ok('Verdaccio 临时私服就绪', await waitForHttp(`${registry}-/ping`), registry);

  const userRes = await fetch(`${registry}-/user/org.couchdb.user:${NPM_USER}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: NPM_USER, password: NPM_PASS, email: `${NPM_USER}@example.invalid` }),
  });
  const token = (await userRes.json()).token || '';
  ok('私服临时用户/token 就绪', userRes.status === 201 && token.length > 20);

  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: FIXTURE, version: '1.0.0', main: 'index.js' }, null, 2));
  writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = { source: "bug18-executor-dispatch" };\n');
  writeFileSync(authRc, `registry=${registry}\n@autoflow:registry=${registry}\n//127.0.0.1:${port}/:_authToken=${token}\n`);
  const packed = run('npm', ['pack', '--silent', '--pack-destination', temp], { cwd: packageDir, env: { HOME: path.join(temp, 'home-pack') } });
  if (packed.status !== 0) throw new Error(`npm pack 失败：${packed.stderr}`);
  const tarball = path.join(temp, packed.stdout.trim().split('\n').pop().trim());
  const published = run('npm', ['publish', tarball, '--userconfig', authRc, '--registry', registry, '--ignore-scripts'], {
    env: { HOME: path.join(temp, 'home-pub') },
    timeout: 60_000,
  });
  ok('私服 fixture 包发布成功', published.status === 0, published.stderr);

  // ── 起 executor-node 真实进程（私服指向 Verdaccio）────────────────────
  const beforeTmp = new Set(tmpNpmConfigDirs());
  state.executorChild = spawn('node', ['apps/executor-node/dist/main.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(EXECUTOR_PORT),
      WORK_DIR: taskWorkDirRoot,
      NPM_REGISTRY_URL: registry,
      NPM_REGISTRY_TOKEN: token,
      EXECUTOR_ID: 'bug18-exec-verify',
      ADMIN_API_URL: 'http://127.0.0.1:1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let executorLog = '';
  state.executorChild.stdout.on('data', (d) => { executorLog += d.toString(); });
  state.executorChild.stderr.on('data', (d) => { executorLog += d.toString(); });

  ok('executor-node 真实进程就绪（/health/live）', await waitForHttp(`http://127.0.0.1:${EXECUTOR_PORT}/health/live`, 30_000));

  // ── 派发任务：requirements 指向私服包 ─────────────────────────────────
  const executionId = 'bug18-exec-dispatch';
  const res = await fetch(`http://127.0.0.1:${EXECUTOR_PORT}/api/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${readExecutorToken()}` },
    body: JSON.stringify({
      executionId,
      callbackUrl: 'http://127.0.0.1:1/callback',
      task: {
        id: 'bug18-task',
        name: 'bug18-task',
        runtime: 'node',
        entrypoint: 'index.js',
        requirements: [`${FIXTURE}@1.0.0`],
      },
    }),
  });
  const resBody = await res.text().catch(() => '');
  const dispatched = res.status === 200;
  ok('POST /api/execute 被接受（200）', dispatched, `status=${res.status} ${resBody}`);

  const taskDir = path.join(taskWorkDirRoot, executionId);
  // executor 把任务依赖装在共享目录 <workDir>/.node_modules/<taskId>/node_modules
  // （按 task.id 归并，非按 executionId），凭据检查覆盖这两处。
  const depDir = path.join(taskWorkDirRoot, '.node_modules', 'bug18-task');
  const installedMarker = path.join(depDir, 'node_modules', '@autoflow', 'bug18-exec-fixture', 'package.json');
  if (dispatched) {
    const deadline = Date.now() + INSTALL_TIMEOUT_MS;
    while (Date.now() < deadline && !existsSync(installedMarker)) await sleep(500);
  }
  const tail = executorLog.slice(-4000);
  ok('私服依赖由 executor 装到任务目录（node_modules 落盘）', dispatched && existsSync(installedMarker), tail);
  ok('执行器日志出现私服 registry 交互', dispatched && /registry|verdaccio|127\.0\.0\.1:\d+/i.test(executorLog), tail);

  // ── 凭据隔离与清理断言（派发未成功则跳过，避免空过）──────────────────
  if (!dispatched) {
    for (const n of ['任务工作树内无 .npmrc（凭据不落任务目录）', '任务工作树内无 _authToken 痕迹', '临时 npm 配置目录用后即删（无残留）', 'executor 输出未泄漏 token']) {
      skip(n, '派发未成功，无法验证');
    }
    return 1;
  }

  const leakedRc = findFile(taskDir, '.npmrc') ?? findFile(depDir, '.npmrc');
  ok('任务工作树内无 .npmrc（凭据不落任务目录）', leakedRc === null, `发现 ${leakedRc}`);
  ok(
    '任务工作树内无 _authToken 痕迹（执行目录 + 依赖目录）',
    !dirContainsSecret(taskDir, token) && !dirContainsSecret(depDir, token),
    '任务目录内出现 token 字符串',
  );
  const lock = path.join(depDir, 'package-lock.json');
  ok(
    '依赖锁文件记录私服 registry（证明确由私服安装）',
    existsSync(lock) && readFileSync(lock, 'utf8').includes(`127.0.0.1:`),
    existsSync(lock) ? readFileSync(lock, 'utf8').slice(0, 400) : '无 lock 文件',
  );

  await sleep(1500); // 留出 finally 清理窗口
  const newTmpDirs = tmpNpmConfigDirs().filter((n) => !beforeTmp.has(n));
  ok('临时 npm 配置目录用后即删（无残留）', newTmpDirs.length === 0, `残留：${newTmpDirs.join(', ')}`);
  ok('executor 输出未泄漏私服 token', !executorLog.includes(token));

  const failed = results.filter((r) => r.pass === false).length;
  const executed = results.filter((r) => r.pass !== null).length;
  console.log(`\n${executed} 项断言：${results.filter((r) => r.pass).length} 通过 / ${failed} 失败`);
  console.log('未覆盖（如实）：admin-api → executor 的完整平台派发链路（需 admin-api + DB）。');
  return failed === 0 ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.error(`✘ 运行失败：${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  cleanup(exitCode === 0);
}
process.exit(exitCode);
