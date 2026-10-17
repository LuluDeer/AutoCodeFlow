#!/usr/bin/env node
/**
 * OBS-02 配套：Alertmanager → admin-api 告警 webhook 的 **HMAC 加签转发侧车**。
 *
 * 为什么需要它：admin-api 的 `POST /api/alerts/webhook`
 * （apps/admin-api/src/modules/notification/alerts.controller.ts）刻意要求
 * HMAC-SHA256 签名——`ALERT_WEBHOOK_SECRET` 未配置时端点直接 503，鉴权失败
 * 401（安全缺省，绝不退化为无鉴权接收；否则公网可路由的端点会变成告警伪造
 * 入口）。而 **Alertmanager 原生 `webhook_configs` 不支持自定义签名头**，
 * 于是 `config/monitoring/alertmanager.yml` 长期停在 `receiver: 'noop'`
 * ——30 条告警规则全部打进黑洞（PLAN-OBSERVABILITY §「Alertmanager 真实
 * 接收端」、PLAN-DEPLOYMENT-OPS §3.1 均记为 ⬜ 未完成）。
 *
 * 本脚本就是两份文档都点名要的那个「最小加签反代」（README §3.5.2 的
 * 「10 行反代（nginx njs / node 一行脚本）」）：收到 Alertmanager 的 POST
 * 原始字节 → 计算 `sha256=` + HMAC-SHA256(secret, `${ts}.${rawBody}`) →
 * 附加两个头转发到 admin-api → 把上游状态码与响应体**原样**回传。
 *
 * 零依赖：只用 node:http / node:crypto（`check-no-hoisting` / 独立安装模型
 * 不受影响；`scripts/` 下的脚本也不在 `check-env-drift` 的扫描源内）。
 *
 * ── 四个关键设计（每个都是踩过的坑，改前先读）────────────────────────────
 *
 * 1. **签名必须逐字节复用 Alertmanager 发来的原始 body**。绝不能
 *    `JSON.parse` 后重新 `JSON.stringify` 再签：一来大整数/Unicode 转义在
 *    往返中可能变形（工作流上要的是「转发的就是收到的」），二来一旦有人日后
 *    在中间加一层「规范化」，签名与 body 的对齐关系就变成隐式约定。故全程
 *    `Buffer` 直通，不解析。
 *
 * 2. **时间戳用本进程 now()，不用 Alertmanager 的时间**。接收侧窗口是
 *    ±5 分钟（`WEBHOOK_TIMESTAMP_WINDOW_MS`），签名与校验用的是同一个头值；
 *    两容器同宿主时钟通常一致，跨机部署时 NTP 漂移必须 < 5 分钟——这条写进
 *    docs/deployment.md，不要在代码里放宽窗口。
 *
 * 3. **上游状态码原样回传**。Alertmanager 把 2xx 当投递成功、非 2xx 触发
 *    重试；admin-api 在「一个通知渠道都没送到」时**刻意**返回 502
 *    （NOTIFICATION_ALERT_NOT_DELIVERED）——如果我们把它抹成 200，
 *    告警被静默吞掉且永不重试，正好抵消了那处刻意的失败语义。
 *
 * 4. **secret 缺失时拒绝启动（exit 1），不是降级成明文转发**。与 admin-api
 *    侧「未配置就 503」的安全缺省同源：宁可不工作，不可无声地不设防。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   ALERT_WEBHOOK_SECRET=<与 admin-api 同一 secret> \
 *   ALERT_PROXY_TARGET=http://admin-api:3105/api/alerts/webhook \
 *   node scripts/alertmanager-hmac-proxy.mjs
 *
 * 环境变量（默认值见 DEFAULTS）：
 *   ALERT_WEBHOOK_SECRET      必填。与 admin-api 同源的 HMAC secret。
 *   ALERT_PROXY_TARGET        默认 http://admin-api:3105/api/alerts/webhook
 *   ALERT_PROXY_PORT          默认 9099
 *   ALERT_PROXY_BIND          默认 127.0.0.1（安全缺省：本机回环）。
 *                             compose 内需设为 0.0.0.0（容器网络内可达，
 *                             且 compose **不映射**宿主端口）。
 *   ALERT_PROXY_TIMEOUT_MS    默认 10000（上游超时 → 502，让 Alertmanager
 *                             重试而不是把请求挂死）
 *   ALERT_PROXY_MAX_BODY_BYTES 默认 1048576（1 MiB；超限 413）
 *
 * 路由：
 *   POST /            加签转发（Alertmanager 的 webhook_config 指向这里）
 *   POST /alert       同上（显式路径，便于反代与日志分流）
 *   GET  /healthz     200 {"ok":true}（容器 healthcheck 用，不泄露任何配置）
 *   其余方法/路径      405 / 404
 */

import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";

// ── 与 admin-api 的共享契约（改动必须同步 webhook-hmac.util.ts）─────────────
// 这三个常量在 selftest 里与 apps/admin-api/src/common/utils/webhook-hmac.util.ts
// 做**源码级对账**——单侧改名/改算法会被立即拦下，不给「双侧静默漂移」的口子。
export const SIGNATURE_HEADER = "x-hub-signature-256";
export const TIMESTAMP_HEADER = "x-autocodeflow-timestamp";
export const SIGNATURE_PREFIX = "sha256=";

export const DEFAULTS = {
  target: "http://admin-api:3105/api/alerts/webhook",
  port: 9099,
  bind: "127.0.0.1",
  timeoutMs: 10_000,
  maxBodyBytes: 1024 * 1024,
};

/**
 * 计算签名（与 admin-api `verifyWebhookSignature` 逐字节同构）：
 *   `sha256=` + HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 * 返回 `{ timestamp, signature }`——timestamp 是**字符串**原值（接收侧不做
 * 数值归一化，故发送侧也必须是同一字符串）。
 */
export function signAlertWebhook(secret, rawBody, timestampMs) {
  const timestamp = String(timestampMs);
  const digest = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]))
    .digest("hex");
  return { timestamp, signature: `${SIGNATURE_PREFIX}${digest}` };
}

/** body 超限的专用错误（调用方映射 413）。 */
export class BodyTooLargeError extends Error {
  constructor() {
    super("body_too_large");
    this.name = "BodyTooLargeError";
  }
}

/**
 * 读满请求体；超过 maxBodyBytes 抛 `BodyTooLargeError`。
 *
 * 两条路径：
 * 1. **先看 `content-length`**：客户端（Alertmanager 用 Go net/http，body 已在
 *    内存里）几乎总会声明长度，超限时**一个字节都不读**就拒绝——内存面最干净。
 * 2. **chunked/未声明**才边读边计数。超限后 `req.pause()` 而**不** destroy：
 *    如果直接 destroy socket，413 响应还没 flush 连接就断了，客户端只会看到
 *    「连接被重置」而不是 413（实测 undici 报 `SocketError: other side closed`）
 *    ——排障时最难查的那类。改为暂停读、先把 413 发出去（HTTP/1.1 允许先回响应
 *    再继续收 body），响应 flush 完成后再收尾连接。
 */
function readBody(req, res, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      reject(new BodyTooLargeError());
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        settled = true;
        req.pause();
        // 响应 flush 后再断开，确保 413 真的能被客户端读到
        res.on("finish", () => req.destroy());
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
  });
  res.end(body);
}

/**
 * 构造加签代理服务（导出以便 selftest 在进程内驱动真实 HTTP 往返）。
 * 依赖注入 `fetchImpl` / `now` / `logger` 全部为可替换点，生产路径用默认值。
 */
export function createProxyServer({
  secret,
  targetUrl = DEFAULTS.target,
  timeoutMs = DEFAULTS.timeoutMs,
  maxBodyBytes = DEFAULTS.maxBodyBytes,
  fetchImpl = fetch,
  now = Date.now,
  logger = console,
} = {}) {
  if (!secret) {
    throw new Error("secret_required");
  }
  return createServer(async (req, res) => {
    const url = req.url ?? "/";

    if (req.method === "GET" && url.split("?")[0] === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    if (url.split("?")[0] !== "/" && url.split("?")[0] !== "/alert") {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }

    let rawBody;
    try {
      rawBody = await readBody(req, res, maxBodyBytes);
    } catch (err) {
      const tooLarge = err instanceof BodyTooLargeError;
      logger.error(
        `[alert-proxy] 读取请求体失败：${tooLarge ? "超过 " + maxBodyBytes + " 字节上限" : String(err)}`,
      );
      sendJson(res, tooLarge ? 413 : 400, {
        ok: false,
        error: tooLarge ? "body_too_large" : "body_read_failed",
      });
      return;
    }

    const { timestamp, signature } = signAlertWebhook(secret, rawBody, now());
    try {
      const upstream = await fetchImpl(targetUrl, {
        method: "POST",
        // 原始字节直通（设计点 1）；content-type 沿用入站值，默认 application/json
        headers: {
          "content-type": req.headers["content-type"] ?? "application/json",
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: signature,
        },
        body: rawBody,
        signal: AbortSignal.timeout(timeoutMs),
        // 目标是 compose 配置里的固定地址，不跟随重定向（防配置被改成跳板）
        redirect: "error",
      });
      const text = await upstream.text();
      logger.log(
        `[alert-proxy] 已加签转发 ${rawBody.length} 字节 → ${targetUrl}：上游 ${upstream.status}`,
      );
      res.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      });
      res.end(text);
    } catch (err) {
      // 上游不可达/超时 → 502：Alertmanager 会重试，绝不伪装成成功（设计点 3）
      logger.error(
        `[alert-proxy] 转发失败（${targetUrl}）：${err instanceof Error ? err.message : String(err)}`,
      );
      sendJson(res, 502, { ok: false, error: "upstream_unreachable" });
    }
  });
}

/** 从环境变量解析配置（selftest 亦可直接断言错误分支）。 */
export function resolveConfig(env = process.env) {
  const secret = (env.ALERT_WEBHOOK_SECRET ?? "").trim();
  const port = Number.parseInt(env.ALERT_PROXY_PORT ?? "", 10);
  const timeoutMs = Number.parseInt(env.ALERT_PROXY_TIMEOUT_MS ?? "", 10);
  const maxBodyBytes = Number.parseInt(env.ALERT_PROXY_MAX_BODY_BYTES ?? "", 10);
  return {
    secret,
    targetUrl: env.ALERT_PROXY_TARGET || DEFAULTS.target,
    bind: env.ALERT_PROXY_BIND || DEFAULTS.bind,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULTS.port,
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULTS.timeoutMs,
    maxBodyBytes:
      Number.isFinite(maxBodyBytes) && maxBodyBytes > 0
        ? maxBodyBytes
        : DEFAULTS.maxBodyBytes,
  };
}

function main() {
  const cfg = resolveConfig();
  if (!cfg.secret) {
    // 设计点 4：拒绝启动而非降级
    console.error(
      "[alert-proxy] 缺少 ALERT_WEBHOOK_SECRET —— 无法加签，拒绝启动（与 admin-api 未配置即 503 的安全缺省同源）。",
    );
    process.exit(1);
  }
  const server = createProxyServer({
    secret: cfg.secret,
    targetUrl: cfg.targetUrl,
    timeoutMs: cfg.timeoutMs,
    maxBodyBytes: cfg.maxBodyBytes,
  });
  server.listen(cfg.port, cfg.bind, () => {
    console.log(
      `[alert-proxy] listening on http://${cfg.bind}:${cfg.port} → ${cfg.targetUrl}（绑定 ${cfg.bind}；compose 内不映射宿主端口）`,
    );
  });
  server.on("error", (err) => {
    console.error(`[alert-proxy] 监听失败：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

// 仅在被直接执行时启动（selftest 以模块方式 import 时不触发监听）。
// 用 pathToFileURL 而非手拼 `file://${argv[1]}`——Windows 盘符路径下
// 手拼会得到 file://E:/... （两斜杠）与 import.meta.url 的 file:///E:/...
// （三斜杠）不相等，导致 `node scripts/alertmanager-hmac-proxy.mjs` 静默不启动。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
