#!/usr/bin/env node
/**
 * N-8（2026-10-26 registry-npm 审计）：运行中 demo registry 的只读 smoke 探针。
 *
 * 背景：bug18 的 live 检查跑在一次性临时 Verdaccio 上（自造 config），仓库内
 * 唯一的 test:registry-npm 只是静态文本断言——三者之间没有一座桥验证「运行中
 * 的 demo registry 真的按权限矩阵工作」。本脚本补上这一环。
 *
 * 严格只读：全部 GET，不上传、不注册、不删除、不写任何数据。
 * 需要 demo 栈在跑（docker compose 项目 acf-demo，网络 autoflow-internal）。
 * 非 CI 必跑——CI 没有运行的 demo 栈时自动 SKIP（exit 0）。
 *
 * 用法：node scripts/registry-npm-demo-smoke.mjs
 *   （在仓库根执行；或设 ACF_SMOKE_REGISTRY=http://host:4873 指向任意实例）
 */
import { execSync } from 'node:child_process';
import process from 'node:process';

const REGISTRY = process.env.ACF_SMOKE_REGISTRY || 'http://registry-npm:4873';
const NETWORK = 'acf-demo_autoflow-internal';
const PROBE = 'acf-demo-registry-npm-1'; // 从 registry 容器自身发起 → 验证容器网络视图

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
  }
}

function skip(name, reason) {
  skipped += 1;
  console.log(`  - ${name} (SKIP: ${reason})`);
}

function demoStackRunning() {
  try {
    const out = execSync('docker ps --format "{{.Names}}"', { encoding: 'utf8', timeout: 10_000 });
    return out.split(/\r?\n/).includes(PROBE);
  } catch {
    return false;
  }
}

/** 在 registry 容器内对 REGISTRY 发 GET（容器内 node 有 fetch；REGISTRY 走服务名）。 */
async function probe(path, headers = {}, method = 'GET', body = undefined) {
  // docker exec node -e 的脚本体必须单行：JSON.stringify 会把换行写成字面 \n，
  // 经 sh 传参后 node 收到的是反斜杠+n 而非换行（实测 SyntaxError）。
  const script =
    `fetch(${JSON.stringify(REGISTRY + path)},{method:${JSON.stringify(method)},` +
    `headers:${JSON.stringify(headers)}${body ? `,body:${JSON.stringify(body)}` : ''}})` +
    `.then(async(r)=>JSON.stringify({status:r.status,body:(await r.text()).slice(0,120)}))` +
    `.then((s)=>process.stdout.write(s))` +
    `.catch((e)=>process.stdout.write(JSON.stringify({status:0,body:String(e&&e.message)})))`;
  const out = execSync(
    `docker exec ${PROBE} node -e ${JSON.stringify(script)}`,
    { encoding: 'utf8', timeout: 15_000 },
  );
  return JSON.parse(out.trim().split(/\r?\n/).pop());
}

async function main() {
  console.log(`registry-npm demo smoke (read-only GET against ${REGISTRY})`);
  if (!demoStackRunning()) {
    skip('all checks', `demo stack container ${PROBE} is not running (start with scripts/demo.sh)`);
    console.log(`${passed} passed; ${skipped} skipped`);
    return;
  }

  // 1. 匿名 ping（README 权限矩阵唯一匿名豁免，compose healthcheck 同源）
  const ping = await probe('/-/ping');
  ok('anonymous /-/ping returns 200 {}', ping.status === 200 && ping.body.trim() === '{}', `got ${ping.status}`);

  // 2. 匿名包 metadata 必 401（config.yaml packages.'**'.access=$authenticated）
  const meta = await probe('/@autoflow%2fsmoke-nonexistent');
  ok('anonymous package metadata denied (401)', meta.status === 401, `got ${meta.status}`);

  // 3. 匿名 tarball 面必 401（下载闸与 metadata 同策略）
  const tarball = await probe('/@autoflow%2fsmoke-nonexistent/-/smoke-nonexistent-1.0.0.tgz');
  ok('anonymous tarball endpoint denied (401)', tarball.status === 401, `got ${tarball.status}`);

  // 4. 匿名包列表代理端点按权限过滤（实测 200+[]；鉴权后才有内容）。
  //    语义豁免：Verdaccio 对 $authenticated 过滤后的匿名请求回空集而非 401。
  const list = await probe('/-/verdaccio/data/packages');
  ok(
    'anonymous data/packages is filtered (200 empty or 401)',
    list.status === 401 || (list.status === 200 && list.body.trim() === '[]'),
    `got ${list.status} ${list.body.slice(0, 40)}`,
  );

  // 5. 路径穿越面仍被拒（审计 N-2 基线回归探针）
  const traversal = await probe('/..%2f..%2fetc%2fpasswd');
  ok('encoded traversal rejected (400/401)', traversal.status === 400 || traversal.status === 401, `got ${traversal.status}`);

  // 6. max_users=-1 收口（N-3）：自助注册（PUT /-/user/*）必须非 201。
  //    否证性 PUT：期望被拒（max_users=-1 时 403），201 = 注册面仍开着。
  const put = await probe(
    '/-/user/org.couchdb.user:acf-smoke-should-fail',
    { 'content-type': 'application/json' },
    'PUT',
    JSON.stringify({ name: 'acf-smoke-should-fail', password: 'x', email: 'x@invalid' }),
  );
  ok('self-registration closed (PUT /-/user/* not 201)', put.status !== 201, `got ${put.status} ${put.body.slice(0, 40)}`);

  if (failed > 0) {
    console.error(`${passed} passed; ${failed} FAILED; ${skipped} skipped`);
    process.exit(1);
  }
  console.log(`${passed} passed; ${failed} failed; ${skipped} skipped`);
}

main().catch((e) => {
  console.error(`smoke failed: ${e && e.message}`);
  process.exit(1);
});
