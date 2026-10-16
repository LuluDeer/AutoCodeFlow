#!/usr/bin/env node
/**
 * 一次性审计：把码表里的 `status` 与 **git HEAD 的旧异常类**逐条对账。
 *
 * ## 为什么要做这件事
 *
 * 「全量错误码化」把 `throw new XxxException("文案")` 换成 `AppError(码)`，而
 * 状态码从**异常类**搬到了**码表的 `status` 字段**。这一步是纯搬运，**极易搬错**，
 * 且错了不会报错——只会让某个端点的 HTTP 状态悄悄变化（前端分支、SDK、监控告警
 * 规则、以及按状态断言的大量 spec 会跟着变）。
 *
 * 本轮已实测踩到两例：
 *   · `OIDC_ACCOUNT_NOT_LINKED` 取 403（照抄了代码注释里的"403"），而 HEAD 实际是
 *     `UnauthorizedException` = 401；
 *   · `ACCOUNT_INACTIVE` 文案写成「账号已被停用」，而旧文案是「账号已被禁用」。
 *
 * 故做一次**穷举对账**：对每个码，找出迁移前该文案对应的异常类，与码表 status 比对。
 * 判据是「文案相同 ⇒ 状态应相同」，这是搬运正确性的必要条件（文案在迁移中被改写
 * 的码无法这样核对，故单独列为"无法核对"，不谎报为通过）。
 *
 * 用法: node scripts/api-i18n/audit-status-parity.mjs
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const CATALOG = path.join(ROOT, "apps/admin-api/src/common/errors/catalog");

/** 从 `git show HEAD:<file>` 里取全部 `throw new XException("msg")`。 */
function headThrows(file) {
  let src;
  try {
    src = execFileSync("git", ["show", `HEAD:${file}`], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const out = [];
  const re = /throw new (\w*Exception)\(\s*(?:`([^`]*)`|"((?:[^"\\]|\\.)*)")/g;
  for (const m of src.matchAll(re)) {
    out.push({ cls: m[1], text: (m[2] ?? m[3] ?? "").trim() });
  }
  return out;
}

/** 异常类名 → HTTP 状态。 */
const CLS_STATUS = {
  BadRequestException: 400,
  UnauthorizedException: 401,
  ForbiddenException: 403,
  NotFoundException: 404,
  MethodNotAllowedException: 405,
  NotAcceptableException: 406,
  RequestTimeoutException: 408,
  ConflictException: 409,
  GoneException: 410,
  PayloadTooLargeException: 413,
  UnsupportedMediaTypeException: 415,
  UnprocessableEntityException: 422,
  InternalServerErrorException: 500,
  NotImplementedException: 501,
  BadGatewayException: 502,
  ServiceUnavailableException: 503,
  GatewayTimeoutException: 504,
};

// 收集 HEAD 上所有"文案 → 状态"（跨全部 admin-api 源文件）
const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter((f) => f.startsWith("apps/admin-api/src/") && f.endsWith(".ts"))
  .filter((f) => !f.includes("__tests__") && !f.endsWith(".spec.ts"));

const byText = new Map();
for (const f of files) {
  for (const { cls, text } of headThrows(f)) {
    const st = CLS_STATUS[cls];
    if (st === undefined || !text) continue;
    if (!byText.has(text)) byText.set(text, new Set());
    byText.get(text).add(st);
  }
}

// 逐个码对账：用码表的 zh 模板（去占位）去 HEAD 文案里找
const shards = fs
  .readdirSync(CATALOG)
  .filter((f) => f.endsWith(".ts"));
let checked = 0;
let mismatched = 0;
let unverifiable = 0;
const problems = [];

for (const shard of shards) {
  const src = fs.readFileSync(path.join(CATALOG, shard), "utf8");
  const re = /\n {2}([A-Z][A-Z0-9_]*):\s*\{([\s\S]*?)\n {2}\},/g;
  for (const m of src.matchAll(re)) {
    const code = m[1];
    const body = m[2];
    const st = /status:\s*(\d+)/.exec(body);
    const zh = /zh:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/.exec(body);
    if (!st || !zh) continue;
    const status = Number(st[1]);
    const text = (zh[1] ?? zh[2] ?? "").replace(/\\"/g, '"');

    // 用模板去匹配 HEAD 文案：把 {{x}} 变成 .* 做前缀匹配
    const pat = new RegExp(
      "^" + text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\{\{\w+\}\}/g, ".*") + "$",
    );
    let found = null;
    for (const [t, set] of byText) {
      if (pat.test(t)) {
        found = set;
        break;
      }
    }
    if (!found) {
      unverifiable++;
      continue;
    }
    checked++;
    if (!found.has(status)) {
      mismatched++;
      problems.push({
        code,
        shard,
        catalogStatus: status,
        headStatus: [...found],
        text: text.slice(0, 80),
      });
    }
  }
}

console.log(
  JSON.stringify(
    {
      headDistinctTexts: byText.size,
      codesChecked: checked,
      mismatched,
      unverifiable,
      problems,
    },
    null,
    2,
  ),
);
