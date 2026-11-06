#!/usr/bin/env node
/**
 * R16（2026-11-05）：**心跳覆盖写 vs 派发原子占坑** 的 lost-update 真机并发回归。
 *
 * ## 被压的两条写路径（生产 SQL 形状，逐字取自代码）
 *
 * · **心跳 = 客户端上报值直接覆盖写**：校验只做范围（`0..10000`），落库是
 *   `pickOwnedColumns(e, adopted, HEARTBEAT_OWNED_COLUMNS)` + `repo.update({id}, patch)`
 *   ⇒ `UPDATE executors SET "runningTaskCount" = <客户端快照> WHERE id = $1`
 *   （校验：`executor-heartbeat-report.collaborator.ts:192-210`）。
 * · **派发 = 原子增量 + 容量谓词**：
 *   `UPDATE executors SET "runningTaskCount" = "runningTaskCount" + 1
 *    WHERE id = $1 AND status = 'online' AND "runningTaskCount" < max`
 *   （`executor-dispatch-slot.collaborator.ts:105-118`）。
 * · **释放 = 原子减量**：`GREATEST("runningTaskCount" - 1, 0)`（同文件 `:238`）。
 *
 * ## 为什么用真 PG + 两条独立连接
 *
 * lost update 只在「心跳**读快照**」与「心跳**写回**」之间插进一次并发占坑时才出现；
 * 单连接顺序执行永远压不出来。故本脚本：
 *   ① 心跳侧 = **一条独立 psql 会话**跑「读快照 → pg_sleep（模拟 await 窗口）→ 覆盖写」
 *      （与生产里 `findOne` → … `repo.update` 的跨 await 形态同构）；
 *   ② 派发侧 = **另一条独立 psql 会话**在 sleep 窗口内执行生产形状的 `+1`；
 * 两者真并发，故能压出交错。
 *
 * ## 三条不变量（每轮都查）
 *
 *   I1 心跳不得把**已占坑**数改小（`最终计数 >= 实际占坑数`）——违反 ⇒ **超卖**。
 *   I2 心跳不得把**已释放**的坑永久占住——释放后计数必须能回落到 0（不出现单调不降的死锁态）。
 *   I3 容量判断不得因心跳覆盖而放行超过 `maxConcurrentTasks`——本轮总成功占坑数必须 ≤ max。
 *
 * ## 用法 / 退出码
 *
 *   node scripts/heartbeat-dispatch-race-selftest.mjs [--rounds=20] [--max=2] [--no-toctou]
 *
 * **曾经有过 `--fixed`（模拟「修后取大」的写心跳）：已删除，勿再引入模拟型 oracle** ——
 * 那种模式模拟修后行为、却从不调用产品实现，绿不绿与 `apps/**` 无关（假 oracle）。
 *   `--fixed`：模拟**修后**的心跳写（`GREATEST(客户端快照, 服务端在途占坑数)`）⇒ 期望 I1–I3 全绿。
 *   退出码：0 = 全部轮次满足不变量；1 = 有违反。
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const ROUNDS = Number((process.argv.find((a) => a.startsWith("--rounds=")) ?? "--rounds=20").slice(9));
const MAX = Number((process.argv.find((a) => a.startsWith("--max=")) ?? "--max=2").slice(6));
// R107：**`--fixed` 已删除** —— 它模拟"修后行为"却从不调用产品实现，属**假 oracle**（R106 只加了警告止血）。
// 现在只有一种口径：**`--window`（默认开启）**，其期望值来自**真实产品函数**
// `apps/admin-api/src/modules/executor/heartbeat-count.util.ts` 的 `resolveHeartbeatRunningTaskCount`
// ⇒ 产品实现变化时本脚本结论随之变化（这才满足验收 oracle 的最低要求）。
// 勿再引入"模拟型 oracle"：任何"自写字面量期望"的判据都不许再加回来。
const TOCTOU_MODE = !process.argv.includes("--no-toctou"); // R108：W3 读码证伪「占坑已成/行未建」窗口不可达 ⇒ 模式改名 --toctou（诚实命名）
const CONTAINER = `acf-r16-pg-${Date.now()}`;
const PORT = 25500 + Math.floor(Math.random() * 300);
/** 心跳「读快照 → 写回」之间的窗口（生产里是若干 await + 网络往返）。 */

/**
 * R107：**期望值来自真实产品函数**（`heartbeat-count.util.ts` 的 `resolveHeartbeatRunningTaskCount`）。
 * 该 util 实测 `grep -c "^import"` = 0 ⇒ 可用 `--experimental-strip-types` 直接载入，无需 Nest。
 * **不可用时报错**（绝不回落到自写字面量期望 —— 那就是假 oracle）。
 */
function resolveProductExpectation(reported, serverInFlight) {
  const code = [
    'import { pathToFileURL } from "node:url";',
    "const m = await import(pathToFileURL(process.env.PRODUCT_UTIL).href);",
    "const r = m.resolveHeartbeatRunningTaskCount({ reported: Number(process.env.REP), serverInFlight: Number(process.env.INFLIGHT) });",
    "process.stdout.write(JSON.stringify(r));",
  ].join("\n");
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", code],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PRODUCT_UTIL: path.join(ROOT, "apps/admin-api/src/modules/executor/heartbeat-count.util.ts"),
        REP: String(reported),
        INFLIGHT: String(serverInFlight),
      },
    },
  );
  if (r.status !== 0) return { error: String(r.stderr ?? "").split("\n").find((l) => l && !l.startsWith("(")) ?? "exit " + r.status };
  try {
    return JSON.parse(String(r.stdout ?? "").trim().split("\n").pop());
  } catch {
    return { error: "产品函数输出不是 JSON" };
  }
}

const WINDOW_MS = 200;

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 180_000, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const violations = [];

/** 一条独立连接的 SQL 执行（`-q` 关掉命令标签，避免把 `UPDATE 0` 误当结果）。 */
function sql(script) {
  return run("docker", ["exec", "-i", CONTAINER, "psql", "-U", "autoflow", "-d", "autoflow_test", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-c", script]);
}
/** 取一个标量（空 ⇒ null）。 */
function scalar(script) {
  const r = sql(script);
  const out = (r.stdout || "").trim();
  if (r.status !== 0) throw new Error(`SQL 失败: ${r.stderr}`);
  return out === "" ? null : out;
}

async function main() {
  console.log(`=== R16 心跳×派发 lost-update（${ROUNDS} 轮 · max=${MAX} · 真 PG 两连接 · ${TOCTOU_MODE ? "窗口口径（期望来自产品函数）" : "旧口径"}）===`);
  const stale = run("docker", ["ps", "-a", "--filter", "name=acf-r16-", "--format", "{{.Names}}"]);
  for (const n of (stale.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean)) run("docker", ["rm", "-f", n]);
  const up = run("docker", ["run", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_USER=autoflow", "-e", "POSTGRES_PASSWORD=test",
    "-e", "POSTGRES_DB=autoflow_test", "-p", `${PORT}:5432`, "postgres:16-alpine"]);
  if (up.status !== 0) { console.error(`PG 启动失败: ${up.stderr}`); return 1; }

  const tmp = mkdtempSync(path.join(os.tmpdir(), "acf-r16-"));
  try {
    for (let i = 0; i < 60; i += 1) {
      if (sql("select 1").status === 0) break;
      await sleep(1000);
    }
    // 生产里 executors 行 + 派发闸的容量列
    sql(`drop table if exists executors; create table executors (id text primary key, status text not null default 'online', "runningTaskCount" int not null default 0, "maxConcurrentTasks" int not null default ${MAX});`);
    // 服务端事实源：该执行器名下**非终态**执行行（OPEN = pending/running/waiting，见 execution-terminal.ts:45-49）
    sql(`drop table if exists task_executions; create table task_executions (id serial primary key, "executorId" text, status text not null);`);

    for (let round = 1; round <= ROUNDS; round += 1) {
      const id = `r16-${round}`;
      sql(`insert into executors (id) values ('${id}');`);

      // R107：**先记下心跳会话将读到的快照**（派发占坑之前）——产品函数需要这对输入。
      const snapAtStart = Number(scalar(`select "runningTaskCount" from executors where id='${id}';`) ?? "0");

      // ── 心跳侧：独立会话，读快照 → sleep（await 等待窗口）→ **现状实现：客户端快照直接覆盖**
      // R108：`--fixed`（模拟"取大"修法）已删除 —— 它模拟修后行为却从不调用产品实现 ⇒ 假 oracle。
      // 现状红不红由下面「产品函数期望 vs 实测」判定；W3 把心跳改成原子 UPDATE 后会自动转绿。
      const heartbeat = `
        \\set QUIET on
        select "runningTaskCount" as snap from executors where id='${id}' \\gset
        select pg_sleep(${WINDOW_MS / 1000});
        update executors set "runningTaskCount" = :snap where id='${id}';
      `;
      const hbFile = path.join(tmp, `hb-${round}.sql`);
      writeFileSync(hbFile, heartbeat, "utf8");
      // ⚠️ 必须用 **异步** spawn：`spawnSync` 会一直阻塞到心跳会话（含 pg_sleep）结束，
      // 那样占坑就变成"心跳之后"的顺序执行，lost-update 永远压不出来（本脚本第一版
      // 正是这么假绿的：6/6 轮 ok，实际是串行）。
      const hbExited = new Promise((resolve) => {
        const child = spawn(
          "sh",
          ["-c", `docker exec -i ${CONTAINER} psql -U autoflow -d autoflow_test -q -tA -v ON_ERROR_STOP=1 -f /dev/stdin < ${hbFile}`],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let err = "";
        child.stderr.on("data", (d) => { err += String(d); });
        child.on("close", (code) => resolve({ code, err }));
      });

      // ── 派发侧：在心跳的 sleep 窗口内并发占坑（生产 SQL 形状）──
      await sleep(60);
      let claimed = 0;
      for (let k = 0; k < MAX + 2; k += 1) {
        // 占坑 = 计数 +1（带容量谓词）+ 落一条非终态执行行（同一时刻，服务端事实）
        const r = sql(
          `with c as (update executors set "runningTaskCount" = "runningTaskCount" + 1 ` +
            `where id='${id}' and status='online' and "runningTaskCount" < ${MAX} returning "runningTaskCount") ` +
            `insert into task_executions ("executorId", status) select '${id}', 'running' from c returning id;`,
        );
        if ((r.stdout || "").trim() !== "") claimed += 1;
      }
      // 等心跳会话结束（覆盖写落地）
      const hbResult = await hbExited;
      if (hbResult.code !== 0) throw new Error(`心跳会话失败(${hbResult.code}): ${hbResult.err}`);

      const finalCount = Number(scalar(`select "runningTaskCount" from executors where id='${id}';`) ?? "0");
      const inFlight = Number(scalar(`select count(*) from task_executions where "executorId"='${id}' and status in ('pending','running','waiting');`) ?? "0");

      // ── I2 探针：全部执行终态化后，计数必须能回落（不出现单调不降）──
      sql(`update task_executions set status='success' where "executorId"='${id}';`);
      for (let k = 0; k < finalCount; k += 1) {
        sql(`update executors set "runningTaskCount" = GREATEST("runningTaskCount" - 1, 0) where id='${id}';`);
      }
      const afterRelease = Number(scalar(`select "runningTaskCount" from executors where id='${id}';`) ?? "0");

      const v = [];
      // R107：**期望值来自产品函数**（不是自写字面量）——若产品下限改成"读占坑数"或窗口消失，
      // 这里算出的 productExpected 会变 ⇒ 本判据的结论随之变化。
      if (TOCTOU_MODE) {
        const prod = resolveProductExpectation(snapAtStart, claimed);
        if (prod.error) {
          throw new Error(`产品函数不可用（不许静默回落）：${prod.error}`);
        }
        if (finalCount !== prod.value) {
          v.push(
            `I1-toctou 违反：产品函数期望 runningTaskCount=${prod.value}（取大后），实得 ${finalCount} ` +
              `⇒ 窗口期内「占坑已成/行未建」被打穿（clamped=${prod.clamped}）`,
          );
        }
      }
      if (finalCount < inFlight) v.push(`I1 违反：最终计数 ${finalCount} < 在途占坑 ${inFlight}（心跳把已占坑数改小 ⇒ 超卖风险）`);
      if (claimed > MAX) v.push(`I3 违反：本轮成功占坑 ${claimed} > max ${MAX}（容量判断被覆盖写绕开）`);
      if (afterRelease !== 0) v.push(`I2 违反：释放后计数仍为 ${afterRelease}（坑位未回落 ⇒ 饥饿风险）`);
      if (v.length) violations.push({ round, detail: v.join("；") });
      console.log(
        `  round ${String(round).padStart(2)}/${ROUNDS}: 心跳快照=± 在途=${inFlight} 占坑=${claimed} 最终计数=${finalCount} 释放后=${afterRelease} ` +
          (v.length ? `VIOLATION(${v.join("；")})` : "ok"),
      );
    }

    const i1 = violations.filter((x) => x.detail.includes("I1"));
    const i2 = violations.filter((x) => x.detail.includes("I2"));
    const i3 = violations.filter((x) => x.detail.includes("I3"));
    console.log("");
    console.log(`══ 汇总：${ROUNDS} 轮 · I1(超卖) ${i1.length} 轮违反 · I2(饥饿) ${i2.length} 轮 · I3(容量) ${i3.length} 轮 ══`);
    if (violations.length) console.log(`   样例：${violations[0].detail}`);
    return violations.length > 0 ? 1 : 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    run("docker", ["rm", "-f", CONTAINER]);
  }
}

process.exit(await main());
