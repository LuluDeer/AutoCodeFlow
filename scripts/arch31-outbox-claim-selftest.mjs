/**
 * ARCH-31 矩阵验证清单第 4 项：**outbox 行级 claim 的双实例竞争**（真 PG 并发）。
 *
 * 为什么用 DB 级并发而不是"起两个 admin-api 投 webhook"：订阅回调面走
 * assertSafeHttpUrl（**回环地址直接拒绝**，SSRF 纪律，无测试开关），本机离线环境
 * 造不出可达的接收端；而这一项真正要验的临界区是**生产同款 claim SQL** 的排他性
 * ——因此直接把两个并发会话按同一 SQL 抢同一批行，比 HTTP 端到端更贴近要害。
 *
 * 做法（关键：SQL 从源码里**现取**，不手抄——源码改了这里自动跟着变，
 * 常量 OUTBOX_BATCH_SIZE / OUTBOX_LEASE_MS 同样现取）：
 *   ① 起 PG16（空库真跑迁移链），插入 N 行待投 outbox 行；
 *   ② 两个独立连接（模拟两个实例）**并发**执行同款 claim CTE，多轮；
 *   ③ 断言：同一轮内没有一行被两个会话同时租到（FOR UPDATE SKIP LOCKED 的
 *      排他性）；活动租约不会被抢（leaseUntil 谓词）；租约过期后可被回收；
 *      合并两会话多轮结果能覆盖全部行（不因 SKIP 永久饿死）。
 *
 * 用法：
 *   node scripts/arch31-outbox-claim-selftest.mjs
 *   ARCH31O_SKIP_DOCKER=1（复用本机 PG）
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const API_DIR = path.join(REPO_ROOT, 'apps', 'admin-api');
const requireFromApi = createRequire(path.join(API_DIR, 'noop.js'));
const { Client } = requireFromApi('pg');

const DOCKER_MODE = process.env.ARCH31O_SKIP_DOCKER !== '1';
const STAMP = Date.now();
const PG_CONTAINER = `acf-arch31o-pg-${STAMP}`;
const randPort = () => 15000 + Math.floor(Math.random() * 10000);
const PG_PORT = Number(process.env.ARCH31O_DB_PORT || randPort());
const DB_HOST = process.env.ARCH31O_DB_HOST || 'localhost';
const DB_USER = process.env.ARCH31O_DB_USER || 'autoflow';
const DB_PASS = process.env.ARCH31O_DB_PASS || 'test';
const DB_NAME = process.env.ARCH31O_DB_NAME || `autoflow_arch31o_${STAMP}`;

/** 待投行数（与并发轮次一起决定覆盖断言）。 */
const ROWS = Number(process.env.ARCH31O_ROWS || 50);
const ROUNDS = Number(process.env.ARCH31O_ROUNDS || 12);

const results = [];
let tmpDir = '';

function ok(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? '✔' : '✘'} ${name}${pass || !detail ? '' : `\n    ${String(detail).slice(0, 700)}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', timeout: 300_000, ...opts });

/** 从生产源码现取 claim SQL 与常量（不手抄，避免与实现漂移）。 */
function readClaimSqlFromSource() {
  const src = readFileSync(
    path.join(API_DIR, 'src/modules/event-subscriptions/outbox-dispatcher.service.ts'),
    'utf8',
  );
  const sqlMatch = src.match(/WITH "claimable" AS \([\s\S]*?RETURNING "outbox"\.\*[\s\S]*?`/);
  if (!sqlMatch) throw new Error('未能从源码中提取 claim SQL（实现是否改名/改写？）');
  const sql = sqlMatch[0].replace(/`$/, '').trim();
  const batch = src.match(/OUTBOX_BATCH_SIZE\s*=\s*(\d+)/);
  const lease = src.match(/OUTBOX_LEASE_MS\s*=\s*([\d_]+)/);
  if (!batch || !lease) throw new Error('未能从源码中提取 OUTBOX_BATCH_SIZE / OUTBOX_LEASE_MS');
  return {
    sql,
    batchSize: Number(batch[1]),
    leaseMs: Number(lease[1].replace(/_/g, '')),
  };
}

const CLAIM = readClaimSqlFromSource();

function client() {
  return new Client({
    host: DB_HOST,
    port: PG_PORT,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
  });
}

/** 一轮 claim：与生产同款单条 CTE（$1=now, $2=batch, $3=leaseUntil）。 */
async function claimOnce(c, tag, leaseMs = CLAIM.leaseMs) {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const res = await c.query(CLAIM.sql, [now, CLAIM.batchSize, leaseUntil]);
  return res.rows.map((r) => ({ id: r.id, token: r.leaseToken, tag, leaseUntil }));
}

async function main() {
  console.log('══ ARCH-31 第 4 项：outbox claim 双实例竞争（真 PG 并发）══');
  console.log(`claim SQL 取自源码；批量=${CLAIM.batchSize} 租约=${CLAIM.leaseMs}ms；行数=${ROWS} 轮次=${ROUNDS}`);

  if (!run('sh', ['-c', 'command -v docker']).stdout && DOCKER_MODE) {
    results.push({ name: 'outbox claim 竞争验证', pass: null });
    console.log('- outbox claim 竞争验证（跳过：docker 不可用）');
    return summary();
  }
  tmpDir = mkdtempSync(path.join(tmpdir(), 'acf-arch31o-'));

  for (const name of (run('docker', ['ps', '-a', '--filter', 'name=acf-arch31o-', '--format', '{{.Names}}']).stdout || '')
    .split('\n').map((s) => s.trim()).filter(Boolean)) {
    run('docker', ['rm', '-f', name]);
  }
  if (DOCKER_MODE) {
    const pg = run('docker', [
      'run', '-d', '--name', PG_CONTAINER,
      '-e', `POSTGRES_USER=${DB_USER}`, '-e', `POSTGRES_PASSWORD=${DB_PASS}`,
      '-e', 'POSTGRES_DB=autoflow_test', '-p', `${PG_PORT}:5432`, 'postgres:16-alpine',
    ]);
    if (pg.status !== 0) throw new Error(`PG 容器启动失败: ${pg.stderr}`);
    for (let i = 0; i < 40; i += 1) {
      if (run('docker', ['exec', PG_CONTAINER, 'pg_isready', '-U', DB_USER]).status === 0) break;
      await sleep(1000);
    }
    run('docker', ['exec', PG_CONTAINER, 'psql', '-U', DB_USER, '-d', 'postgres', '-c', `CREATE DATABASE "${DB_NAME}";`]);
  } else {
    const create = run('psql', ['-h', DB_HOST, '-p', String(PG_PORT), '-U', DB_USER, '-d', 'postgres', '-c', `CREATE DATABASE "${DB_NAME}";`], {
      env: { ...process.env, PGPASSWORD: DB_PASS },
    });
    if (create.status !== 0) throw new Error(`建库失败: ${create.stderr}`);
  }

  // 迁移链真跑（建出 event_outbox 等表）
  const migrate = run('npm', ['run', 'migration:run'], {
    cwd: API_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DB_HOST,
      DB_PORT: String(PG_PORT),
      DB_USERNAME: DB_USER,
      DB_PASSWORD: DB_PASS,
      DB_DATABASE: DB_NAME,
      REDIS_HOST: 'localhost',
      REDIS_PORT: '6379',
      JWT_SECRET: 'arch31o-jwt-secret-32chars-long-her',
      JWT_REFRESH_SECRET: 'arch31o-refresh-secret-32chars-lo',
      EXECUTOR_SECRET: 'arch31o-executor-secret',
    },
  });
  ok('空库迁移链真跑通过（event_outbox 就绪）', migrate.status === 0,
    migrate.stderr || migrate.stdout);
  if (migrate.status !== 0) return summary();

  const setup = client();
  await setup.connect();
  await setup.query('DELETE FROM event_outbox');
  // 插入待投行（列形状对齐实体）
  await setup.query(
    `INSERT INTO event_outbox ("eventId","eventType","payload","dispatchedAt","attempts","deadLettered","createdAt")
     SELECT 'arch31o:'||g, 'execution.failed', '{"event":"execution.failed"}'::jsonb, NULL, 0, false, now()
     FROM generate_series(1, $1) g`,
    [ROWS],
  );
  const inserted = Number((await setup.query('SELECT count(*) c FROM event_outbox')).rows[0].c);
  ok(`插入 ${inserted} 行待投 outbox`, inserted === ROWS, `inserted=${inserted}`);

  // ── ① 双会话并发 claim：同轮排他性 ────────────────────────────────
  const A = client();
  const B = client();
  await A.connect();
  await B.connect();

  const claimedByA = new Map();
  const claimedByB = new Map();
  let overlap = 0;
  let totalClaims = 0;

  for (let round = 1; round <= ROUNDS; round += 1) {
    // 每轮把租约清空（模拟租约过期），让两个会话有真实的抢同一批行的机会
    await setup.query('UPDATE event_outbox SET "leaseUntil" = NULL');
    const [ra, rb] = await Promise.all([claimOnce(A, 'A'), claimOnce(B, 'B')]);
    totalClaims += ra.length + rb.length;
    const idsA = new Set(ra.map((r) => r.id));
    for (const r of rb) if (idsA.has(r.id)) overlap += 1;
    for (const r of ra) claimedByA.set(r.id, (claimedByA.get(r.id) ?? 0) + 1);
    for (const r of rb) claimedByB.set(r.id, (claimedByB.get(r.id) ?? 0) + 1);
  }
  console.log(`  两会话共 ${totalClaims} 次 claim`);
  ok('① 同一轮内没有任何一行被两个实例同时租到（FOR UPDATE SKIP LOCKED 排他）',
    overlap === 0, `同轮重叠=${overlap}`);

  // ② 渐进覆盖：两实例并行扫描 + 每轮把本轮租到的行标记已投递（模拟真实推进），
  // 断言最终覆盖全部行——SKIP LOCKED 不会让某个实例或某一行被永久饿死。
  await setup.query('UPDATE event_outbox SET "leaseUntil" = NULL, "leaseToken" = NULL, "dispatchedAt" = NULL');
  const seen = new Set();
  let rounds = 0;
  const maxRounds = ROWS * 3;
  while (seen.size < ROWS && rounds < maxRounds) {
    rounds += 1;
    const [ra, rb] = await Promise.all([claimOnce(A, 'A-cover'), claimOnce(B, 'B-cover')]);
    const ids = [...ra, ...rb].map((r) => r.id);
    if (ids.length === 0) break;
    for (const id of ids) seen.add(id);
    await setup.query('UPDATE event_outbox SET "dispatchedAt" = now() WHERE id = ANY($1::uuid[])', [ids]);
  }
  ok('② 两实例并行推进最终覆盖全部行（无永久饿死）',
    seen.size === ROWS, `覆盖=${seen.size}/${ROWS}（${rounds} 轮）`);

  // ── ③ 活跃租约不被抢 ────────────────────────────────────────────
  // 先把上一步的投递终态复位（否则全部行已是 dispatchedAt 非空，无人可 claim）
  await setup.query(
    'UPDATE event_outbox SET "dispatchedAt" = NULL, "leaseUntil" = NULL, "leaseToken" = NULL',
  );
  const held = await claimOnce(A, 'A-hold');
  const heldIds = new Set(held.map((r) => r.id));
  const stolen = [];
  for (let i = 0; i < 3; i += 1) {
    const rb = await claimOnce(B, `B-try${i}`);
    for (const r of rb) if (heldIds.has(r.id)) stolen.push(r.id);
  }
  ok('③ 活动租约内的行不会被另一个实例抢走（leaseUntil 谓词）',
    stolen.length === 0 && heldIds.size > 0,
    `A 持有 ${heldIds.size} 行，B 三轮抢到其中 ${stolen.length} 行`);

  // ── ④ 租约过期可回收（实例崩溃后行不永久卡死）────────────────────
  // 让「崩溃实例持有的那一行」成为最早可投行（createdAt 提前）+ 租约过期，
  // 再断言另一实例恰好回收它（而不是恰巧取到别的行）。
  const crashRow = [...heldIds][0];
  await setup.query(
    'UPDATE event_outbox SET "dispatchedAt" = NULL, "leaseUntil" = NULL, "leaseToken" = NULL',
  );
  await setup.query(
    `UPDATE event_outbox
       SET "createdAt" = now() - interval '10 minutes',
           "leaseUntil" = now() - interval '5 minutes',
           "leaseToken" = 'crashed-instance-token'
     WHERE id = $1`,
    [crashRow],
  );
  const reclaimed = await claimOnce(B, 'B-reclaim');
  ok('④ 租约过期（实例崩溃）后该行可被另一实例回收',
    reclaimed.some((r) => r.id === crashRow),
    `期望回收 ${crashRow}，实得 ${reclaimed.map((r) => r.id).join(',') || '(空)'}`);

  // ── ⑤ 终态行不再被 claim（dispatchedAt / deadLettered）────────────
  await setup.query('UPDATE event_outbox SET "dispatchedAt" = now(), "leaseUntil" = NULL');
  const afterSettle = await claimOnce(B, 'B-after-settle');
  ok('⑤ 已投递（dispatchedAt 非空）的行不再被任何实例 claim',
    afterSettle.length === 0, `仍被 claim=${afterSettle.length}`);

  await A.end();
  await B.end();
  await setup.end();
  summary();
}

function summary() {
  const passed = results.filter((r) => r.pass === true).length;
  const failed = results.filter((r) => r.pass === false).length;
  const skipped = results.filter((r) => r.pass === null).length;
  console.log(`\n══ 汇总：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过 ══`);
  process.exit(failed > 0 ? 1 : 0);
}

function cleanup() {
  run('docker', ['rm', '-f', PG_CONTAINER]);
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

main().catch((e) => {
  console.error(`✘ 验证脚本异常：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
