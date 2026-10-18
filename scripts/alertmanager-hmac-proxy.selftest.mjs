#!/usr/bin/env node
/**
 * `scripts/alertmanager-hmac-proxy.mjs` 的离线自检（零依赖、无网络出口）。
 *
 * 为什么值得单列一套自检：这条链路的两端**不在同一个语言/进程里**——
 * 签名侧是本脚本，校验侧是 admin-api 的 `verifyWebhookSignature`。一旦任何
 * 一侧的算法（分隔符、前缀、拼接顺序、header 名）悄悄漂移，症状是生产上
 * 「Alertmanager 发出去了、admin-api 静默 401、告警再也到不了值班渠道」，
 * 而**两侧的单测各自都是绿的**（各自都以自己为基准）。故这里做四层钉子：
 *
 *   ① **金向量**：三组固定 (secret, timestamp, body) → 期望签名字面量。
 *      接收侧用 **WebCrypto `crypto.subtle`** 独立实现校验（与签名侧的
 *      `node:crypto` createHmac 是 Node 里两条不同的实现路径）——金向量由
 *      两个独立实现共同钉住，不是自己验自己。
 *   ② **契约对账**：直接读 admin-api 的
 *      `src/common/utils/webhook-hmac.util.ts` 源码文本，断言 header 名、
 *      `sha256=` 前缀、`${timestamp}.` 拼接与 ±5 分钟窗口这些**字面量**仍在，
 *      且与本脚本导出的常量逐个相等。单侧改名/改算法 → 立即红。
 *   ③ **真实 HTTP 端到端**：起真代理 + 真桩接收端，走真实 TCP。覆盖
 *      成功透传、上游 4xx/5xx 原样回传（Alertmanager 的重试语义不能被抹平）、
 *      上游不可达 → 502、超限 → 413、方法/路径守卫、healthz、以及
 *      **「secret 不出现在出站请求里」**。
 *   ④ **fail-closed**：真的以子进程执行本脚本且不给 secret，断言退出码 = 1
 *      （不是降级成明文转发）。
 *
 * 用法：node scripts/alertmanager-hmac-proxy.selftest.mjs
 * 退出码：0 = 全绿；1 = 任一断言失败。
 */

import { createHmac, webcrypto } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import {
  DEFAULTS,
  SIGNATURE_HEADER,
  SIGNATURE_PREFIX,
  TIMESTAMP_HEADER,
  createProxyServer,
  resolveConfig,
  signAlertWebhook,
} from "./alertmanager-hmac-proxy.mjs";

const ROOT = join(import.meta.dirname, "..");
const HMAC_UTIL = "apps/admin-api/src/common/utils/webhook-hmac.util.ts";
const PROXY_FILE = "scripts/alertmanager-hmac-proxy.mjs";

const failures = [];
const report = (ok, name, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? `\n   ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

// ── ① 金向量（接收侧用 WebCrypto 独立校验）──────────────────────────────────
const GOLDEN_VECTORS = [
  {
    secret: "alert-webhook-secret",
    timestamp: "1750000000000",
    body: '{"version":"4","status":"firing","alerts":[{"status":"firing","labels":{"alertname":"Demo"}}]}',
    signature:
      "sha256=b409e77207b58e207bf7f2fb37f58e75a335285e549d761a5341346771e07d9e",
  },
  {
    secret: "alert-webhook-secret",
    timestamp: "1750000000000",
    body: "",
    signature:
      "sha256=fb4c25fa1300363c0a8961171ee16c7d146593077fca90cbb4f2c3e5ee8831eb",
  },
  {
    // 多字节 secret + 多字节/emoji body：钉住 utf8 编码与字节长度口径
    secret: "测试密钥-多字节",
    timestamp: "1750000000123",
    body: '{"a":"告警","b":"emoji 🚨"}',
    signature:
      "sha256=bd93273b0fe26f3e04e020b5f748bdf4b6fedef19ff060eaad1ccfc6a27f6cf2",
  },
];

/** 独立实现：WebCrypto HMAC-SHA256（与 node:crypto createHmac 不同的代码路径）。 */
async function verifyWithWebCrypto(secret, timestamp, rawBody, signature) {
  const key = await webcrypto.subtle.importKey(
    "raw",
    Buffer.from(secret, "utf8"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await webcrypto.subtle.sign(
    "HMAC",
    key,
    Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]),
  );
  const expected = SIGNATURE_PREFIX + Buffer.from(mac).toString("hex");
  return expected === signature;
}

async function checkGoldenVectors() {
  for (const [i, vec] of GOLDEN_VECTORS.entries()) {
    const got = signAlertWebhook(
      vec.secret,
      Buffer.from(vec.body, "utf8"),
      Number(vec.timestamp),
    );
    const label = `金向量 #${i + 1}（${vec.body === "" ? "空 body" : vec.body.slice(0, 24) + "…"}）`;
    const signOk =
      got.timestamp === vec.timestamp && got.signature === vec.signature;
    // WebCrypto 独立复核：同一向量必须被另一条实现路径判定为「合法签名」
    const independentOk = await verifyWithWebCrypto(
      vec.secret,
      vec.timestamp,
      Buffer.from(vec.body, "utf8"),
      got.signature,
    );
    report(
      signOk && independentOk,
      `${label} 签名与契约逐字一致，且被 WebCrypto 独立复核通过`,
      signOk
        ? independentOk
          ? ""
          : "WebCrypto 复核未通过——两条实现路径对同一字节序列不一致"
        : `期望 ${vec.signature}\n   实际 ${got.signature}（timestamp=${got.timestamp}）`,
    );
  }

  // 反证：把 body 改一个字节，签名必须变（防「签名与 body 解耦」的错误实现）
  const a = signAlertWebhook("s", Buffer.from("A"), 1).signature;
  const b = signAlertWebhook("s", Buffer.from("B"), 1).signature;
  report(a !== b, "反证：body 变一个字节 → 签名必变（签名确实绑定 body）");

  // 反证：时间戳参与签名（接收侧窗口防重放依赖它）
  const t1 = signAlertWebhook("s", Buffer.from("A"), 1).signature;
  const t2 = signAlertWebhook("s", Buffer.from("A"), 2).signature;
  report(t1 !== t2, "反证：timestamp 变 → 签名必变（时间戳确实参与 HMAC）");
}

// ── ② 与 admin-api 校验侧的源码级契约对账 ────────────────────────────────────
function checkContractAlignment() {
  let source;
  try {
    source = readFileSync(join(ROOT, HMAC_UTIL), "utf8");
  } catch {
    report(false, `契约对账：可读 ${HMAC_UTIL}`, "文件不可读（被移动/改名了吗？）");
    return;
  }

  const expectations = [
    [
      `"${SIGNATURE_HEADER}"`,
      `签名头名与 admin-api 一致（${SIGNATURE_HEADER}）`,
    ],
    [
      `"${TIMESTAMP_HEADER}"`,
      `时间头名与 admin-api 一致（${TIMESTAMP_HEADER}）`,
    ],
    [
      `"${SIGNATURE_PREFIX}"`,
      `签名前缀与 admin-api 一致（${SIGNATURE_PREFIX}）`,
    ],
    [
      "${input.timestamp}.",
      "拼接串 `${timestamp}.${rawBody}` 与 admin-api 一致（分隔符是点号）",
    ],
    [
      "5 * 60 * 1000",
      "接收侧 ±5 分钟时间窗仍在（本进程 now() 与接收侧同源契约）",
    ],
    ['createHmac("sha256"', "admin-api 仍用 HMAC-SHA256（算法未换）"],
  ];
  for (const [literal, name] of expectations) {
    report(
      source.includes(literal),
      `契约对账：${name}`,
      source.includes(literal) ? "" : `在 ${HMAC_UTIL} 中找不到字面量 ${JSON.stringify(literal)}`,
    );
  }

  // 本脚本不得自行硬编码一套「另一份」契约常量——必须与 util 逐字相等
  report(
    source.includes(`"${SIGNATURE_HEADER}"`) &&
      source.includes(`"${TIMESTAMP_HEADER}"`) &&
      source.includes(`"${SIGNATURE_PREFIX}"`),
    "契约对账：本脚本导出的三个常量与 util 源码字面量双向相等",
  );
}

// ── ③ 配置解析与 fail-closed ────────────────────────────────────────────────
function checkResolveConfig() {
  const empty = resolveConfig({});
  report(empty.secret === "", "resolveConfig：无 secret → secret 为空（交由 main 拒绝启动）");
  report(
    empty.targetUrl === DEFAULTS.target &&
      empty.port === DEFAULTS.port &&
      empty.bind === DEFAULTS.bind &&
      empty.timeoutMs === DEFAULTS.timeoutMs &&
      empty.maxBodyBytes === DEFAULTS.maxBodyBytes,
    "resolveConfig：未设置时全部回落安全缺省",
    `实际 bind=${empty.bind} port=${empty.port}`,
  );

  const custom = resolveConfig({
    ALERT_WEBHOOK_SECRET: "  padded-secret  ",
    ALERT_PROXY_TARGET: "http://example.internal:1/hook",
    ALERT_PROXY_PORT: "12345",
    ALERT_PROXY_BIND: "0.0.0.0",
    ALERT_PROXY_TIMEOUT_MS: "1500",
    ALERT_PROXY_MAX_BODY_BYTES: "2048",
  });
  report(
    custom.secret === "padded-secret" &&
      custom.port === 12345 &&
      custom.bind === "0.0.0.0" &&
      custom.timeoutMs === 1500 &&
      custom.maxBodyBytes === 2048 &&
      custom.targetUrl === "http://example.internal:1/hook",
    "resolveConfig：显式值生效，secret 两侧空白被裁掉（避免复制粘贴带空格导致签名不一致）",
    JSON.stringify({ ...custom, secret: "***" }),
  );

  // 非法数值回落缺省，而不是 NaN 进 listen/fetch
  const junk = resolveConfig({
    ALERT_WEBHOOK_SECRET: "x",
    ALERT_PROXY_PORT: "not-a-port",
    ALERT_PROXY_TIMEOUT_MS: "-5",
  });
  report(
    junk.port === DEFAULTS.port && junk.timeoutMs === DEFAULTS.timeoutMs,
    "resolveConfig：非法/负数端口与超时回落缺省（不会把 NaN 传给 listen/fetch）",
    `port=${junk.port} timeoutMs=${junk.timeoutMs}`,
  );

  // 构造器拒绝空 secret
  let threw = false;
  try {
    createProxyServer({ secret: "" });
  } catch (err) {
    threw = err instanceof Error && err.message === "secret_required";
  }
  report(threw, "createProxyServer：空 secret 直接抛 secret_required（不构造无鉴权服务）");
}

function checkFailClosedChildProcess() {
  // 真的执行脚本本体、且不给 secret：必须以 1 退出（fail-closed）。
  // 若这里拿到 0 或一直挂着，说明「未配置就拒绝启动」的保护被删了。
  const result = spawnSync(process.execPath, [join(ROOT, PROXY_FILE)], {
    env: { ...process.env, ALERT_WEBHOOK_SECRET: "" },
    encoding: "utf8",
    timeout: 20_000,
  });
  report(
    result.status === 1,
    "fail-closed：以子进程真实执行脚本、不给 ALERT_WEBHOOK_SECRET → 退出码 1",
    `status=${result.status} signal=${result.signal}\n   stderr=${(result.stderr ?? "").trim().split("\n").slice(-1)[0] ?? ""}`,
  );
}

// ── ④ 真实 HTTP 端到端 ──────────────────────────────────────────────────────
function readAll(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 桩「admin-api」：以 WebCrypto 独立校验签名，记录收到的原始字节与头。 */
async function startStub({ secret, respond }) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const rawBody = await readAll(req);
    const timestamp = req.headers[TIMESTAMP_HEADER];
    const signature = req.headers[SIGNATURE_HEADER];
    const valid =
      typeof timestamp === "string" &&
      typeof signature === "string" &&
      (await verifyWithWebCrypto(secret, timestamp, rawBody, signature));
    const record = {
      rawBody,
      headers: { ...req.headers },
      timestamp,
      signature,
      valid,
    };
    seen.push(record);
    await respond(req, res, record);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/api/alerts/webhook`,
    seen,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}

async function startProxy(opts) {
  const server = createProxyServer({ logger: silentLogger, ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}

const silentLogger = { log: () => {}, error: () => {}, warn: () => {} };

async function checkEndToEnd() {
  const SECRET = "e2e-alert-secret";
  const PAYLOAD = Buffer.from(
    '{"version":"4","status":"firing","groupKey":"{}:{alertname=\\"HighCPU\\"}","alerts":[{"status":"firing","labels":{"alertname":"HighCPU"},"annotations":{"summary":"CPU 高"}}]}',
    "utf8",
  );
  const ALLOWED_OUTBOUND_HEADERS = new Set([
    "host",
    "connection",
    "content-length",
    "content-type",
    SIGNATURE_HEADER,
    TIMESTAMP_HEADER,
  ]);
  // undici（全局 fetch）会自带 accept / user-agent / accept-encoding 等
  // 环境头——它们由运行时注入、与本脚本无关，不是「未预期头」。真正要防的是
  // **凭据外泄**：出站请求里不得出现 secret（无论头名还是头值），也不得出现
  // 任何携带凭证语义的头（authorization/cookie/token 之类）。
  const CREDENTIALISH = /secret|authorization|cookie|token|passw/i;

  const stub = await startStub({
    secret: SECRET,
    respond: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, delivered: 1 }));
    },
  });
  const proxy = await startProxy({ secret: SECRET, targetUrl: stub.url });
  try {
    const res = await fetch(`${proxy.url}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: PAYLOAD,
    });
    const text = await res.text();
    const record = stub.seen[0];

    report(res.status === 200, "e2e：转发成功时上游 200 原样回传", `status=${res.status}`);
    report(
      text === JSON.stringify({ ok: true, delivered: 1 }),
      "e2e：上游响应体原样回传（排障信息不被吞）",
      text,
    );
    report(
      record?.valid === true,
      "e2e：桩接收端用 WebCrypto 独立校验『代理产出的签名』→ 合法",
      record ? `signature=${record.signature}` : "桩未收到请求",
    );
    report(
      record?.rawBody?.equals(PAYLOAD) === true,
      "e2e：body 逐字节直通（未做 JSON 往返重序列化）",
    );
    report(
      (record?.headers?.["content-type"] ?? "") === "application/json",
      "e2e：content-type 沿用入站值",
      `实际 ${record?.headers?.["content-type"]}`,
    );

    // 时间戳必须是本进程 freshly signed 的（不是透传/硬编码）
    const skew = Math.abs(Date.now() - Number(record?.timestamp));
    report(
      Number.isFinite(skew) && skew < 1000,
      "e2e：签名时间戳是「本进程当下」（±1s 内，非透传或硬编码）",
      `skew=${skew}ms`,
    );

    // secret 不得出现在出站请求的任何头里（含头名与头值）
    const headerKeys = Object.keys(record?.headers ?? {});
    const credentialish = headerKeys.filter(
      (k) => CREDENTIALISH.test(k) && k !== SIGNATURE_HEADER && k !== TIMESTAMP_HEADER,
    );
    const serialized = JSON.stringify(record?.headers ?? {});
    report(
      credentialish.length === 0 && !serialized.includes(SECRET),
      "e2e：出站请求不带任何凭证语义的头，且 secret 不出现在头（名或值）中",
      credentialish.length
        ? `多出凭证类头：${credentialish.join(",")}`
        : serialized.includes(SECRET)
          ? "secret 出现在头值里！"
          : "",
    );
    report(
      typeof record?.headers?.[SIGNATURE_HEADER] === "string" &&
        typeof record?.headers?.[TIMESTAMP_HEADER] === "string",
      "e2e：两个约定头（签名 + 时间戳）确实随请求发出",
    );
    report(
      headerKeys.every((k) => ALLOWED_OUTBOUND_HEADERS.has(k) || !/^(x-|authorization)/i.test(k)),
      "e2e：出站请求未自行添加任何额外的 x-* 自定义头",
      headerKeys.filter((k) => !ALLOWED_OUTBOUND_HEADERS.has(k)).join(",") || "(无)",
    );
  } finally {
    await proxy.close();
    await stub.close();
  }

  // ── 上游 4xx / 5xx 原样回传：Alertmanager 的重试语义不能被抹平 ──
  for (const upstreamStatus of [401, 502]) {
    const badStub = await startStub({
      secret: SECRET,
      respond: (_req, res) => {
        res.writeHead(upstreamStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, status: upstreamStatus }));
      },
    });
    const badProxy = await startProxy({ secret: SECRET, targetUrl: badStub.url });
    try {
      const res = await fetch(`${badProxy.url}/`, {
        method: "POST",
        body: PAYLOAD,
      });
      const text = await res.text();
      report(
        res.status === upstreamStatus &&
          text === JSON.stringify({ ok: false, status: upstreamStatus }),
        `e2e：上游 ${upstreamStatus} 原样回传给 Alertmanager（不伪装成 200，否则告警被静默吞掉且永不重试）`,
        `实际 status=${res.status} body=${text}`,
      );
    } finally {
      await badProxy.close();
      await badStub.close();
    }
  }

  // ── 上游不可达 → 502 ──
  const unreachableProxy = await startProxy({
    secret: SECRET,
    targetUrl: "http://127.0.0.1:1/api/alerts/webhook",
  });
  try {
    const res = await fetch(`${unreachableProxy.url}/`, { method: "POST", body: PAYLOAD });
    const body = await res.json().catch(() => ({}));
    report(
      res.status === 502 && body.error === "upstream_unreachable",
      "e2e：上游不可达 → 502 upstream_unreachable（触发 Alertmanager 重试而不是挂死）",
      `status=${res.status} body=${JSON.stringify(body)}`,
    );
  } finally {
    await unreachableProxy.close();
  }

  // ── 上游超时 → 502 ──
  const slowStub = await startStub({
    secret: SECRET,
    respond: (_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end("late");
      }, 5_000).unref?.();
    },
  });
  const timeoutProxy = await startProxy({
    secret: SECRET,
    targetUrl: slowStub.url,
    timeoutMs: 200,
  });
  try {
    const res = await fetch(`${timeoutProxy.url}/`, { method: "POST", body: PAYLOAD });
    report(
      res.status === 502,
      "e2e：上游超时 → 502（超时可配，默认 10s）",
      `status=${res.status}`,
    );
  } finally {
    await timeoutProxy.close();
    await slowStub.close();
  }

  // ── 路由/方法守卫 + healthz ──
  const guardStub = await startStub({
    secret: SECRET,
    respond: (_req, res) => {
      res.writeHead(200);
      res.end("{}");
    },
  });
  const guardProxy = await startProxy({ secret: SECRET, targetUrl: guardStub.url });
  try {
    const health = await fetch(`${guardProxy.url}/healthz`);
    const healthBody = await health.json().catch(() => ({}));
    report(
      health.status === 200 && healthBody.ok === true,
      "e2e：GET /healthz → 200 {ok:true}（供容器 healthcheck）",
      `status=${health.status}`,
    );

    const put = await fetch(`${guardProxy.url}/`, { method: "PUT", body: "x" });
    report(put.status === 405, "e2e：非 POST → 405（加签面只接受 POST）", `status=${put.status}`);

    const notFound = await fetch(`${guardProxy.url}/admin`, { method: "POST", body: "x" });
    report(
      notFound.status === 404,
      "e2e：未知路径 → 404（不给「加签任意路径」的开放面）",
      `status=${notFound.status}`,
    );

    const alias = await fetch(`${guardProxy.url}/alert`, { method: "POST", body: PAYLOAD });
    report(alias.status === 200, "e2e：POST /alert 别名路径可用", `status=${alias.status}`);

    // healthz 不泄露配置：响应体里不得出现 target/secret
    report(
      !JSON.stringify(healthBody).includes(SECRET) &&
        !JSON.stringify(healthBody).includes(guardStub.url),
      "e2e：healthz 响应不泄露 secret/target 等配置",
      JSON.stringify(healthBody),
    );
  } finally {
    await guardProxy.close();
    await guardStub.close();
  }

  // ── body 超限 → 413 ──
  const sizeStub = await startStub({
    secret: SECRET,
    respond: (_req, res) => {
      res.writeHead(200);
      res.end("{}");
    },
  });
  const sizeProxy = await startProxy({
    secret: SECRET,
    targetUrl: sizeStub.url,
    maxBodyBytes: 64,
  });
  try {
    const res = await fetch(`${sizeProxy.url}/`, {
      method: "POST",
      body: Buffer.alloc(256, 0x61),
    });
    const body = await res.json().catch(() => ({}));
    report(
      res.status === 413 && body.error === "body_too_large",
      "e2e：body 超过上限 → 413（内存不随入站体积无界增长）",
      `status=${res.status} body=${JSON.stringify(body)}`,
    );
    report(
      sizeStub.seen.length === 0,
      "e2e：超限请求**不**转发到上游（413 在上游之前拦掉）",
      `上游收到 ${sizeStub.seen.length} 次`,
    );
  } finally {
    await sizeProxy.close();
    await sizeStub.close();
  }

  // ── 空 body 也应正确加签并转发（Alertmanager 极端情况下的空 POST）──
  const emptyStub = await startStub({
    secret: SECRET,
    respond: (_req, res) => {
      res.writeHead(200);
      res.end("{}");
    },
  });
  const emptyProxy = await startProxy({ secret: SECRET, targetUrl: emptyStub.url });
  try {
    const res = await fetch(`${emptyProxy.url}/`, { method: "POST", body: "" });
    report(
      res.status === 200 && emptyStub.seen[0]?.valid === true,
      "e2e：空 body 也能产出被独立校验通过的签名（对齐金向量 #2）",
      `status=${res.status} valid=${emptyStub.seen[0]?.valid}`,
    );
  } finally {
    await emptyProxy.close();
    await emptyStub.close();
  }
}

// ── main ────────────────────────────────────────────────────────────────────
console.log("=== alertmanager-hmac-proxy selftest ===\n");
await checkGoldenVectors();
checkContractAlignment();
checkResolveConfig();
checkFailClosedChildProcess();
await checkEndToEnd();

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项失败：`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("\n✓ alertmanager-hmac-proxy selftest 全绿");
