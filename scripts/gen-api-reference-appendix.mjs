#!/usr/bin/env node
/**
 * api-reference.md 的**端点清单**与 OpenAPI 的同步守卫（含生成器）。
 *
 * 背景：`docs/api-reference.md` 里的端点表是**手写**的。实测漂移很大——OpenAPI 里 194 个路径，
 * 文档里缺 **47 个**（整个 SOP 面、agent-collab、agent sessions、通知静默、若干 removal-impact /
 * 机器面端点）。**API 参考缺端点比缺形容词严重**：读的人会以为「这个能力没有接口」。
 *
 * 做法（与 audit.md 同一模式：把易腐化的枚举交给代码）：
 *   ① 生成一段「补充端点」附录，插在 API-APPENDIX 标记之间，内容来自 openapi.json；
 *   ② 守卫要求**每个 OpenAPI 路径都出现在文档里**（正文或附录），且附录与生成结果**逐字节一致**；
 *   ③ 正文仍手写（职责、约定、鉴权说明是描述不是清单，腐化速度完全不同）。
 *
 * 用法：
 *   node scripts/gen-api-reference-appendix.mjs          # 重新生成附录（写回文档）
 *   node scripts/gen-api-reference-appendix.mjs --check  # 守卫（CI）：漂移即失败
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OPENAPI = join(ROOT, "apps", "admin-api", "openapi.json");
const DOC = join(ROOT, "docs", "api-reference.md");
const START = "<!-- API-APPENDIX:START -->";
const END = "<!-- API-APPENDIX:END -->";
const METHODS = ["get", "post", "patch", "put", "delete"];

/** 文档里的路径写法是 `:param`，OpenAPI 是 `{param}`；比对前统一成后者。 */
function normalize(p) {
  let s = p.split("?")[0].trim();
  s = s.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  if (s.startsWith("/api/")) s = s.slice(4);
  return s;
}

function buildAppendix() {
  const spec = JSON.parse(readFileSync(OPENAPI, "utf8"));
  const rows = [];
  for (const [p, ops] of Object.entries(spec.paths ?? {})) {
    for (const m of METHODS) {
      const op = ops[m];
      if (!op) continue;
      const summary = String(op.summary ?? "").replace(/\|/g, "\\|").trim();
      rows.push({ method: m.toUpperCase(), path: p, summary });
    }
  }
  rows.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
  const lines = [];
  lines.push(START);
  lines.push("");
  lines.push("## 补充端点（由 `openapi.json` 生成，勿手改）");
  lines.push("");
  lines.push(
    "> 本节由 `scripts/gen-api-reference-appendix.mjs` 从 `apps/admin-api/openapi.json` 生成，" +
      "`scripts/gen-api-reference-appendix.mjs --check` 守卫：**少一个端点或多一个端点都会红**。",
  );
  lines.push("> 上面各节按模块手写（职责 / 约定 / 鉴权），本节只保证**端点集合完整**。");
  lines.push("");
  lines.push("共 " + rows.length + " 个操作，覆盖 " + (spec.paths ? Object.keys(spec.paths).length : 0) + " 个路径。");
  lines.push("");
  lines.push("| 方法 | 路径 | 摘要 |");
  lines.push("|---|---|---|");
  for (const r of rows) lines.push("| " + r.method + " | `" + r.path + "` | " + (r.summary || "-") + " |");
  lines.push("");
  lines.push(END);
  return lines.join("\n");
}

function extractDocPaths(doc) {
  const body = doc.split(START)[0];
  return new Set(
    [...body.matchAll(/^\|\s*(GET|POST|PATCH|PUT|DELETE)\s*\|\s*`([^`]+)`/gm)].map((m) => normalize(m[2])),
  );
}

const check = process.argv.includes("--check");
const doc = readFileSync(DOC, "utf8");
const generated = buildAppendix();

if (!check) {
  const startIdx = doc.indexOf(START);
  const endIdx = doc.indexOf(END);
  const next =
    startIdx >= 0 && endIdx > startIdx
      ? doc.slice(0, startIdx) + generated + doc.slice(endIdx + END.length)
      : doc.trimEnd() + "\n\n" + generated + "\n";
  writeFileSync(DOC, next, "utf8");
  console.log("✔ 已生成补充端点附录（" + generated.split("\n").length + " 行）");
  process.exit(0);
}

const spec = JSON.parse(readFileSync(OPENAPI, "utf8"));
const apiPaths = Object.keys(spec.paths ?? {});
const docPaths = extractDocPaths(doc);
const appendixOk = doc.includes(generated);
const missing = apiPaths.filter((p) => !docPaths.has(p) && !doc.includes("`" + p + "`"));

if (!appendixOk || missing.length > 0) {
  console.error("");
  if (!appendixOk) console.error("✖ 补充端点附录与 openapi.json 不一致（或缺失）");
  if (missing.length > 0) {
    console.error("✖ " + missing.length + " 个端点没出现在 api-reference.md：");
    for (const p of missing.slice(0, 20)) console.error("  " + p);
    if (missing.length > 20) console.error("  …（共 " + missing.length + " 个）");
  }
  console.error("");
  console.error("  修法：node scripts/gen-api-reference-appendix.mjs（重新生成附录）。**不要**改守卫放行。");
  process.exit(1);
}

console.log(
  "✔ api-reference 端点完整：" + apiPaths.length + " 个路径全部覆盖，附录与 openapi 逐字节一致。",
);
