// selftests 系列脚本共享的 PG 供给助手：等待就绪 + 确保目标库存在。
//
// 为什么需要它（CI 实测，2026-09-14）：
//   原各 selftest 脚本的就绪判据是 `docker exec <pg> pg_isready -U <user>`——
//   不带 -h 时走容器内 unix socket。而官方 postgres 镜像的 entrypoint 在 initdb
//   阶段会先起一个**临时服务**（listen_addresses=''）跑初始化脚本，socket 版
//   pg_isready 此时就返回 0；临时服务随即被停掉、真正服务重启。落在该窗口里的
//   `docker exec psql -c 'CREATE DATABASE ...'` 会失败，而原实现**不检查返回码**，
//   于是失败被静默吞掉，直到后续迁移步骤才以
//   `database "xxx" does not exist` 暴露——错误现象与真实原因相距甚远。
//   实测：同一 job 内 multi-instance 因容器启动更慢恰好避开该窗口而通过，
//   outbox-claim 则在 3.3s 内"就绪"并静默建库失败。属竞态，非确定性。
//
// 本模块的做法：
//   1. 用**与迁移完全相同的连接路径**（host TCP → 容器映射口）轮询就绪，
//      而非容器内 socket——TCP 口只在真正服务起来后才可用，不会误判；
//   2. 建库带**有界重试**，仅对瞬态错误（服务启动中/连接重置）重试，
//      其它错误立即失败以免掩盖真因；
//   3. 失败时抛出**可读原因**，不再静默。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(path.resolve(HERE, '..'), 'apps', 'admin-api');

// pg 只装在 apps/admin-api（根 node_modules 没有），沿用各 selftest 既有的
// createRequire 解析方式，不为 scripts/ 新增依赖。
const requireFromApi = createRequire(path.join(API_DIR, 'noop.js'));
const { Client } = requireFromApi('pg');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PG 错误码：库已存在——幂等场景下视为成功。 */
const DUPLICATE_DATABASE = '42P04';
/** 瞬态错误码：服务正在启动/关闭、连接被拒/重置——值得重试。 */
const TRANSIENT_CODES = new Set([
  '57P03', // cannot_connect_now（the database system is starting up）
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08006', // connection_failure
  'ECONNREFUSED',
  'ECONNRESET',
]);

/**
 * 轮询直到 host:port 能建立 TCP 连接（即迁移能连上的那一刻）。
 * @param {{host: string, port: number|string, user: string, password: string, timeoutMs?: number}} o
 * @returns {Promise<void>} 超时抛错（含最后一次连接失败原因）
 */
export async function waitForPostgres({
  host,
  port,
  user,
  password,
  timeoutMs = 90_000,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    const c = new Client({
      host,
      port: Number(port),
      user,
      password,
      database: 'postgres',
    });
    try {
      await c.connect();
      await c.end();
      return;
    } catch (e) {
      lastErr = e;
      await c.end().catch(() => {});
      await sleep(1000);
    }
  }
  throw new Error(
    `PG 就绪等待超时（${host}:${port}，${timeoutMs}ms）：${lastErr?.message || lastErr}`,
  );
}

/**
 * 确保目标库存在（幂等：已存在视为成功）。
 *
 * @param {{host: string, port: number|string, user: string, password: string,
 *          dbName: string, timeoutMs?: number, dropFirst?: boolean}} o
 *   dropFirst=true 时先 DROP IF EXISTS 再建，用于需要"空库"语义的套件。
 * @returns {Promise<void>} 失败抛错（含原因）
 */
export async function ensureDatabase({
  host,
  port,
  user,
  password,
  dbName,
  timeoutMs = 90_000,
  dropFirst = false,
}) {
  await waitForPostgres({ host, port, user, password, timeoutMs });

  let lastErr = null;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const c = new Client({
      host,
      port: Number(port),
      user,
      password,
      database: 'postgres',
    });
    try {
      await c.connect();
      // DROP/CREATE DATABASE 均不能在事务块内执行；pg 默认 autocommit，直接发即可。
      if (dropFirst) await c.query(`DROP DATABASE IF EXISTS "${dbName}";`);
      try {
        await c.query(`CREATE DATABASE "${dbName}";`);
      } catch (e) {
        // 库已存在 = 目标状态已达成（幂等）。
        if (e.code !== DUPLICATE_DATABASE) throw e;
      }
      await c.end();
      return;
    } catch (e) {
      lastErr = e;
      await c.end().catch(() => {});
      // 非瞬态错误立即失败，避免把权限/语法问题拖成超时后报错。
      if (!TRANSIENT_CODES.has(e.code)) break;
      await sleep(1000);
    }
  }
  throw new Error(
    `建库失败（${host}:${port} → ${dbName}）：${lastErr?.message || lastErr}`,
  );
}
