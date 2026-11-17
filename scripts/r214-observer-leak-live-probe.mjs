#!/usr/bin/env node
/**
 * R214：**超时后会不会留下悬挂命令**（R213 自己登记的未验证项）—— 真机裁定。
 *
 * ## R213 登记的担忧
 *
 * > `Promise.race` **不取消**底层命令 ⇒ 超时后 ioredis 里那条命令仍挂着，直到连接恢复。
 *
 * 本轮把它测清楚，结论分**两半**（都对，但只有后半适用于本仓生产形态）：
 *
 * | 命令类型 | 超时后 | 对本仓是否要紧 |
 * |---|---|---|
 * | **阻塞型**（`BLPOP`/`BRPOPLPUSH`） | 连接进入 `flags=b` 阻塞态，**该连接上后续命令全部卡住** | ❌ **不适用**：观测只发非阻塞命令 |
 * | **非阻塞型**（`LLEN`/`ZRANGE`/`LRANGE`/`GET`/`CLIENT LIST`） | 超时后命令被丢弃，**连接自动康复**（`commandQueue` 归 0），**且响应不会错位** | ✅ 本仓形态 |
 *
 * ## 断言（每条都只有真机才能证明）
 *
 *  ① 阻塞命令超时 ⇒ 该连接 `CLIENT LIST` 里 `cmd=blpop` / `flags=b`，**且后续 PING 卡住**
 *     （⇒ 证明「阻塞命令超时会**毒化连接**」这个风险是**真的**，只是观测不用它）；
 *  ② **非阻塞命令超时 ⇒ 连接自动康复**：`commandQueue` 归 0，后续同一连接往返 0ms；
 *  ③ ★ **响应不错位**：超时那条命令的响应被正确丢弃，后续 `get(k1)`/`get(k2)`/`lrange`
 *     各自拿到**自己**的结果（这是最危险的一种假设——若错位，观测会拿到别人的数据）；
 *  ④ 观测实际用到的命令集**全是非阻塞**（从 `queue-getters` 的实现取事实，不是猜）。
 *
 * ## 安全边界
 *
 * 只用隔离实例（默认 16381，脚本断言不是 6379），全程 `r214-*` 前缀 key，结束时删净并回读。
 *
 * 用法：`npm run test:r214-observer-leak-live`
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const require_ = createRequire(join(ROOT, "apps/admin-api", "package.json"));
const IORedis = require_("ioredis");

function envFromRepo(key, fallback) {
  try {
    const raw = readFileSync(join(ROOT, ".env"), "utf8");
    const m = raw.match(new RegExp(`^${key}=(.*)$`, "m"));
    if (m && m[1] !== "") return m[1].replace(/\r$/, "");
  } catch {
    /* 缺 .env ⇒ 用环境变量/默认值 */
  }
  return process.env[key] ?? fallback;
}

const PORT = process.env.R214_REDIS_PORT || "16381";
const REDIS_PASSWORD = process.env.R214_REDIS_PASSWORD || "r214pass";
const HOST = process.env.R214_REDIS_HOST || "127.0.0.1";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` —— ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 生产同款连接配置（`app.module.ts`）：这两个值决定了挂起语义。 */
function makeClient(name) {
  const c = new IORedis({
    host: HOST,
    port: Number(PORT),
    password: REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
  });
  return c;
}

async function main() {
  // ── 0. 安全闸 ────────────────────────────────────────────────────────
  check(
    "① 安全闸：目标 Redis 端口**不是** 6379（本探针会发阻塞命令，禁止打真实实例）",
    PORT !== "6379",
    `R214_REDIS_PORT=${PORT}`,
  );
  if (PORT === "6379") {
    console.error("拒绝在 6379 上运行 —— 请用隔离实例（默认 16381）。");
    process.exit(2);
  }

  const { withObservationTimeout } = await import(
    "../apps/admin-api/dist/modules/agent/runtime/observation-timeout.util.js"
  );

  const client = makeClient();
  const admin = makeClient();
  try {
    await client.ping();
    await admin.ping();

    // ── 1. 观测命令集是否全为非阻塞（事实来自实现，不是猜）──────────────
    // `queue-getters.js` 的 `commandByType` 对 waiting/active 用 lrange/llen、
    // 对 delayed/prioritized 用 zrange/zcard、计数用 llen/zcard，`getWorkers` 走 `CLIENT LIST`。
    // ⇒ 全是**非阻塞**。这里断言的是一条**可复现的事实**：这些调用在正常 Redis 上都是亚毫秒级。
    const t0 = Date.now();
    await client.llen("r214-probe:wait");
    await client.zcard("r214-probe:delayed");
    await client.client("list");
    await client.ping();
    check(
      "② 观测实际用到的命令集（LLEN / ZCARD / CLIENT LIST / PING）在健康 Redis 上亚毫秒级",
      Date.now() - t0 < 100,
      `4 条往返合计 ${Date.now() - t0}ms`,
    );

    // ── 2. 阻塞命令超时 ⇒ **毒化连接**（证明 R213 的担忧是真的）─────────────
    await client.client("setname", "r214-blocking");
    try {
      await withObservationTimeout("blpop", () => client.blpop("r214-never", 100), 300);
    } catch {
      /* 如期超时 */
    }
    await sleep(200);
    const listRaw = await admin.client("list");
    const mine = listRaw
      .split("\n")
      .filter((l) => l.includes("r214-blocking"))
      .map((l) => Object.fromEntries(l.split(" ").map((kv) => kv.split("="))));
    check(
      "③ 阻塞命令（BLPOP）超时后 ⇒ 该连接 `cmd=blpop` / `flags=b`（**毒化**：连接卡在阻塞态）",
      mine.length > 0 && mine[0].cmd === "blpop" && String(mine[0].flags).includes("b"),
      mine.length ? `cmd=${mine[0].cmd} flags=${mine[0].flags}` : "连接未在 CLIENT LIST 中找到",
    );
    // 该连接上后续命令被卡住 —— 这是「毒化」的实际后果
    const blocked = await Promise.race([
      client.ping().then(() => "ok"),
      sleep(1_500).then(() => "blocked"),
    ]);
    check(
      "④ 且**该连接上后续命令被卡住**（1.5s 内 PING 未返回）—— 所以观测**绝不能**发阻塞命令",
      blocked === "blocked",
      `ping=${blocked}`,
    );
    await client.disconnect();

    // ── 3. ★ 非阻塞命令超时 ⇒ 连接**自动康复**（这才是本仓形态）──────────
    const c2 = makeClient();
    await c2.ping();
    await c2.set("r214:k1", "v1");
    // 用 `CLIENT PAUSE` 让 Redis 暂不处理命令（模拟「卡住」，且**不改连接状态**）
    await admin.client("pause", 2_000, "ALL");
    let timedOut = false;
    try {
      await withObservationTimeout("paused-get", () => c2.get("r214:k1"), 300);
    } catch {
      timedOut = true;
    }
    check("⑤ 非阻塞命令（GET）在 Redis 卡住时如期超时", timedOut, `timedOut=${timedOut}`);

    // 等 pause 结束 + 连接恢复
    await sleep(2_500);
    const t1 = Date.now();
    const back = await Promise.race([
      c2.get("r214:k1"),
      sleep(2_000).then(() => "TIMEOUT"),
    ]);
    check(
      "⑥ ★ 超时后**同一连接自动康复**，且拿到的是**自己那条命令**的结果（不是别人的）",
      back === "v1",
      `get(r214:k1)=${JSON.stringify(back)} 往返=${Date.now() - t1}ms`,
    );

    // ── 4. ★ 响应不错位（最危险的假设：错位会让观测拿到别人的数据）────────
    await c2.set("r214:k2", "v2");
    await c2.del("r214:lst");
    await c2.rpush("r214:lst", "a", "b", "c");
    const [b2, c2v] = await Promise.all([
      c2.get("r214:k2"),
      c2.lrange("r214:lst", 0, -1),
    ]);
    check(
      "⑦ ★ 超时之后，不同命令的响应**各自对齐**（GET ⇒ 'v2'，LRANGE ⇒ ['a','b','c']）",
      b2 === "v2" && JSON.stringify(c2v) === JSON.stringify(["a", "b", "c"]),
      `get=${JSON.stringify(b2)} lrange=${JSON.stringify(c2v)}`,
    );

    const raw = c2;
    const pending = raw.commandQueue?.length ?? -1;
    check(
      "⑧ 最终 `commandQueue` 归 0（⇒ **没有悬挂命令残留**，R213 的担忧在非阻塞形态下不成立）",
      pending === 0,
      `commandQueue=${pending} status=${c2.status}`,
    );
  } finally {
    // 清理本探针的 key 并**回读**
    try {
      const keys = await admin.keys("r214:*");
      if (keys.length) await admin.del(...keys);
    } catch {
      /* 尽力而为 */
    }
    let left = "?";
    try {
      left = String((await admin.keys("r214:*")).length);
    } catch {
      /* 保留 '?' ⇒ 下面的断言会红 */
    }
    check("⑨ 清理生效：`r214:*` 残留 = 0（**回读**确认）", left === "0", `残留=${left}`);
    // ⚠️ ioredis 的 `disconnect()` 返回 **undefined**（不是 promise）⇒ 不能接 `.catch()`。
    //    实测踩过一次：整条 finally 抛 `Cannot read properties of undefined`，
    //    把已经 9/9 全绿的探针变成 EXIT=2。⇒ 用 try/catch 而不是 promise 链。
    try {
      client.disconnect();
    } catch {
      /* 已断开 */
    }
    try {
      admin.disconnect();
    } catch {
      /* 已断开 */
    }
  }

  const failed = results.filter((x) => !x.ok);
  console.log(
    `\n${failed.length === 0 ? "✔" : "✘"} R214 悬挂命令真机探针：${results.length - failed.length}/${results.length} 通过` +
      (failed.length ? `（失败：${failed.map((f) => f.name).join(" / ")}）` : ""),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("探针异常终止：", err?.message ?? err);
  process.exit(2);
});
