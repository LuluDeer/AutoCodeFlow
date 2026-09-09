#!/usr/bin/env node
// scripts/sync-check.mjs 自检（DOC-09）：临时目录构造「源头 ↔ 站点」文件对矩阵，
// 断言全部判据的命中/放行/拦截行为。不触碰仓库真实文档（只读真实文件做
// 「当前应绿」冒烟，其余用 tmp 沙箱注入漂移）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let failures = 0;
function assert(name, cond) {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name}`);
  }
}

// ── 沙箱：把 sync-check.mjs 复制进 tmp 仓库骨架，注入受控文件后动态 import ──
// sync-check 以 import.meta.url 定位仓库根（scripts/ 上三级），因此把脚本
// 原文放进 <tmp>/packages/docs-site/scripts/ 即可让 REPO_ROOT 指向 <tmp>。
const scriptSrc = new URL("./sync-check.mjs", import.meta.url).pathname;
const realSrc = readFileSync(scriptSrc, "utf8");

async function loadSandbox(files) {
  const tmp = mkdtempSync(join(tmpdir(), "acf-sync-check-"));
  const scriptDir = join(tmp, "packages", "docs-site", "scripts");
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(join(scriptDir, "sync-check.mjs"), realSrc);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(tmp, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  const mod = await import(join(scriptDir, "sync-check.mjs") + `?t=${Date.now()}-${Math.random()}`);
  return { mod, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

// ── 受控基线：一份自洽的最小「源头 + 站点」文件集（应全绿）──────────────
const V = "2.3.4";
const baseline = {
  "packages/autocodeflow-node-sdk/package.json": JSON.stringify({ name: "x", version: V }),
  "packages/mcp-server/package.json": JSON.stringify({ name: "m", version: V }),
  "packages/autoflow-sdk/pyproject.toml": `version = "${V}"\n`,
  "packages/autoflow-sdk/autoflow_sdk/__init__.py": `__version__ = "${V}"\n`,
  "packages/autocodeflow-node-sdk/src/context.ts":
    "export const ERROR_MESSAGE_MAX_LENGTH = 4096;\nexport const LOGS_MAX_LENGTH = 512_000;\n",
  "packages/autoflow-sdk/autoflow_sdk/callback.py": `ERROR_MESSAGE_MAX_LENGTH = 4096
LOGS_MAX_LENGTH = 512_000
VALID_FAILURE_REASONS = frozenset({
    "script_error",
    "timeout",
    "killed",
})
`,
  "apps/admin-api/src/modules/task/entities/task-execution.entity.ts": `export enum ExecutionFailureReason {
  SCRIPT_ERROR = "script_error",
  TIMEOUT = "timeout",
  KILLED = "killed",
}
`,
  "apps/admin-api/src/modules/task/dto/execution-callback.dto.ts": `export class CallbackItemDto {
  executionId: string;
  status: "success" | "failed";
  logs?: string;
}
`,
  "docs/sdk-guide.md": `| \`TASK_ID\` | a | b |
| \`AUTOFLOW_CALLBACK_TOKEN\` | a | b |
| **http: 默认超时** | x | y |
| **callback: 截断上限** | x | y |
`,
  "packages/contract-fixtures/README.md":
    '成功响应一律 `{ code, message: "success", data }`；非信封形态的 body 原样返回；200..299 一律按成功处理；`message`(string) 提取。',
  "packages/contract-fixtures/contract.json": JSON.stringify({ $schemaVersion: 3 }),
  "packages/docs-site/sdk-node.md": `当前版本 **${V}**（与 py SDK lockstep）`,
  "packages/docs-site/sdk-python.md": `pip install autoflow-sdk # 当前 ${V}`,
  "packages/docs-site/getting-started.md": `npm install @autocodeflow/sdk # 当前 ${V}
| \`TASK_ID\` | a | b |
| \`AUTOFLOW_CALLBACK_TOKEN\` | a | b |
`,
  "packages/docs-site/release.md": `| \`@autocodeflow/sdk\` | npm | **${V}** | src |`,
  "packages/docs-site/index.md": "查看 2 项逐项对照",
  "packages/docs-site/README.md": "能力矩阵（ECO-01）2 项",
  "packages/docs-site/capability-matrix.md": `| **http: 默认超时** | x | y |
| **callback: 截断上限** | x | y |
`,
  "packages/docs-site/contract.md": `## 回调契约（CallbackItemDto）

| 字段 | 说明 |
|------|------|
| \`executionId\` | 必填 |
| \`status\` | success \\| failed |
| \`logs\` | 摘要（截断 4 KB） |

信封：成功响应一律 \`{ code, message: "success", data }\`；非信封形态的 body 原样返回；200..299 一律按成功处理；错误体 \`message\`(string) 提取。契约版本 $schemaVersion=3。
`,
};

// ── 用例 1：基线自洽 → 七面全绿 ─────────────────────────────────────────
{
  const { mod, cleanup } = await loadSandbox(baseline);
  const results = mod.runAllChecks();
  const allErrors = results.flatMap((r) => r.errors);
  assert("基线自洽：七面全绿", allErrors.length === 0);
  assert("基线自洽：七面全部执行", results.length === 7 && results.every((r) => r.errors.length === 0));
  cleanup();
}

// ── 用例 2：版本漂移（站点落后于事实源）→ 版本面红，其余绿 ─────────────
{
  const files = {
    ...baseline,
    "packages/autocodeflow-node-sdk/package.json": JSON.stringify({ name: "x", version: "9.9.9" }),
  };
  const { mod, cleanup } = await loadSandbox(files);
  const results = mod.runAllChecks();
  const ver = results.find((r) => r.name === "lockstep 版本号");
  assert("版本漂移：事实源不一致被拦截", ver.errors.length > 0 && ver.errors[0].includes("事实源自身不一致"));
  cleanup();
}
{
  const files = {
    ...baseline,
    "packages/docs-site/sdk-node.md": "当前版本 **0.0.1**（与 py SDK lockstep）",
  };
  const { mod, cleanup } = await loadSandbox(files);
  const results = mod.runAllChecks();
  const ver = results.find((r) => r.name === "lockstep 版本号");
  assert("版本漂移：站点页面旧版本号被拦截", ver.errors.some((e) => e.includes("sdk-node.md") && e.includes("0.0.1")));
  cleanup();
}

// ── 用例 3：截断常量漂移（SDK 源码改值，站点表述未跟）→ 截断面红 ────────
{
  const files = {
    ...baseline,
    "packages/autocodeflow-node-sdk/src/context.ts":
      "export const ERROR_MESSAGE_MAX_LENGTH = 8192;\nexport const LOGS_MAX_LENGTH = 512_000;\n",
    "packages/autoflow-sdk/autoflow_sdk/callback.py": `ERROR_MESSAGE_MAX_LENGTH = 8192
LOGS_MAX_LENGTH = 512_000
VALID_FAILURE_REASONS = frozenset({ "script_error" })
`,
    "apps/admin-api/src/modules/task/entities/task-execution.entity.ts": `export enum ExecutionFailureReason {
  SCRIPT_ERROR = "script_error",
}
`,
  };
  const { mod, cleanup } = await loadSandbox(files);
  const results = mod.runAllChecks();
  const trunc = results.find((r) => r.name === "截断常量");
  assert("截断漂移：站点 4 KB 表述与 8192 常量不符被拦截", trunc.errors.some((e) => e.includes("8192")));
  cleanup();
}

// ── 用例 4：failureReason 枚举双向漂移 → 枚举面红 ────────────────────────
{
  // admin 加枚举、py 白名单没跟（客户端放行非法值）
  const files = {
    ...baseline,
    "apps/admin-api/src/modules/task/entities/task-execution.entity.ts": `export enum ExecutionFailureReason {
  SCRIPT_ERROR = "script_error",
  TIMEOUT = "timeout",
  KILLED = "killed",
  NEW_REASON = "new_reason",
}
`,
  };
  const { mod, cleanup } = await loadSandbox(files);
  const results = mod.runAllChecks();
  const en = results.find((r) => r.name === "failureReason 枚举");
  assert("枚举漂移：admin 新增枚举 py 白名单缺项被拦截", en.errors.some((e) => e.includes("new_reason")));
  cleanup();
}
{
  // py 白名单多出 admin 不存在的值
  const files = {
    ...baseline,
    "packages/autoflow-sdk/autoflow_sdk/callback.py": `ERROR_MESSAGE_MAX_LENGTH = 4096
LOGS_MAX_LENGTH = 512_000
VALID_FAILURE_REASONS = frozenset({
    "script_error",
    "timeout",
    "killed",
    "ghost_reason",
})
`,
  };
  const { mod, cleanup } = await loadSandbox(files);
  const results = mod.runAllChecks();
  const en = results.find((r) => r.name === "failureReason 枚举");
  assert("枚举漂移：py 白名单幽灵值被拦截", en.errors.some((e) => e.includes("ghost_reason")));
  cleanup();
}

// ── 用例 5：CallbackItemDto 字段漂移（DTO 加字段站点没跟）→ 字段面红 ────
{
  const files = {
    ...baseline,
    "apps/admin-api/src/modules/task/dto/execution-callback.dto.ts": `export class CallbackItemDto {
  executionId: string;
  status: "success" | "failed";
  logs?: string;
  artifacts?: ArtifactManifestItemDto[];
}
`,
  };
  const { mod, cleanup } = await loadSandbox(files);
  const results = mod.runAllChecks();
  const dto = results.find((r) => r.name === "CallbackItemDto 字段");
  assert("DTO 漂移：新增字段站点缺行被拦截", dto.errors.some((e) => e.includes("artifacts")));
  cleanup();
}
{
  // 站点字段表含 DTO 已删字段
  const files = {
    ...baseline,
    "packages/docs-site/contract.md": baseline["packages/docs-site/contract.md"].replace(
      "| `logs` | 摘要（截断 4 KB） |",
      "| `logs` | 摘要（截断 4 KB） |\n| `legacyField` | 已删字段 |"
    ),
  };
  const { mod, cleanup } = await loadSandbox(files);
  const results = mod.runAllChecks();
  const dto = results.find((r) => r.name === "CallbackItemDto 字段");
  assert("DTO 漂移：站点幽灵字段被拦截", dto.errors.some((e) => e.includes("legacyField")));
  cleanup();
}

// ── 用例 6：env 注入表漂移（源头删变量站点没跟）→ env 面红 ─────────────
{
  const files = {
    ...baseline,
    "docs/sdk-guide.md": `| \`TASK_ID\` | a | b |
| **http: 默认超时** | x | y |
`,
  };
  const { mod, cleanup } = await loadSandbox(files);
  const results = mod.runAllChecks();
  const env = results.find((r) => r.name === "env 注入表");
  assert("env 漂移：源头删行站点残留被拦截", env.errors.some((e) => e.includes("AUTOFLOW_CALLBACK_TOKEN")));
  cleanup();
}

// ── 用例 7：能力矩阵漂移（行增删 + 「N 项」表述）→ 矩阵面红 ────────────
{
  const files = {
    ...baseline,
    "docs/sdk-guide.md": baseline["docs/sdk-guide.md"] + "\n| **新能力项** | x | y |\n",
  };
  const { mod, cleanup } = await loadSandbox(files);
  const results = mod.runAllChecks();
  const mx = results.find((r) => r.name === "能力矩阵行数");
  assert("矩阵漂移：源头加行站点缺行被拦截", mx.errors.some((e) => e.includes("新能力项")));
  cleanup();
}
{
  const files = {
    ...baseline,
    "packages/docs-site/index.md": "查看 5 项逐项对照",
  };
  const { mod, cleanup } = await loadSandbox(files);
  const results = mod.runAllChecks();
  const mx = results.find((r) => r.name === "能力矩阵行数");
  assert("矩阵漂移：「5 项」表述与实际 2 行不符被拦截", mx.errors.some((e) => e.includes("5 项")));
  cleanup();
}

// ── 用例 8：契约面漂移（源头改信封表述站点没跟）→ 契约面红 ─────────────
{
  const files = {
    ...baseline,
    "packages/contract-fixtures/README.md":
      "信封改为 `{ code, message, data, meta }`；非信封形态的 body 原样返回；200..299 一律按成功处理；`message`(string) 提取。",
  };
  const { mod, cleanup } = await loadSandbox(files);
  const results = mod.runAllChecks();
  const ct = results.find((r) => r.name === "契约面");
  assert("契约漂移：envelope 表述单侧变更被拦截", ct.errors.some((e) => e.includes("envelope")));
  cleanup();
}

// ── 用例 9：真实仓库冒烟——当前工作区状态应与主脚本实跑结论一致 ─────────
// （不硬编码绿/红：只断言脚本能对真实文件完成七面校验且无异常。）
{
  const realMod = await import(scriptSrc + `?real=${Date.now()}`);
  // 真实仓库的 REPO_ROOT 指向本仓库根（scripts/ 上三级），直接跑
  const results = realMod.runAllChecks();
  assert("真实仓库：七面校验全部可执行（无校验器异常）", results.length === 7 && results.every((r) => !r.errors.some((e) => e.includes("校验器异常"))));
}

console.log(failures === 0 ? "\n✔ sync-check.selftest 全部通过" : `\n✘ sync-check.selftest 失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
