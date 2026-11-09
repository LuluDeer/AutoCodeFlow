/**
 * verify-smoke-s3.mjs —— 场景 1（写入路径）+ 场景 2（读取路径）的真机验证。
 *
 * ## 真机面
 *
 * · **RustFS 1.0.4** 真容器（S3 兼容，Apache-2.0）——不是 mock、不是替身。
 * · **admin-api 真进程**（`LOG_STORAGE_DRIVER=s3`），走**真 HTTP 回调端点**
 *   `POST /api/executions/callback`（执行器回传终态 + 日志的那条路）。
 * · **真 PG**：执行行、`execution_log_lines` 行、`logStorage`/`logObjectKey` 指针。
 *
 * ## 为什么用「回调端点」而不是直接调 service
 *
 * 本轮验的是**链路**（写入/读取/回收三个面），不是某个方法的返回值。
 * 走 HTTP 回调 ⇒ 真实的「派发 → 终态回调 → 日志落对象存储」全链都被覆盖，
 * 与生产执行器回传日志的那条路**同一条**。
 *
 * ## 三个场景
 *
 *   ① 写入路径：对象真的落到 RustFS（gzip 签名 1f8b）+ `execution_log_lines`
 *      **不写行** + `logStorage='s3'`/`logObjectKey` 指针正确。
 *   ② 读取路径：`GET /tasks/executions/:execId/logs` 取回完整日志，
 *      含**超过单页上限**的长日志（验证「完整日志外置」+ S3 侧分页）。
 *   ③ 保留期回收：见 verify-smoke-s3-retention.mjs（独立脚本）。
 *
 * 用法（容器内）：node /app/verify-smoke-s3.mjs
 */
import { createRequire } from "node:module";

const require = createRequire("/app/dist/data-source.js");
const { AppDataSource } = require("/app/dist/data-source.js");
const { Client } = require("minio");

const API = process.env.SMOKE_API_URL || "http://127.0.0.1:3105/api";
const EXEC_SECRET = process.env.SMOKE_EXEC_SECRET || "";
const ADMIN_PW = process.env.SMOKE_ADMIN_PW || "";
const RUSTFS_ENDPOINT = process.env.SMOKE_RUSTFS_ENDPOINT || "acfsmoke-rustfs:9000";
const RUSTFS_AK = process.env.SMOKE_RUSTFS_ACCESS_KEY || "";
const RUSTFS_SK = process.env.SMOKE_RUSTFS_SECRET_KEY || "";
const BUCKET = process.env.SMOKE_LOG_BUCKET || "autoflow-logs";

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass += 1; };
const bad = (m) => { console.log(`  ✗ ${m}`); fail += 1; };
const step = (m) => console.log(`\n=== ${m} ===`);

const s3 = new Client({
  endPoint: RUSTFS_ENDPOINT.split(":")[0],
  port: Number(RUSTFS_ENDPOINT.split(":")[1] || 9000),
  useSSL: false,
  accessKey: RUSTFS_AK,
  secretKey: RUSTFS_SK,
});

/** 列出 bucket 里所有对象（含大小） */
async function listObjects() {
  const out = [];
  for await (const o of s3.listObjectsV2(BUCKET, "", true)) {
    out.push({ name: o.name, size: o.size, etag: o.etag });
  }
  return out;
}

/** 取回对象原始字节（minio 的 getObject 返回 Node Readable，不是 async iterable） */
async function getObjectBytes(name) {
  const stream = await s3.getObject(BUCKET, name);
  const chunks = [];
  for await (const ch of stream) chunks.push(ch);
  return Buffer.concat(chunks);
}

/** 对象元数据（size + Content-Encoding + etag）——「对象真的存在」的证据 */
async function statObject(name) {
  return s3.statObject(BUCKET, name);
}

/** 对象是否仍存在 */
async function objectExists(name) {
  try {
    await s3.statObject(BUCKET, name);
    return true;
  } catch {
    return false;
  }
}

async function api(path, { method = "GET", token, body, raw } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, text };
  }
}

async function main() {
  const ds = await AppDataSource.initialize();
  console.log(`[harness] pg connected: ${ds.options.database}@${ds.options.host}:${ds.options.port}`);

  const taskRepo = ds.getRepository(require("/app/dist/modules/task/entities/task.entity.js").Task);

  // ═══ 跑前清理（幂等的前提）══════════════════════════════════════════
  //
  // 本脚本造的行/对象：
  //   · tasks(name like 'smoke-s3-%')   ← seed task（名字带 Date.now()）
  //   · task_executions(taskId = 那个 task) ← 两个执行行（含 2500 行长日志那个）
  //   · execution_log_lines(那两个 executionId) ← 回退路径可能写的行
  //   · S3 对象 execution-logs/<execId>.log.gz ← **键按 executionId 确定性复用**
  //
  // ⚠️ **为什么必须"跑前"而不是"跑后"**：
  //   · 上一轮跑到一半失败 ⇒ S3 里留下 `execution-logs/<旧 execId>.log.gz`
  //     ⇒ 那些对象**永远不会被覆盖**（键含 executionId）⇒ 变成惰性垃圾，
  //     而且本脚本的「对象真在 RustFS 里」断言会被**上一轮的残留对象干扰**；
  //   · DB 里残留的执行行 ⇒ 「execution_log_lines 行数 = 0」的断言的对照组被污染。
  //   ⇒ 跑**开始时**按前缀清干净并**验证计数 = 0** ⇒ 上次失败能被下次自动修复。
  //
  // ⚠️ **清理范围严格限定在自己的前缀内** —— 绝不 `DELETE FROM tasks`。
  step("0. 跑前清理（只删本脚本自己造的 smoke-s3-* 数据/对象，并验证计数 = 0）");
  const TASK_PAT = "smoke-s3-%";
  // ① 先取本前缀任务的历史执行行 id（用于删 S3 对象 + 日志行）
  const staleExecIds = (await ds.query(
    `SELECT id::text FROM task_executions WHERE "taskId" IN (
       SELECT id FROM tasks WHERE name LIKE $1)`, [TASK_PAT])).map((r) => r.id);
  // ② S3 对象：只删**本前缀任务的历史执行行**对应的对象（不碰别的键）
  for (const eid of staleExecIds) {
    try {
      await s3.removeObject(BUCKET, `execution-logs/${eid}.log.gz`);
    } catch {
      /* 对象可能已不存在 */
    }
  }
  // ③ 子表 → 主表（每句都带 WHERE + 自己的前缀）
  await ds.query(
    `DELETE FROM execution_log_lines WHERE "executionId" IN (
       SELECT id::text FROM task_executions WHERE "taskId" IN (
         SELECT id FROM tasks WHERE name LIKE $1))`, [TASK_PAT]);
  await ds.query(
    `DELETE FROM task_executions WHERE "taskId" IN (
       SELECT id FROM tasks WHERE name LIKE $1)`, [TASK_PAT]);
  // ⚠️ audit_logs 是**追加只读**表（迁移 1790000000006 的 trg_audit_logs_append_only
  //    触发器：DELETE/UPDATE 一律 RAISE EXCEPTION）⇒ 必须走会话 GUC 逃生门
  //    `app.bypass_audit_guard = 'on'`（生产审计服务的 retention 路径同款）。
  //    ⇒ SET LOCAL 只在**事务内**有效 ⇒ 必须 BEGIN…COMMIT 包起来。
  await ds.query(`BEGIN`);
  await ds.query(`SET LOCAL app.bypass_audit_guard = 'on'`);
  await ds.query(
    `DELETE FROM audit_logs WHERE "resourceId" IN (
       SELECT id::text FROM tasks WHERE name LIKE $1) AND action LIKE 'task.%'`, [TASK_PAT]);
  await ds.query(`COMMIT`);
  await ds.query(`DELETE FROM tasks WHERE name LIKE $1`, [TASK_PAT]);
  // ④ **验证清理生效**
  const residue = {
    tasks: Number((await ds.query(`SELECT count(*)::int AS n FROM tasks WHERE name LIKE $1`, [TASK_PAT]))[0].n),
    execs: Number((await ds.query(
      `SELECT count(*)::int AS n FROM task_executions WHERE "taskId" IN (
         SELECT id FROM tasks WHERE name LIKE $1)`, [TASK_PAT]))[0].n),
  };
  console.log(`[harness] 跑前清理后残留：${JSON.stringify(residue)}（历史执行行 ${staleExecIds.length} 个）`);
  Object.values(residue).every((n) => n === 0)
    ? ok("跑前清理生效：本前缀残留 = 0（tasks / task_executions 全为 0）")
    : bad(`跑前清理未生效：残留 ${JSON.stringify(residue)} ⇒ 中止（不带着脏数据继续跑）`);
  if (!Object.values(residue).every((n) => n === 0)) {
    await ds.destroy();
    process.exit(1);
  }

  // ── 登录拿 JWT（建任务用）────────────────────────────────────────────
  const login = await api("/auth/login", {
    method: "POST",
    body: { username: "admin", password: ADMIN_PW },
  });
  const token = login.json?.data?.accessToken;
  if (!token) throw new Error(`login failed: ${JSON.stringify(login.json).slice(0, 300)}`);
  console.log("[harness] admin login ok");

  // ── 建一个 manual 任务（manual 不需要执行器在线）────────────────────
  const taskName = `smoke-s3-${Date.now()}`;
  const created = await api("/tasks", {
    method: "POST",
    token,
    body: {
      name: taskName,
      triggerType: "manual",
      runtime: "node",
      timeout: 30,
      maxRetry: 0,
      glueSource: "console.log('smoke');",
      glueLanguage: "javascript",
    },
  });
  const taskId = created.json?.data?.id;
  if (!taskId) throw new Error(`task create failed: ${JSON.stringify(created.json).slice(0, 300)}`);
  console.log(`[harness] task ${taskName} id=${taskId}`);

  // ── 触发 ⇒ 拿到 PENDING 执行行 ───────────────────────────────────────
  const trig = await api(`/tasks/${taskId}/trigger`, { method: "POST", token, body: {} });
  const execId = trig.json?.data?.id;
  if (!execId) throw new Error(`trigger failed: ${JSON.stringify(trig.json).slice(0, 300)}`);
  console.log(`[harness] execution id=${execId}`);

  // ── 把执行行摆成「已派发且在跑」──────────────────────────────────────
  // 理由（代码事实）：回调面拒收「status ∈ {pending, waiting} 且 executorAddress
  // 为 null」的执行（R-16/B-7：没派发的执行不许被回调成终态）。本栈没有在线
  // 执行器 ⇒ 派发必然失败 ⇒ 手工摆成 running + executorAddress，再走真回调。
  await ds.query(
    `UPDATE task_executions SET status='running', "executorAddress"=$1, "logStorage"=NULL, "logObjectKey"=NULL, "endTime"=NULL WHERE id=$2`,
    ["smoke-exec-addr", execId],
  );

  // ═══ 场景 1：写入路径 ════════════════════════════════════════════════
  step("场景 1 · 写入路径（LOG_STORAGE_DRIVER=s3）");

  // 日志内容：带 ERROR/INFO 两种级别（读面要验 level 过滤）
  // ⚠️ 级别标记必须在**行首**（levelOfLine 的 LEVEL_MARKER_RE 是
  // `^\s*\[?(ERROR|WARN|WARNING|INFO|DEBUG)\]?[:\s]`）⇒ 用 `[ERROR] ...` 形态。
  // 写成 "smoke-1 ERROR ..." 会推断不到级别（返回 null）⇒ 那是**测试数据**问题，
  // 不是生产缺陷（级别词出现在行中间本来就不该被识别）。
  const logText = [
    "[ERROR] smoke-1 alpha failure",
    "[INFO] smoke-2 beta ok",
    "[ERROR] smoke-3 gamma failure",
    "[INFO] smoke-4 delta ok",
  ].join("\n");

  // 回调面是 @Public + 执行器共享令牌 ⇒ 不带 JWT，用 EXECUTOR_SECRET
  const cbRes = await fetch(`${API}/executions/callback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${EXEC_SECRET}`,
    },
    body: JSON.stringify([
      { executionId: execId, status: "success", logs: logText, executorAddress: "smoke-exec-addr" },
    ]),
  });
  const cbJson = await cbRes.json();
  const cbOk = cbJson?.data?.results?.[0]?.success === true;
  cbOk
    ? ok(`终态回调被受理（HTTP ${cbRes.status}，success=true）`)
    : bad(`终态回调被拒：HTTP ${cbRes.status} ${JSON.stringify(cbJson).slice(0, 300)}`);

  // ①a. DB 指针
  const row = await ds.query(
    `SELECT "logStorage", "logObjectKey", status FROM task_executions WHERE id=$1`,
    [execId],
  );
  const { logStorage, logObjectKey, status } = row[0];
  logStorage === "s3"
    ? ok(`task_executions.logStorage = 's3'`)
    : bad(`logStorage 应为 's3'，实际 '${logStorage}'`);
  const expectedKey = `execution-logs/${execId}.log.gz`;
  logObjectKey === expectedKey
    ? ok(`task_executions.logObjectKey = ${logObjectKey}（键格式 = execution-logs/<execId>.log.gz）`)
    : bad(`logObjectKey 应为 ${expectedKey}，实际 '${logObjectKey}'`);

  // ①b. execution_log_lines 不写行（S3 成功路径的设计）
  const lines = await ds.query(
    `SELECT count(*)::int AS n FROM execution_log_lines WHERE "executionId"=$1`,
    [execId],
  );
  lines[0].n === 0
    ? ok(`execution_log_lines 行数 = 0（S3 成功路径**不写 DB 行**，设计如此）`)
    : bad(`execution_log_lines 行数 = ${lines[0].n}（S3 成功路径应为 0）`);

  // ①c. 对象真的在 RustFS 里 + gzip 签名
  const objects = await listObjects();
  const found = objects.find((o) => o.name === expectedKey);
  found
    ? ok(`RustFS bucket '${BUCKET}' 里存在对象 ${found.name}（size=${found.size}, etag=${found.etag}）`)
    : bad(`RustFS 里没有对象 ${expectedKey}（当前 bucket 对象：${objects.map((o) => o.name).join(",") || "无"}）`);
  if (found) {
    const st = await statObject(expectedKey);
    const ce = st.metaData?.["content-encoding"];
    ce === "gzip"
      ? ok(`对象元数据 Content-Encoding = gzip（size=${st.size}）`)
      : bad(`对象 Content-Encoding 应为 gzip，实际 '${ce}'`);
    const bytes = await getObjectBytes(expectedKey);
    const magic = bytes[0].toString(16) + bytes[1].toString(16);
    magic === "1f8b"
      ? ok(`对象字节是 gzip 魔数（magic=1f8b，${bytes.length} 字节）`)
      : bad(`对象不是 gzip（magic=${magic}）`);
    const zlib = require("node:zlib");
    const text = zlib.gunzipSync(bytes).toString("utf-8");
    text === logText
      ? ok(`解压内容与回调日志**逐字节一致**（${text.split("\n").length} 行）`)
      : bad(`解压内容不一致：得到 ${JSON.stringify(text.slice(0, 120))}`);
  }

  // ═══ 场景 2：读取路径 ════════════════════════════════════════════════
  step("场景 2 · 读取路径（getExecutionLogs，S3 驱动）");

  const read1 = await api(`/tasks/executions/${execId}/logs?fromLine=0&limit=10`, { token });
  const d1 = read1.json?.data;
  d1?.lines?.length === 4
    ? ok(`GET /tasks/executions/:id/logs 取回 ${d1.lines.length} 行（totalLines=${d1.totalLines}, hasMore=${d1.hasMore}）`)
    : bad(`读回行数不对：${JSON.stringify(d1).slice(0, 300)}`);
  Array.isArray(d1?.lines) && d1.lines[0] === logText.split("\n")[0]
    ? ok("读回内容与写入一致（第 1 行逐字节相同）")
    : bad("读回内容与写入不一致");

  // 分页：fromLine=2 只应拿第 3、4 行
  const read2 = await api(`/tasks/executions/${execId}/logs?fromLine=2&limit=10`, { token });
  const l2 = read2.json?.data?.lines ?? [];
  l2.length === 2 && l2[0] === "[ERROR] smoke-3 gamma failure"
    ? ok("分页 fromLine=2 ⇒ 只返回第 3、4 行（S3 侧物理行号游标）")
    : bad(`分页不对：${JSON.stringify(l2).slice(0, 200)}`);

  // level 过滤（S3 侧是解压后重新推断级别）
  const read3 = await api(`/tasks/executions/${execId}/logs?fromLine=0&limit=10&level=ERROR`, { token });
  const l3 = read3.json?.data;
  l3?.lines?.length === 2 && l3.totalLines === 2
    ? ok(`level=ERROR 过滤 ⇒ ${l3.lines.length} 行（totalLines=2，与 totalLines 语义一致）`)
    : bad(`level 过滤不对：${JSON.stringify(l3).slice(0, 200)}`);

  // ── 场景 2b：长日志（超过单页上限 2000 行）── 「完整日志外置」的设计 ──
  step("场景 2b · 长日志（超过单页上限 2000 行）");
  const BIG_LINES = 2500;
  const bigText = Array.from({ length: BIG_LINES }, (_, i) => `big-${i} INFO payload line`).join("\n");
  console.log(`[harness] 长日志 ${BIG_LINES} 行 / ${bigText.length} 字符`);
  const exec2 = await api(`/tasks/${taskId}/trigger`, { method: "POST", token, body: {} });
  const exec2Id = exec2.json?.data?.id;
  await ds.query(
    `UPDATE task_executions SET status='running', "executorAddress"=$1, "logStorage"=NULL, "logObjectKey"=NULL, "endTime"=NULL WHERE id=$2`,
    ["smoke-exec-addr", exec2Id],
  );
  const cb2 = await fetch(`${API}/executions/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${EXEC_SECRET}` },
    body: JSON.stringify([
      { executionId: exec2Id, status: "success", logs: bigText, executorAddress: "smoke-exec-addr" },
    ]),
  });
  const cb2Json = await cb2.json();
  cb2Json?.data?.results?.[0]?.success === true
    ? ok("长日志的终态回调被受理")
    : bad(`长日志回调被拒：${JSON.stringify(cb2Json).slice(0, 200)}`);

  const bigRow = await ds.query(
    `SELECT "logStorage", "logObjectKey" FROM task_executions WHERE id=$1`,
    [exec2Id],
  );
  const bigKey = bigRow[0].logObjectKey;
  const bigLines = await ds.query(
    `SELECT count(*)::int AS n FROM execution_log_lines WHERE "executionId"=$1`,
    [exec2Id],
  );
  bigRow[0].logStorage === "s3" && bigLines[0].n === 0
    ? ok(`长日志执行：logStorage='s3'，execution_log_lines 仍为 0 行（${bigLines[0].n}）`)
    : bad(`长日志执行：logStorage='${bigRow[0].logStorage}'，log lines=${bigLines[0].n}`);
  if (bigKey) {
    const bigBytes = await getObjectBytes(bigKey);
    console.log(`[harness] 长日志对象 ${bigKey}：${bigBytes.length} 字节（gzip 后）`);
  }

  // 读回第一页（limit=2000 上限）⇒ 应拿到 2000 行 + hasMore=true
  const bigRead = await api(`/tasks/executions/${exec2Id}/logs?fromLine=0&limit=2000`, { token });
  const bd = bigRead.json?.data;
  bd?.lines?.length === 2000 && bd.totalLines === BIG_LINES && bd.hasMore === true
    ? ok(`长日志首页：lines=${bd.lines.length}（上限 2000），totalLines=${bd.totalLines}（完整 ${BIG_LINES} 行），hasMore=${bd.hasMore}`)
    : bad(`长日志首页不对：${JSON.stringify({ n: bd?.lines?.length, t: bd?.totalLines, m: bd?.hasMore })}`);

  // 翻到第二页 ⇒ 补齐剩余 500 行，且无重复
  const bigRead2 = await api(`/tasks/executions/${exec2Id}/logs?fromLine=2000&limit=2000`, { token });
  const bd2 = bigRead2.json?.data;
  bd2?.lines?.length === BIG_LINES - 2000
    ? ok(`长日志第二页：lines=${bd2.lines.length}（${BIG_LINES}-2000），hasMore=${bd2.hasMore}`)
    : bad(`长日志第二页不对：${JSON.stringify({ n: bd2?.lines?.length, m: bd2?.hasMore })}`);
  const firstOfPage2 = bd2?.lines?.[0];
  firstOfPage2 === `big-2000 INFO payload line`
    ? ok("第二页首行 = big-2000（游标衔接正确，无重复无遗漏）")
    : bad(`第二页首行错位：${firstOfPage2}`);
  const lastOfPage2 = bd2?.lines?.[bd2.lines.length - 1];
  lastOfPage2 === `big-${BIG_LINES - 1} INFO payload line`
    ? ok(`第二页末行 = big-${BIG_LINES - 1}（最后一行可达）`)
    : bad(`第二页末行错位：${lastOfPage2}`);

  // ── 清理 seed ─────────────────────────────────────────────────────────
  // ⚠️ 必须连**对象**一起删：只删 DB 行的话，S3 里的对象会留下来（键按
  // executionId 确定性复用 ⇒ 后续任何执行都不会覆盖它 ⇒ 变成惰性垃圾）。
  for (const key of [expectedKey, `execution-logs/${exec2Id}.log.gz`]) {
    try {
      await s3.removeObject(BUCKET, key);
    } catch {
      /* 对象可能已不存在 */
    }
  }
  await ds.query(`DELETE FROM execution_log_lines WHERE "executionId" IN ($1,$2)`, [execId, exec2Id]);
  await ds.query(`DELETE FROM task_executions WHERE id IN ($1,$2)`, [execId, exec2Id]);
  await ds.query(`DELETE FROM tasks WHERE id=$1`, [taskId]);

  await ds.destroy();
  console.log(`\n=== 场景 1+2（S3 写入 / 读取）小结：PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[harness] FAILED:", err);
  process.exit(1);
});
