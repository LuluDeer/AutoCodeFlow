#!/usr/bin/env node
/**
 * 补齐 API-I18N 映射表里缺的英文（一次性工具，补完即可删）。
 *
 * 这 20 条由 `inject-openapi-en.mjs --check` 实测报缺。来源：
 *   · 我修 codemod 产物时**新写的** description（原内联载体没覆盖到）；
 *   · `@ApiOkResponse` 等 response 的 description——它们与 schema 属性**共用
 *     同一个 `x-i18n-en` 槽**，早前抽取时未纳入，故映射表里没有。
 *
 * 以脚本补而不是手改 JSON，是为了让"补了哪 20 条"可复核、可复跑。
 */
import * as fs from "node:fs";
import * as path from "node:path";

const MAP = "scripts/api-i18n/data/openapi-en-map.json";

const ADD = {
  "使用用户名和密码登录，返回 Access Token 与 Refresh Token。每分钟最多 20 次尝试。":
    "Log in with a username and password; returns an Access Token and a Refresh Token. At most 20 attempts per minute.",

  "手动触发任务执行。自定义 params 可覆盖任务默认值。NF-01: 双凭据面——用户 JWT 或携带 task:trigger 扩展域的 API Key （Authorization: Bearer acf_...，guard 分流见 jwt-auth.guard/api-key-auth.helper）；响应契约与 JWT 面完全一致。":
    "Manually trigger a task execution. Custom params override the task defaults. NF-01: dual-credential face -- a user JWT or an API key carrying the task:trigger extension scope (Authorization: Bearer acf_..., guard routing in jwt-auth.guard/api-key-auth.helper); the response contract is identical to the JWT face.",

  "批量触发结果\n\n与 /tasks/batch/* 同形态：逐任务结果数组（成功=execution 行 | 失败={id,error}）":
    "Batch trigger results\n\nSame shape as /tasks/batch/*: a per-task result array (success = execution row | failure = {id,error})",
  "批量暂停结果\n\n同 /tasks/batch/pause":
    "Bulk pause results\n\nSame as /tasks/batch/pause",
  "批量恢复结果\n\n同 /tasks/batch/resume":
    "Bulk resume results\n\nSame as /tasks/batch/resume",
  "批量删除结果\n\n同 /tasks/batch/delete":
    "Bulk delete results\n\nSame as /tasks/batch/delete",

  "公开的机器调用端点。需要 X-AutoCodeFlow-Timestamp 与 X-Hub-Signature-256 请求头；签名是用该任务的 Webhook 密钥对 `${timestamp}.${rawBody}` 计算的 HMAC-SHA256（可通过 POST /api/tasks/:id/webhook/enable 启用）。请求体 `{ params }` 会覆盖该任务本次执行的默认参数。可加 `?wait=1&timeout=N` 让请求停驻到执行进入终态（N ≤ 300 秒；超时则返回 `completed:false` 及最新快照）。任务不存在 / Webhook 未启用 / 签名错误一律返回相同的 401。":
    "Public machine-call endpoint. Requires the X-AutoCodeFlow-Timestamp and X-Hub-Signature-256 headers; the signature is an HMAC-SHA256 over `${timestamp}.${rawBody}` using the task's webhook secret (enable it via POST /api/tasks/:id/webhook/enable). The `{ params }` body overrides the task's default parameters for this execution. Add `?wait=1&timeout=N` to hold the request until the execution reaches a terminal state (N <= 300 s; on timeout it returns `completed:false` plus the latest snapshot). A missing task / disabled webhook / bad signature all return the same 401.",

  "wait 模式超时秒数（1-300，缺省 60）":
    "wait-mode timeout in seconds (1-300, default 60)",

  "带显式截断标记的执行器选择器选项\n\ntruncated=true 时 items 是前缀、total 是真实总数":
    "Executor selector options with an explicit truncation marker\n\nWhen truncated=true, items is a prefix and total is the true total",

  "tar.gz 产物（application/gzip）\n\ntar.gz 二进制内容（Res 直传）":
    "tar.gz artifact (application/gzip)\n\ntar.gz binary content (passed through via Res)",

  "执行器已删除\n\n已移除（无内容）":
    "Executor deleted\n\nRemoved (no content)",

  "入站 Alertmanager v2 告警回调。HMAC-SHA256 over `${timestamp}.${rawBody}`，需携带 X-AutoCodeFlow-Timestamp 与 X-Hub-Signature-256 头（secret = ALERT_WEBHOOK_SECRET，未配置时 503）。alerts[] 为空数组返回 400。":
    "Inbound Alertmanager v2 alert callback. HMAC-SHA256 over `${timestamp}.${rawBody}`; requires the X-AutoCodeFlow-Timestamp and X-Hub-Signature-256 headers (secret = ALERT_WEBHOOK_SECRET; 503 when not configured). An empty alerts[] array returns 400.",

  "包二进制内容（Res 直传）\n\n包二进制内容（Res 直传）":
    "Package binary content (passed through via Res)\n\nPackage binary content (passed through via Res)",
  "结果入账回执 {ok:true}\n\n结果入账回执 {ok:true}":
    "Result acknowledgement {ok:true}\n\nResult acknowledgement {ok:true}",
  "逐台结果（queued/success/error）\n\n逐台结果（queued/success/error）":
    "Per-executor results (queued/success/error)\n\nPer-executor results (queued/success/error)",
  "产物二进制内容（Res 直传）\n\n产物二进制内容（Res 直传）":
    "Artifact binary content (passed through via Res)\n\nArtifact binary content (passed through via Res)",

  "触发参数覆盖；序列化后体积不得超过 65536 字节（与 webhook 面同一上限）":
    "Trigger parameter overrides; the serialized size must not exceed 65536 bytes (same limit as the webhook face)",
  "任务 ID 列表（1..500 个 uuid）": "List of task IDs (1..500 uuids)",
  "环境变量覆盖（≤50 个键，每个值 ≤4096 字节）":
    "Environment variable overrides (<=50 keys, each value <=4096 bytes)",

  "ADR-017 阶段 3（protocol v6）：发起回调的执行器的稳定安装标识——sha256(deviceId + ':' + installSalt)，64 位小写十六进制字符，与 register/heartbeat 同值。它是本次回调的**行身份**：共享/旧版 token 不绑定任何行，且当 pull 模式的执行器共用同一地址后，`executorAddress` 已无法唯一标识一行（ADR-017 §5）。admin 用它把回调归属到该执行实际派发到的那一行。可选——旧版执行器、采集失败以及 SDK 调用方会省略；此时 admin 依次回落到凭据持有行、再回落到地址相等（绝不因缺失而拒绝）。":
    "ADR-017 phase 3 (protocol v6): stable install identifier of the executor that issued the callback -- sha256(deviceId + ':' + installSalt), 64 lowercase hex chars, same value as register/heartbeat. It is the row identity of this callback: shared/legacy tokens are bound to no row, and once pull-mode executors share an address, `executorAddress` can no longer uniquely identify a row (ADR-017 §5). admin uses it to attribute the callback to the exact row this execution was dispatched to. Optional -- legacy executors, collection failures and SDK callers omit it; admin then falls back to the credential-owning row, then to address equality (never rejecting for its absence).",
};

const map = JSON.parse(fs.readFileSync(MAP, "utf8"));
let added = 0;
let existed = 0;
for (const [zh, en] of Object.entries(ADD)) {
  if (Object.prototype.hasOwnProperty.call(map, zh)) {
    existed++;
    continue;
  }
  map[zh] = en;
  added++;
}
// 键排序：新增不造成整文件重排，diff 稳定
const sorted = {};
for (const k of Object.keys(map).sort()) sorted[k] = map[k];
fs.writeFileSync(MAP, JSON.stringify(sorted, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ added, existed, total: Object.keys(map).length }, null, 2));
