/**
 * DEP-HA-1 真机自检：admin-api 多副本（--scale）下 nginx 反代轮询生效。
 *
 * 验证什么：infra/nginx/default.conf 的「resolver 127.0.0.11 + 变量 proxy_pass」
 * 形态在 `--scale admin-api=2` 后能轮询命中多个副本——这是 deployment.md
 * 「多副本（HA）部署」菜谱的核心机制（静态 proxy_pass 会在启动期解析并永久
 * 缓存单 IP，扩容后流量永远打一个副本）。
 *
 * 怎么验证（轻量、不构建 admin-api 镜像——多实例行为一致性已由
 * test:arch31-multi-instance / test:arch31-outbox-dup 真机覆盖）：
 *   ① 起一个临时 compose 项目：admin-api 服务 = nginx:alpine 桩（监听 3105
 *      返回 200）× --scale 2，proxy 服务挂 infra/nginx/default.conf 原件；
 *   ② 经 proxy 连打 /api/health N 次（跨过 resolver valid=10s 的缓存窗），
 *      断言 X-Upstream 取证头出现 ≥2 个不同 upstream（= 轮询生效）；
 *   ③ 响应体内容完整透传（200 "ok"）。
 *
 * 用法：
 *   npm run test:ha-compose
 *   HA_PROXY_PORT=18080 npm run test:ha-compose        # 固定 proxy 端口
 *
 * 退出码：全通过 0；任一失败 1；无 docker → 显式 skip 且 0。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const NGINX_CONF = path.join(REPO_ROOT, 'infra', 'nginx', 'default.conf');
const STAMP = Date.now();
const PROJECT = `acf-ha-${STAMP}`;
const TMP = mkdtempSync(path.join(tmpdir(), `acf-ha-${STAMP}-`));
const PROXY_PORT = Number(process.env.HA_PROXY_PORT || 0) || (15000 + Math.floor(Math.random() * 10000));

/** 取证请求数：跨过 resolver valid=10s 缓存窗（1s 间隔 × 20 ≈ 20s > 2 个窗）。 */
const REQUESTS = Number(process.env.HA_REQUESTS || 20);
const REQUEST_GAP_MS = Number(process.env.HA_REQUEST_GAP_MS || 1000);
/** 期望的不同 upstream 数下限（--scale 2 → 2）。 */
const EXPECTED_DISTINCT = 2;
/** proxy 就绪等待上限。 */
const READY_TIMEOUT_MS = 60_000;

const results = [];
const ok = (name, passed, detail = '') => {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✅' : '❌'} ${name}${detail ? `\n   ${detail}` : ''}`);
};

const compose = (args, extra = {}) =>
  spawnSync('docker', ['compose', '-p', PROJECT, '-f', path.join(TMP, 'docker-compose.yml'), ...args], {
    encoding: 'utf8',
    ...extra,
  });

const hasDocker = () =>
  spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' }).status === 0;

function getJson(port, reqPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: reqPath, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
  });
}

async function main() {
  console.log(`\n=== DEP-HA-1 ha-compose 自检（project=${PROJECT}, proxy=:${PROXY_PORT}）===\n`);
  if (!hasDocker()) {
    console.log('⏭️  docker 不可用 —— 显式 skip（退出 0）');
    return 0;
  }

  // 桩上游：监听 3105，返回固定 200（吃下真实 conf 的 /api/ 代理语义）
  writeFileSync(
    path.join(TMP, 'upstream.conf'),
    `server {\n  listen 3105;\n  location / { default_type text/plain; return 200 "ok\\n"; }\n}\n`,
  );
  writeFileSync(
    path.join(TMP, 'docker-compose.yml'),
    `services:
  admin-api:
    image: nginx:alpine
    volumes:
      - ${path.join(TMP, 'upstream.conf')}:/etc/nginx/conf.d/default.conf:ro
    networks: [ha-net]
  proxy:
    image: nginx:alpine
    volumes:
      - ${NGINX_CONF}:/etc/nginx/conf.d/default.conf:ro
    ports:
      - "127.0.0.1:${PROXY_PORT}:80"
    depends_on:
      - admin-api
    networks: [ha-net]
networks:
  ha-net:
`,
  );

  try {
    const up = compose(['up', '-d', '--scale', 'admin-api=2', '--quiet-pull']);
    ok('compose up --scale admin-api=2', up.status === 0, (up.stderr || up.stdout || '').slice(-600));
    if (up.status !== 0) return summary();

    // proxy 就绪等待（nginx 启动 + 副本可达）
    const readyAt = Date.now();
    let ready = false;
    while (Date.now() - readyAt < READY_TIMEOUT_MS) {
      const r = await getJson(PROXY_PORT, '/api/health');
      if (r.status === 200) {
        ready = true;
        break;
      }
      await new Promise((r2) => setTimeout(r2, 1500));
    }
    ok('proxy 就绪（经 nginx /api/health 200）', ready);
    if (!ready) return summary();

    // 取证轮询：收集 X-Upstream（$upstream_addr，形如 172.x.0.y:3105）
    const upstreams = new Map();
    let bodyOk = 0;
    let lastDetail = '';
    for (let i = 0; i < REQUESTS; i++) {
      const r = await getJson(PROXY_PORT, '/api/health');
      if (r.status === 200 && r.body.trim() === 'ok') bodyOk++;
      const up2 = r.headers?.['x-upstream'] || '(missing)';
      upstreams.set(up2, (upstreams.get(up2) || 0) + 1);
      lastDetail = `${r.status ?? 'ERR'} via ${up2}`;
      await new Promise((r2) => setTimeout(r2, REQUEST_GAP_MS));
    }
    const distinct = [...upstreams.keys()].filter((k) => k !== '(missing)');
    ok(
      `响应体透传完整（${bodyOk}/${REQUESTS} = 200 "ok"）`,
      bodyOk === REQUESTS,
      `最后一次: ${lastDetail}`,
    );
    ok(
      `多副本轮询生效：${distinct.length} 个不同 upstream（期望 ≥${EXPECTED_DISTINCT}）`,
      distinct.length >= EXPECTED_DISTINCT,
      [...upstreams.entries()].map(([k, v]) => `${k} × ${v}`).join(', '),
    );
    return summary();
  } finally {
    compose(['down', '-v', '--remove-orphans']);
    rmSync(TMP, { recursive: true, force: true });
  }
}

function summary() {
  const failed = results.filter((r) => !r.passed);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    return 1;
  }
  console.log('\nDEP-HA-1 ha-compose 自检全绿。');
  return 0;
}

process.exit(await main());
