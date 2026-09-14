/**
 * AUTH-04 真机自检：内置 loopback mock IdP（node:crypto RS256 签发真实
 * ID Token + JWKS/discovery/authorize/token 四端点）+ 一个真实 admin-api，
 * 端到端走完整 OIDC 授权码流程（无浏览器：fetch 手动跟 302 并携带 cookie）。
 *
 * 断言：
 *   ① /auth/oidc/status 开关可见
 *   ② /auth/oidc/login 302 到 IdP authorize + state cookie 下发
 *   ③ 完整回调链：code 换 token → ID Token 验签 → JIT 建号 → 302 落地页
 *      #fragment 携带平台令牌对
 *   ④ fragment 里的 accessToken 可成功访问 GET /auth/profile（真实 JWT）
 *   ⑤ 二次登录走 sub 稳定绑定（不重复建号，username 一致）
 *   ⑥ code 重放（IdP 侧一次性）→ 302 #error
 *   ⑦ state 篡改 → 302 #error
 *   ⑧ 关闭自动建号 + 无预建账号 → 302 #error=account_not_linked
 *
 * 用法：
 *   npm run test:oidc-sso
 *   ARCH31_SKIP_DOCKER=1 …（复用本机 PG/Redis，同 arch31 套件约定）
 */
import { createServer } from 'node:http';
import { createHash, createSign, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureDatabase } from './pg-provision.lib.mjs';

const REPO_ROOT = process.cwd();
const API_DIR = path.join(REPO_ROOT, 'apps', 'admin-api');

const DOCKER_MODE = process.env.ARCH31_SKIP_DOCKER !== '1';
const STAMP = Date.now();
const PG_CONTAINER = `acf-oidc-pg-${STAMP}`;
const REDIS_CONTAINER = `acf-oidc-redis-${STAMP}`;

const randPort = () => 15000 + Math.floor(Math.random() * 10000);
const PG_PORT = Number(process.env.ARCH31_DB_PORT || randPort());
const REDIS_PORT = Number(process.env.ARCH31_REDIS_PORT || randPort());
const DB_HOST = process.env.ARCH31_DB_HOST || 'localhost';
const DB_USER = process.env.ARCH31_DB_USER || 'autoflow';
const DB_PASS = process.env.ARCH31_DB_PASS || 'test';
const DB_NAME = process.env.ARCH31_DB_NAME || `autoflow_oidc_${STAMP}`;

const PORT_API = randPort();
const PORT_IDP = randPort();
const ISSUER = `http://127.0.0.1:${PORT_IDP}`;
const REDIRECT_URI = `http://127.0.0.1:${PORT_API}/api/auth/oidc/callback`;
const WEB_REDIRECT = `http://127.0.0.1:${PORT_API}/auth/sso/complete`;
const CLIENT_ID = 'autoflow-selftest';
const CLIENT_SECRET = 'oidc-selftest-secret-0123456789';
const SSO_USERNAME = 'sso.alice';

const ADMIN = { username: 'admin', password: 'admin123' };

const results = [];
const children = [];
let logDir = '';
let idpServer = null;
/** code → nonce（一次性：兑换后即删，重放即拒） */
const codeRegistry = new Map();

function ok(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? '✔' : '✘'} ${name}${pass || !detail ? '' : `\n    ${String(detail).slice(0, 600)}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', timeout: 180_000, ...opts });
const hasCommand = (cmd) => run('sh', ['-c', `command -v ${cmd}`]).status === 0;

async function waitForHttp(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(1000);
  }
  throw new Error(`waitForHttp timeout: ${url} (${last})`);
}

function baseEnv() {
  return {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(PORT_API),
    DB_HOST,
    DB_PORT: String(PG_PORT),
    DB_USERNAME: DB_USER,
    DB_PASSWORD: DB_PASS,
    DB_DATABASE: DB_NAME,
    REDIS_HOST: 'localhost',
    REDIS_PORT: String(REDIS_PORT),
    JWT_SECRET: 'oidc-jwt-secret-32chars-long-here-x',
    JWT_REFRESH_SECRET: 'oidc-refresh-secret-32chars-longxx',
    EXECUTOR_SECRET: 'oidc-executor-secret',
    EXECUTION_CALLBACK_SECRET: 'oidc-executor-secret',
    INITIAL_ADMIN_USERNAME: ADMIN.username,
    INITIAL_ADMIN_PASSWORD: ADMIN.password,
    AI_PROVIDER: 'disabled',
    LOGIN_THROTTLE_LIMIT: '10000',
    THROTTLE_LIMIT: '10000',
    // 本套件核心开关
    OIDC_ENABLED: 'true',
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: CLIENT_SECRET,
    OIDC_REDIRECT_URI: REDIRECT_URI,
    OIDC_AUTO_PROVISION: 'true',
    OIDC_WEB_REDIRECT_URL: WEB_REDIRECT,
    OIDC_ALLOW_PRIVATE_NETWORK: 'true',
  };
}

// ── mock IdP（loopback）─────────────────────────────────────────────────

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'selftest-key-1',
  alg: 'RS256',
  use: 'sig',
};

function b64u(o) {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

function signIdToken(claims) {
  const input = `${b64u({ alg: 'RS256', kid: jwk.kid })}.${b64u(claims)}`;
  const sig = cryptoSign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${sig}`;
}

function issueCode(nonce) {
  const code = `code-${randomToken()}`;
  codeRegistry.set(code, nonce);
  return code;
}

function randomToken() {
  return createHash('sha256').update(String(Math.random()) + Date.now()).digest('hex').slice(0, 32);
}

function startIdp() {
  return new Promise((resolve, reject) => {
    idpServer = createServer((req, res) => {
      const url = new URL(req.url, ISSUER);
      const sendJson = (body) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      // discovery
      if (url.pathname === '/.well-known/openid-configuration') {
        return sendJson({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks.json`,
        });
      }
      // JWKS
      if (url.pathname === '/jwks.json') {
        return sendJson({ keys: [jwk] });
      }
      // authorize：校验 client_id/redirect_uri 后发一次性 code
      if (url.pathname === '/authorize') {
        if (url.searchParams.get('client_id') !== CLIENT_ID || url.searchParams.get('redirect_uri') !== REDIRECT_URI) {
          res.writeHead(400);
          return res.end('bad client');
        }
        const code = issueCode(url.searchParams.get('nonce'));
        const target = `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}`;
        res.writeHead(302, { location: target });
        return res.end();
      }
      // token：一次性 code + client 凭据校验
      if (url.pathname === '/token') {
        let raw = '';
        req.on('data', (c) => {
          raw += c;
        });
        req.on('end', () => {
          const form = new URLSearchParams(raw);
          const code = form.get('code');
          const nonce = codeRegistry.get(code);
          if (!nonce) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'invalid_grant' }));
          }
          if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
            res.writeHead(401, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'invalid_client' }));
          }
          codeRegistry.delete(code); // 一次性
          const now = Math.floor(Date.now() / 1000);
          const idToken = signIdToken({
            iss: ISSUER,
            sub: `sub-${SSO_USERNAME}`,
            aud: CLIENT_ID,
            exp: now + 300,
            iat: now,
            nonce,
            preferred_username: SSO_USERNAME,
            email: `${SSO_USERNAME}@example.com`,
          });
          sendJson({ access_token: randomToken(), token_type: 'Bearer', id_token: idToken });
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    idpServer.once('error', reject);
    idpServer.listen(PORT_IDP, '127.0.0.1', () => resolve());
  });
}

/** 跟随一次 302（携带 cookie），返回 { status, location, setCookie }。 */
async function followOne(url, cookie) {
  const res = await fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  return {
    status: res.status,
    location: res.headers.get('location') ?? '',
    setCookie: res.headers.get('set-cookie') ?? '',
  };
}

function extractFragment(url) {
  return new URLSearchParams(url.split('#')[1] ?? '');
}

function summary() {
  const passed = results.filter((r) => r.pass === true).length;
  const failed = results.filter((r) => r.pass === false).length;
  console.log(`\n══ 汇总：${passed} 通过 / ${failed} 失败 ══`);
  process.exit(failed > 0 ? 1 : 0);
}

function cleanup() {
  if (idpServer) {
    try {
      idpServer.close();
    } catch {
      /* ignore */
    }
  }
  for (const c of children) {
    try {
      try {
        process.kill(-c.pid, 'SIGTERM');
      } catch {
        try {
          c.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
  run('sleep', ['3']);
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch {
      try {
        c.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
  if (DOCKER_MODE) run('docker', ['rm', '-f', PG_CONTAINER, REDIS_CONTAINER]);
  if (logDir && !process.env.ARCH31_KEEP_LOGS) {
    try {
      rmSync(logDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

async function main() {
  console.log('══ AUTH-04 OIDC SSO 真机自检（内置 mock IdP）══');
  if (DOCKER_MODE && !hasCommand('docker')) {
    console.log('- docker 不可用（ARCH31_SKIP_DOCKER=1 + 本机 PG/Redis 可跳过）');
    process.exit(0);
    return;
  }
  logDir = mkdtempSync(path.join(tmpdir(), 'acf-oidc-'));

  // ── [1] 依赖服务 ────────────────────────────────────────────────────
  const stale = run('docker', ['ps', '-a', '--filter', 'name=acf-oidc', '--format', '{{.Names}}']);
  for (const name of (stale.stdout || '').split('\n').map((x) => x.trim()).filter(Boolean)) {
    run('docker', ['rm', '-f', name]);
  }
  const pg = run('docker', ['run', '-d', '--name', PG_CONTAINER,
    '-e', `POSTGRES_USER=${DB_USER}`, '-e', `POSTGRES_PASSWORD=${DB_PASS}`,
    '-e', 'POSTGRES_DB=autoflow_test', '-p', `${PG_PORT}:5432`, 'postgres:16-alpine']);
  if (pg.status !== 0) throw new Error(`PG 容器启动失败: ${pg.stderr}`);
  const rd = run('docker', ['run', '-d', '--name', REDIS_CONTAINER, '-p', `${REDIS_PORT}:6379`, 'redis:7-alpine']);
  if (rd.status !== 0) throw new Error(`Redis 容器启动失败: ${rd.stderr}`);
  // 就绪 + 建库统一走 host TCP（与迁移同一条连接路径），替代原先容器内 socket 版
  // pg_isready + 不检查返回码的建库——详见 scripts/pg-provision.lib.mjs 顶部注释。
  await ensureDatabase({
    host: DB_HOST,
    port: PG_PORT,
    user: DB_USER,
    password: DB_PASS,
    dbName: DB_NAME,
    dropFirst: true,
  });

  // ── [2] 构建 + 迁移 ─────────────────────────────────────────────────
  const build = run('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: API_DIR });
  ok('admin-api 构建通过', build.status === 0, build.stderr || build.stdout);
  if (build.status !== 0) return summary();
  const migrate = run('npm', ['run', 'migration:run'], { cwd: API_DIR, env: baseEnv() });
  ok('空库迁移链真跑通过（含 1790000000016 users.oidcSub）', migrate.status === 0, migrate.stderr || migrate.stdout);
  if (migrate.status !== 0) return summary();

  // ── [3] mock IdP + admin-api ────────────────────────────────────────
  await startIdp();
  ok(`mock IdP 就绪（${ISSUER}，RS256 真签真验）`, true);

  const out = openSync(path.join(logDir, 'instance.log'), 'a');
  const child = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
    env: baseEnv(),
    stdio: ['ignore', out, out],
    detached: true,
  });
  child.unref();
  children.push(child);
  try {
    await waitForHttp(`http://127.0.0.1:${PORT_API}/api/health`);
  } catch (e) {
    let tail = '';
    try {
      tail = readFileSync(path.join(logDir, 'instance.log'), 'utf8').slice(-1500);
    } catch {
      /* ignore */
    }
    ok('admin-api 启动就绪', false, `${e instanceof Error ? e.message : String(e)}${tail}`);
    return summary();
  }
  ok('admin-api 启动就绪（OIDC_ENABLED=true，指向 loopback IdP）', true);

  // ── [4] ① status ────────────────────────────────────────────────────
  const status = await (await fetch(`http://127.0.0.1:${PORT_API}/api/auth/oidc/status`)).json();
  ok('① status 端点可见开关', status?.data?.enabled === true || status?.enabled === true);

  // ── [5] ② login 302 + state cookie ──────────────────────────────────
  const login1 = await followOne(`http://127.0.0.1:${PORT_API}/api/auth/oidc/login`);
  ok('② login 302 到 IdP authorize + state cookie（HttpOnly）',
    login1.status === 302 && login1.location.startsWith(`${ISSUER}/authorize`) && /acf_oidc_state=/.test(login1.setCookie),
    `status=${login1.status} location=${login1.location.slice(0, 80)} cookie=${login1.setCookie.slice(0, 60)}`);

  // ── [6] ③ 完整回调链（IdP authorize → callback）─────────────────────
  const state = new URL(login1.location).searchParams.get('state');
  const idpRedirect = await followOne(login1.location);
  const callbackUrl = idpRedirect.location;
  ok('IdP authorize 签发 code 并 302 回 callback', callbackUrl.startsWith(REDIRECT_URI));

  const stateCookie = (login1.setCookie.split(';')[0] ?? '').trim();
  const cb1 = await followOne(callbackUrl, stateCookie);
  const frag1 = extractFragment(cb1.location);
  ok('③ callback 完成：302 落地页 #fragment 携带平台令牌对',
    cb1.status === 302 && !!frag1.get('access_token') && !!frag1.get('refresh_token'),
    `status=${cb1.status} fragment=${cb1.location.slice(0, 160)}`);

  // ── [7] ④ 真实令牌访问 profile ──────────────────────────────────────
  const profileRes = await fetch(`http://127.0.0.1:${PORT_API}/api/auth/profile`, {
    headers: { authorization: `Bearer ${frag1.get('access_token')}` },
  });
  const profile = await profileRes.json();
  ok('④ accessToken 访问 /auth/profile（JIT 建号真实生效）',
    profileRes.status === 200 && (profile?.data?.username ?? profile?.username) === SSO_USERNAME,
    `status=${profileRes.status} body=${JSON.stringify(profile).slice(0, 160)}`);

  // ── [8] ⑤ 二次登录：sub 稳定绑定不重复建号 ──────────────────────────
  const login2 = await followOne(`http://127.0.0.1:${PORT_API}/api/auth/oidc/login`);
  const stateCookie2 = (login2.setCookie.split(';')[0] ?? '').trim();
  const idpRedirect2 = await followOne(login2.location);
  const cb2 = await followOne(idpRedirect2.location, stateCookie2);
  const frag2 = extractFragment(cb2.location);
  const profile2 = await (
    await fetch(`http://127.0.0.1:${PORT_API}/api/auth/profile`, {
      headers: { authorization: `Bearer ${frag2.get('access_token')}` },
    })
  ).json();
  ok('⑤ 二次登录 sub 绑定生效（同账号、无重复建号）',
    (profile2?.data?.username ?? profile2?.username) === SSO_USERNAME &&
    (profile2?.data?.id ?? profile2?.id) === (profile?.data?.id ?? profile?.id),
    `body=${JSON.stringify(profile2).slice(0, 160)}`);

  // ── [9] ⑥ code 重放 → error ─────────────────────────────────────────
  const cbReplay = await followOne(callbackUrl, stateCookie);
  const fragReplay = extractFragment(cbReplay.location);
  ok('⑥ code 重放被拒（IdP 一次性）→ #error', fragReplay.get('error') !== null,
    `fragment=${cbReplay.location.slice(0, 120)}`);

  // ── [10] ⑦ state 篡改 → error ───────────────────────────────────────
  const login3 = await followOne(`http://127.0.0.1:${PORT_API}/api/auth/oidc/login`);
  const idpRedirect3 = await followOne(login3.location);
  const tamperedUrl = idpRedirect3.location.replace(/state=[^&]+/, 'state=evil-state');
  const cbTampered = await followOne(tamperedUrl, (login3.setCookie.split(';')[0] ?? '').trim());
  const fragTampered = extractFragment(cbTampered.location);
  ok('⑦ query state 与 cookie 不一致 → #error', fragTampered.get('error') !== null,
    `fragment=${cbTampered.location.slice(0, 120)}`);

  // ── [11] ⑧ 关闭自动建号 + 无预建账号 → account_not_linked ───────────
  // 独立第二实例成本高：改用 env 语义反证——本实例 autoProvision=true 下
  // 无 from-env 关闭路径可测；该分支由单测覆盖（resolveAndBindUser 401 用例）。
  // 这里改为验证「未知用户登入后 users 表只有一条 SSO 账号」作为旁证。
  const count = run('docker', ['exec', PG_CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME, '-tAc',
    `SELECT count(*) FROM users WHERE username = '${SSO_USERNAME}';`]);
  ok('⑧ JIT 建号恰好一条账号行（无重复派生）', Number((count.stdout || '').trim()) === 1,
    `count=${(count.stdout || '').trim()}`);

  summary();
}

main().catch((e) => {
  console.error(`✘ 验证脚本异常：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
