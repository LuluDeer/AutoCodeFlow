#!/usr/bin/env node
/**
 * BUG-18 first-stage private PyPI/npm dual-registry verification.
 *
 * Default mode runs source/config contract checks and, when the local tools are
 * available, starts disposable loopback-only PyPI and Verdaccio services. The
 * live checks never use the repository compose project, never touch its
 * volumes, and remove every temporary process/container in finally blocks.
 *
 * Use `--dry-run` (or BUG18_DRY_RUN=1) for contract-only validation. This is
 * intentionally not an admin-api/executor compose E2E: those services and
 * their credentials must be supplied by a real deployment verification run.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PYPI_APP = path.join(ROOT, 'apps/registry-pypi');
const PYPI_WHEEL = path.join(PYPI_APP, 'packages/autoflow-sdk/autoflow_sdk-0.1.0-py3-none-any.whl');
const DRY_RUN = process.argv.includes('--dry-run') || process.env.BUG18_DRY_RUN === '1';
const PYPI_USER = 'bug18-user';
const PYPI_PASS = `bug18-${process.pid}-${Date.now()}`;
const NPM_USER = 'bug18-user';
const NPM_PASS = `bug18-${process.pid}-${Date.now()}`;

let passed = 0;
let skipped = 0;
let cleanupFailures = 0;

function ok(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✔ ${name}`);
}

function skip(name, reason) {
  skipped += 1;
  console.log(`  - ${name} (SKIP: ${reason})`);
}

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

function commandAvailable(command) {
  const result = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
  return result.status === 0;
}

function run(command, args, options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  for (const name of options.unsetEnv || []) delete env[name];
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env,
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function redact(text, secrets = []) {
  let result = String(text);
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join('[REDACTED]');
  }
  return result.replace(/(Authorization:\s*Basic\s+)[^\s]+/gi, '$1[REDACTED]');
}

function commandOrThrow(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const output = redact(`${result.stdout}\n${result.stderr}`, options.secrets || []);
    throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}\n${output.slice(-4000)}`);
  }
  return result;
}

async function waitFor(url, expectedStatus = 200, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not reached';
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const remainingMs = Math.max(1, deadline - Date.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(1_000, remainingMs));
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status === expectedStatus) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(150, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for ${url} after ${attempts} attempts in ${timeoutMs}ms (last error: ${lastError})`);
}

async function fetchText(url, options = {}, timeoutMs = 15_000) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const text = await response.text();
  return { response, text };
}

function waitForChild(child, timeoutMs = 5_000) {
  if (!child) return Promise.resolve(true);
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('close', onClose);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onClose = () => finish(true);
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('close', onClose);
    child.once('exit', onExit);
  });
}

async function stopChild(child, label, secrets = []) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  let exited = false;
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  } catch (error) {
    console.error(`${label} SIGTERM cleanup failed: ${redact(error, secrets)}`);
  }
  exited = await waitForChild(child, 5_000);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch (error) {
      console.error(`${label} SIGKILL cleanup failed: ${redact(error, secrets)}`);
    }
    exited = await waitForChild(child, 5_000);
  }
  if (!exited && child.exitCode === null && child.signalCode === null) {
    cleanupFailures += 1;
    console.error(`${label} cleanup failed: child did not exit after SIGTERM/SIGKILL`);
    return false;
  }
  return true;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForChildPort(child, label, timeoutMs = 15_000) {
  if (!child?.stdout || !child?.stderr) throw new Error(`${label} has no stdout/stderr pipe for port discovery`);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('close', onClose);
      child.stdout.resume();
      child.stderr.resume();
      if (error) reject(error);
      else resolve(port);
    };
    const onStdout = (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-4000);
      const match = /https?:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match) finish(null, Number(match[1]));
    };
    const onStderr = (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
      const match = /https?:\/\/127\.0\.0\.1:(\d+)/.exec(stderr);
      if (match) finish(null, Number(match[1]));
    };
    const onClose = () => finish(new Error(`${label} exited before reporting a port (stdout/stderr: ${redact(`${stdout}\n${stderr}`)})`));
    const timer = setTimeout(() => finish(new Error(`${label} did not report a loopback port within ${timeoutMs}ms (stdout/stderr: ${redact(`${stdout}\n${stderr}`)})`)), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('close', onClose);
  });
}

function staticContractChecks() {
  console.log('\nBUG-18 contract checks');
  const pypi = read('apps/registry-pypi/main.py');
  const pypiTests = read('apps/registry-pypi/tests/test_registry.py');
  const pyExecute = read('apps/executor-python/routers/execute.py');
  const pyConfig = read('apps/executor-python/config.py');
  const npmConfig = read('apps/registry-npm/config.yaml');
  const npmReadme = read('apps/registry-npm/README.md');
  const npmSelftest = read('scripts/registry-npm-config.selftest.mjs');
  const compose = read('docker-compose.yml');
  const nodeExecute = read('apps/executor-node/src/routes/execute.ts');
  const nodeConfig = read('apps/executor-node/src/config.ts');
  const nodeEnv = read('apps/executor-node/src/env-whitelist.ts');
  const pyRequirements = read('apps/executor-python/requirements.txt');
  const pyDockerfile = read('apps/executor-python/Dockerfile');
  const pyExampleReqs = read('examples/private-registry-deps/requirements.txt');
  const pyExampleTask = read('examples/private-registry-deps/task.example.json');
  const nodeExampleTask = read('examples/private-registry-deps-node/task.example.json');

  ok('PyPI exposes PEP 503 root and package index routes',
    pypi.includes('@app.get("/simple/"') && pypi.includes('@app.get("/simple/{package_name}/"'));
  ok('PyPI package links carry sha256 fragments',
    pypi.includes('#sha256={sha256}') && pypiTests.includes('sha256='));
  ok('PyPI index/download/upload paths require Basic auth',
    (pypi.match(/Depends\(verify_auth\)/g) || []).length >= 5);
  ok('PyPI same-bytes duplicate is idempotent 200',
    pypi.includes('Uploaded {filename} (unchanged)') && pypiTests.includes('test_reupload_same_content_is_idempotent_200'));
  ok('PyPI changed duplicate is rejected 409 without overwrite',
    pypi.includes('status_code=409') && pypi.includes('overwriting published') && pypiTests.includes('test_reupload_different_content_rejected_409'));
  ok('Python executor uses the validated configured index-url, not task-provided options',
    pyExecute.includes("install_args.extend(['--index-url', registry_url])") &&
    pyExecute.includes('options are not allowed') &&
    pyExecute.includes('_validate_registry_url'));
  ok('Python executor configuration has PYPI registry field',
    pyConfig.includes('pypi_registry_url: str'));
  ok('Python executor rejects credential-bearing PYPI_REGISTRY_URL',
    pyConfig.includes('validate_pypi_registry_url') &&
    pyConfig.includes('hide_input_in_errors=True') &&
    pyConfig.includes('must not contain userinfo') &&
    pyExecute.includes('must not contain userinfo'));
  ok('Python dependency installs run under an isolated uv environment',
    pyExecute.includes('_build_install_env') &&
    pyExecute.includes("env['UV_NO_CONFIG'] = '1'") &&
    pyExecute.includes('PIP_CONFIG_FILE') &&
    pyExecute.includes('UV_CONFIG_FILE'));
  ok('executor-python pins a uv version that supports `uv venv --no-project`',
    pyRequirements.includes('uv==0.8.17') && pyDockerfile.includes('uv venv --no-project'));

  ok('npm private package rules require authentication',
    npmConfig.includes("access: $authenticated") && npmConfig.includes("publish: $authenticated") && npmConfig.includes("unpublish: $authenticated"));
  ok('npm registry keeps htpasswd in persistent storage',
    npmConfig.includes('file: /verdaccio/storage/htpasswd') && compose.includes('npm_data:/verdaccio/storage'));
  ok('npm host binding remains loopback-only',
    compose.includes("- '127.0.0.1:4873:4873'") && npmSelftest.includes('127.0.0.1:4873:4873'));
  ok('npm config selftest forbids anonymous package access',
    npmSelftest.includes("$anonymous") && npmReadme.includes('Anonymous | package metadata / tarball download | ❌ Denied'));
  ok('executor writes npmrc token only for registry installation',
    nodeExecute.includes('buildNpmRcContent') && nodeConfig.includes('NPM_REGISTRY_TOKEN') && nodeExecute.includes('_authToken') && nodeExecute.includes('redactUrl'));
  ok('executor-node keeps the npm credential file private and short-lived',
    nodeExecute.includes('createTemporaryNpmConfig') &&
    nodeExecute.includes('removeTemporaryNpmConfig') &&
    nodeExecute.includes('0o600') &&
    nodeExecute.includes('npm_config_userconfig'));
  ok('executor-node no longer writes .npmrc into the persistent task tree',
    !nodeExecute.includes("path.join(nodeModulesDir, '.npmrc')"));
  ok('npmrc builder emits @autoflow/@autocodeflow scoped and global registry rules plus auth token line',
    nodeExecute.includes("['@autoflow', '@autocodeflow']") && nodeExecute.includes('scope}:registry=${registryUrl}') && nodeExecute.includes(':_authToken=${token}') && nodeExecute.includes('npmAuthUrlLine'));
  ok('npm registry token is excluded from task child environment',
    !nodeEnv.includes("'NPM_REGISTRY_TOKEN'") && nodeConfig.includes('deliberately NOT in the env whitelist'));
  ok('Python example declares private package requirements',
    pyExampleReqs.includes('acfdemopkg') && JSON.parse(pyExampleTask).requirements.includes('acfdemopkg'));
  ok('Node example declares scoped private package requirement',
    JSON.parse(nodeExampleTask).requirements.some((item) => item.startsWith('@')));
  ok('repository compose does not expose registries beyond loopback',
    compose.includes('127.0.0.1:8003:8003') && compose.includes('127.0.0.1:4873:4873'));
}

async function livePypiCheck() {
  if (!commandAvailable('python3') || !existsSync(PYPI_WHEEL)) {
    skip('PyPI live upload/install', 'python3 or bundled wheel is unavailable');
    return;
  }
  const temp = mkdtempSync(path.join(tmpdir(), 'acf-bug18-pypi-'));
  const packages = path.join(temp, 'packages');
  mkdirSync(packages, { recursive: true });
  let child;
  const secrets = [PYPI_PASS];
  try {
    child = spawn('python3', ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '0'], {
      cwd: PYPI_APP,
      env: { ...process.env, PACKAGES_DIR: packages, REGISTRY_USER: PYPI_USER, REGISTRY_PASS: PYPI_PASS },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const port = await waitForChildPort(child, 'temporary PyPI uvicorn');
    const base = `http://127.0.0.1:${port}`;
    const health = await waitFor(`${base}/health`);
    const healthBody = await health.json();
    const temporaryFixtureHealth =
      health.headers.get('server')?.toLowerCase().includes('uvicorn') === true &&
      health.headers.get('content-type')?.includes('application/json') === true &&
      healthBody.service === 'pypi-registry' && healthBody.status === 'ok';
    if (!temporaryFixtureHealth) {
      throw new Error(`temporary PyPI uvicorn health response did not match fixture marker/header: ${JSON.stringify(healthBody)}`);
    }

    const anon = await fetchWithTimeout(`${base}/simple/`);
    ok('PyPI rejects unauthenticated index access', anon.status === 401);

    const wheelBytes = readFileSync(PYPI_WHEEL);
    async function upload(bytes) {
      const form = new FormData();
      form.append('name', 'autoflow-sdk');
      form.append('version', '0.1.0');
      form.append('content', new Blob([bytes]), path.basename(PYPI_WHEEL));
      return fetchWithTimeout(`${base}/`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${PYPI_USER}:${PYPI_PASS}`).toString('base64')}` },
        body: form,
      });
    }

    const first = await upload(wheelBytes);
    ok('PyPI authenticated upload succeeds against the temporary uvicorn fixture',
      first.status === 200 && first.headers.get('server')?.toLowerCase().includes('uvicorn') === true);
    const rootIndex = await fetchText(`${base}/simple/`, {
      headers: { Authorization: `Basic ${Buffer.from(`${PYPI_USER}:${PYPI_PASS}`).toString('base64')}` },
    });
    ok('PyPI PEP 503 root index lists uploaded package', rootIndex.response.status === 200 && rootIndex.text.includes('autoflow-sdk'));
    const packageIndex = await fetchText(`${base}/simple/autoflow-sdk/`, {
      headers: { Authorization: `Basic ${Buffer.from(`${PYPI_USER}:${PYPI_PASS}`).toString('base64')}` },
    });
    ok('PyPI package index contains wheel anchor and sha256',
      packageIndex.response.status === 200 && packageIndex.text.includes('autoflow_sdk-0.1.0-py3-none-any.whl#sha256='));

    const same = await upload(wheelBytes);
    ok('PyPI same artifact re-upload stays idempotent', same.status === 200 && (await same.json()).unchanged === true);
    const changed = await upload(Buffer.from('different artifact bytes'));
    ok('PyPI changed duplicate is rejected', changed.status === 409);
    ok('PyPI failed duplicate leaves no upload temp file',
      !readFileSyncSafeList(packages).some((name) => name.endsWith('.upload')));

    const target = path.join(temp, 'install');
    mkdirSync(target);
    const indexUrl = `${base}/simple/`;
    const pip = run('python3', ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', '--trusted-host', '127.0.0.1', '--index-url', `http://${encodeURIComponent(PYPI_USER)}:${encodeURIComponent(PYPI_PASS)}@127.0.0.1:${port}/simple/`, '--target', target, 'autoflow-sdk==0.1.0'], { timeout: 120_000, secrets, unsetEnv: ['PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL'] });
    ok('pip consumes private PEP 503 index-url', pip.status === 0, redact(`${pip.stdout}\n${pip.stderr}`, secrets).slice(-1000));
    const imported = run('python3', ['-c', 'import autoflow_sdk; print(autoflow_sdk.__version__)'], { env: { PYTHONPATH: target }, secrets });
    ok('pip-installed private package imports', imported.status === 0 && imported.stdout.trim() === '0.1.0');
    // Keep this assertion explicit in output/diagnostics without leaking credentials.
    void indexUrl;
  } finally {
    await stopChild(child, 'temporary PyPI uvicorn', secrets);
    rmSync(temp, { recursive: true, force: true });
  }
}

function readFileSyncSafeList(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readFileSyncDirectory(dir)) {
    result.push(entry);
  }
  return result;
}

function readFileSyncDirectory(dir) {
  // Avoid importing readdirSync in the main list above solely for this one
  // check; this helper intentionally reports only artifact basenames.
  return spawnSync('find', [dir, '-type', 'f', '-printf', '%f\n'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/).filter(Boolean);
}

async function liveNpmCheck() {
  if (!commandAvailable('docker') || !commandAvailable('npm')) {
    skip('npm live publish/install', 'docker or npm is unavailable');
    return;
  }
  const image = run('docker', ['image', 'inspect', 'verdaccio/verdaccio:5'], { timeout: 20_000 });
  if (image.status !== 0) {
    skip('npm live publish/install', 'verdaccio/verdaccio:5 image is not available locally');
    return;
  }

  const temp = mkdtempSync(path.join(tmpdir(), 'acf-bug18-npm-'));
  const storage = path.join(temp, 'storage');
  const packageDir = path.join(temp, 'package');
  const installDir = path.join(temp, 'install');
  const noAuthRc = path.join(temp, 'no-auth.npmrc');
  const authRc = path.join(temp, 'auth.npmrc');
  const container = `acf-bug18-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let port;
  let token = '';
  let containerStarted = false;
  const secrets = [NPM_PASS];
  try {
    mkdirSync(storage, { recursive: true, mode: 0o777 });
    chmodSync(storage, 0o777);
    mkdirSync(packageDir);
    mkdirSync(installDir);
    writeFileSync(path.join(storage, 'htpasswd'), '', { mode: 0o666 });
    writeFileSync(path.join(temp, 'config.yaml'), `storage: /verdaccio/storage\nauth:\n  htpasswd:\n    file: /verdaccio/storage/htpasswd\n    max_users: 100\npackages:\n  '**':\n    access: $authenticated\n    publish: $authenticated\n    unpublish: $authenticated\nweb:\n  enabled: false\nlisten: 0.0.0.0:4873\nlog: { type: stdout, format: pretty, level: warn }\n`);

    const docker = run('docker', [
      'run', '-d', '--rm', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '--name', container, '-p', '127.0.0.1:0:4873',
      '-v', `${storage}:/verdaccio/storage`,
      '-v', `${path.join(temp, 'config.yaml')}:/verdaccio/conf/config.yaml:ro`,
      'verdaccio/verdaccio:5',
    ], { timeout: 60_000 });
    if (docker.status !== 0) throw new Error(redact(`${docker.stdout}\n${docker.stderr}`));
    containerStarted = true;
    const portResult = commandOrThrow('docker', ['port', container, '4873/tcp'], { secrets });
    port = Number.parseInt(portResult.stdout.trim().split(':').pop(), 10);
    await waitFor(`http://127.0.0.1:${port}/-/ping`);

    const userResponse = await fetchWithTimeout(`http://127.0.0.1:${port}/-/user/org.couchdb.user:${NPM_USER}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: NPM_USER, password: NPM_PASS, email: `${NPM_USER}@example.invalid` }),
    });
    const userBody = await userResponse.json();
    token = userBody.token || '';
    ok('Verdaccio temporary user/token setup succeeds', userResponse.status === 201 && token.length > 20);

    const registry = `http://127.0.0.1:${port}/`;
    const packageName = '@autoflow/bug18-private-fixture';
    const packageTarballName = 'autoflow-bug18-private-fixture-1.0.0.tgz';
    writeFileSync(noAuthRc, `registry=${registry}\n`);
    writeFileSync(authRc, `registry=${registry}\n@autoflow:registry=${registry}\n@autocodeflow:registry=${registry}\n//127.0.0.1:${port}/:_authToken=${token}\n`);
    writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.0', main: 'index.js' }, null, 2));
    writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = { source: "bug18-private-registry" };\n');
    commandOrThrow('npm', ['pack', '--silent', '--pack-destination', temp], { cwd: packageDir, secrets });
    const tarball = path.join(temp, packageTarballName);
    ok('npm live fixture uses an executor-covered private scope', packageName.startsWith('@autoflow/'));

    const npmEnv = { HOME: path.join(temp, 'home-auth') };
    const npmSecrets = [NPM_PASS, token];
    const published = run('npm', ['publish', tarball, '--userconfig', authRc, '--registry', registry, '--ignore-scripts'], { env: npmEnv, unsetEnv: ['NPM_TOKEN', 'NPM_REGISTRY_TOKEN', 'VERDACCIO_TOKEN'], secrets: npmSecrets, timeout: 60_000 });
    ok('npm authenticated publish succeeds', published.status === 0, redact(`${published.stdout}\n${published.stderr}`, npmSecrets).slice(-1000));
    const anonymousEnv = { HOME: path.join(temp, 'home-anon') };
    const anonMetadata = run('npm', ['view', packageName, 'version', '--userconfig', noAuthRc, '--registry', registry], { env: anonymousEnv, unsetEnv: ['NPM_TOKEN', 'NPM_REGISTRY_TOKEN', 'VERDACCIO_TOKEN'], secrets: [NPM_PASS, token], timeout: 60_000 });
    const anonStatus = /E401|E403|401|403|unauthorized|forbidden/i.test(`${anonMetadata.stdout}\n${anonMetadata.stderr}`);
    ok('npm rejects unauthenticated metadata access after package exists', anonMetadata.status !== 0 && anonStatus && !anonMetadata.stdout.includes('1.0.0'), redact(`${anonMetadata.stdout}\n${anonMetadata.stderr}`, [NPM_PASS, token]).slice(-1000));
    const anonPublish = run('npm', ['publish', tarball, '--userconfig', noAuthRc, '--registry', registry, '--ignore-scripts'], { env: anonymousEnv, unsetEnv: ['NPM_TOKEN', 'NPM_REGISTRY_TOKEN', 'VERDACCIO_TOKEN'], secrets: [NPM_PASS, token], timeout: 60_000 });
    ok('npm rejects unauthenticated publish', anonPublish.status !== 0);

    ok('npm authenticated publish succeeds', published.status === 0, redact(`${published.stdout}\n${published.stderr}`, secrets).slice(-1000));
    const duplicate = run('npm', ['publish', tarball, '--userconfig', authRc, '--registry', registry, '--ignore-scripts'], { env: npmEnv, unsetEnv: ['NPM_TOKEN', 'NPM_REGISTRY_TOKEN', 'VERDACCIO_TOKEN'], secrets: npmSecrets, timeout: 60_000 });
    ok('npm duplicate version keeps registry rejection semantics', duplicate.status !== 0);
    const metadata = run('npm', ['view', packageName, 'version', '--userconfig', authRc, '--registry', registry], { env: npmEnv, unsetEnv: ['NPM_TOKEN', 'NPM_REGISTRY_TOKEN', 'VERDACCIO_TOKEN'], secrets: npmSecrets, timeout: 60_000 });
    ok('npm authenticated metadata lookup succeeds', metadata.status === 0 && metadata.stdout.includes('1.0.0'));
    const installed = run('npm', ['install', '--ignore-scripts', '--prefix', installDir, '--userconfig', authRc, '--registry', registry, `${packageName}@1.0.0`], { env: npmEnv, unsetEnv: ['NPM_TOKEN', 'NPM_REGISTRY_TOKEN', 'VERDACCIO_TOKEN'], secrets: npmSecrets, timeout: 60_000 });
    ok('npm consumes private registry package', installed.status === 0, redact(`${installed.stdout}\n${installed.stderr}`, npmSecrets).slice(-1000));
    const modulePath = JSON.stringify(path.join(installDir, 'node_modules/@autoflow/bug18-private-fixture'));
    const loaded = run('node', ['-e', `console.log(require(${modulePath}).source)`], { secrets: npmSecrets });
    ok('npm-installed private package imports', loaded.status === 0 && loaded.stdout.trim() === 'bug18-private-registry');
    const npmOutput = `${published.stdout}\n${published.stderr}\n${duplicate.stdout}\n${duplicate.stderr}\n${metadata.stdout}\n${metadata.stderr}\n${installed.stdout}\n${installed.stderr}`;
    ok('npm outputs do not contain Verdaccio or NPM_REGISTRY_TOKEN secrets', !npmOutput.includes(token) && !npmOutput.includes(process.env.NPM_REGISTRY_TOKEN || '__missing_npm_registry_token__'));
  } finally {
    if (containerStarted) {
      const cleanup = run('docker', ['rm', '-f', container], { timeout: 30_000, secrets: [NPM_PASS, token, process.env.NPM_REGISTRY_TOKEN || ''] });
      if (cleanup.status !== 0) {
        cleanupFailures += 1;
        console.error(`temporary Verdaccio cleanup failed: ${redact(`${cleanup.stdout}\n${cleanup.stderr}`, [NPM_PASS, token, process.env.NPM_REGISTRY_TOKEN || '']).slice(-2000)}`);
      }
      const remaining = run('docker', ['ps', '-aq', '--filter', `name=^/${container}$`], { timeout: 10_000, secrets: [NPM_PASS, token] });
      if (remaining.status === 0 && remaining.stdout.trim()) {
        cleanupFailures += 1;
        console.error(`temporary Verdaccio container remains after cleanup: ${container}`);
      }
    }
    // The disposable container runs with the caller uid/gid, so no privileged
    // cleanup is needed. Never touch repository paths here.
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
  console.log(`BUG-18 private registry selftest (${DRY_RUN ? 'dry-run' : 'contract + disposable live checks'})`);
  staticContractChecks();
  if (DRY_RUN) {
    skip('PyPI live upload/install', '--dry-run requested');
    skip('npm live publish/install', '--dry-run requested');
  } else {
    await livePypiCheck();
    await liveNpmCheck();
  }
  console.log(`\n${passed} assertions passed; ${skipped} checks skipped`);
  console.log(`Cleanup failures: ${cleanupFailures}`);
  console.log('Not covered: real admin-api/executor compose dispatch, task callback, and production credentials.');
  if (cleanupFailures > 0) throw new Error(`${cleanupFailures} disposable service cleanup failure(s); inspect the diagnostics above`);
}

main().catch((error) => {
  console.error(`\nBUG-18 selftest failed: ${redact(error instanceof Error ? error.stack || error.message : error)}`);
  process.exitCode = 1;
});
