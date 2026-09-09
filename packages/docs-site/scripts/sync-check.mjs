#!/usr/bin/env node
// ── DOC-09：文档站 ↔ 仓库源头文档 drift 同步校验 ─────────────────────────
// packages/docs-site 是仓库文档的「镜像视图」（重组而非重写），内容纪律是
// 「先改源头文档，再同步到站点」。本脚本在构建/部署前机检可机检面：
// 版本号、截断常量、failureReason 枚举、CallbackItemDto 字段、env 注入表、
// 能力矩阵行数——源头改了而站点没同步（或反向）时 exit 1 + 差异清单，
// CI 变红拦截，由人工按差异清单同步（**不做自动覆盖**：站点侧的导航改写、
// 相对链接改 GitHub 绝对链接等重组痕迹会被自动覆盖破坏）。
//
// 零依赖：仅 node:fs / node:path / node:module，node ≥ 18 直接可跑。
// 用法：node packages/docs-site/scripts/sync-check.mjs（仓库根执行；
//       CI 在 docs-site-build 与 docs-site-deploy 两处挂载）。
// 自检：node packages/docs-site/scripts/sync-check.selftest.mjs
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// 脚本位于 packages/docs-site/scripts/，仓库根 = 三级向上
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SITE = join(REPO_ROOT, "packages", "docs-site");

function readRepo(rel) {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}
function readSite(rel) {
  return readFileSync(join(SITE, rel), "utf8");
}

// ── 判据 ①：lockstep 版本号（三包 manifest + py __version__ 为事实源）────
// 站点所有页面出现的「当前版本」必须与事实源一致；事实源自身不一致也红。
export function checkVersions() {
  const errors = [];
  const nodePkg = JSON.parse(readRepo("packages/autocodeflow-node-sdk/package.json"));
  const mcpPkg = JSON.parse(readRepo("packages/mcp-server/package.json"));
  const pyproject = readRepo("packages/autoflow-sdk/pyproject.toml");
  const pyInit = readRepo("packages/autoflow-sdk/autoflow_sdk/__init__.py");
  const m = /^version\s*=\s*"([^"]+)"/m.exec(pyproject);
  const pyVersion = m ? m[1] : null;
  const pyInitVersion = /__version__\s*=\s*"([^"]+)"/.exec(pyInit)?.[1] ?? null;

  const sources = [
    ["packages/autocodeflow-node-sdk/package.json", nodePkg.version],
    ["packages/mcp-server/package.json", mcpPkg.version],
    ["packages/autoflow-sdk/pyproject.toml", pyVersion],
    ["packages/autoflow-sdk/autoflow_sdk/__init__.py", pyInitVersion],
  ];
  const versions = new Set(sources.map(([, v]) => v));
  if (versions.size !== 1 || versions.has(null) || versions.has(undefined)) {
    errors.push(
      `lockstep 版本事实源自身不一致：${sources.map(([f, v]) => `${f}=${v}`).join("，")}`
    );
    return { errors, version: null };
  }
  const version = [...versions][0];

  // 站点页面中「当前 X.Y.Z」形态的版本声明（sdk-node/sdk-python/getting-started/
  // release/index 均用此措辞；release.md 版本矩阵另有 **X.Y.Z** 加粗形态）
  const sitePages = [
    "sdk-node.md",
    "sdk-python.md",
    "getting-started.md",
    "release.md",
    "index.md",
  ];
  for (const page of sitePages) {
    const text = readSite(page);
    const found = new Set();
    // 「当前版本 **X.Y.Z**」「当前 X.Y.Z」「lockstep X.Y.Z」等站点惯用声明形态
    for (const mm of text.matchAll(/当前\s*(?:版本\s*)?\*{0,2}(\d+\.\d+\.\d+)\*{0,2}/g)) {
      found.add(mm[1]);
    }
    for (const mm of text.matchAll(/lockstep\s*\*{0,2}(\d+\.\d+\.\d+)\*{0,2}/gi)) {
      found.add(mm[1]);
    }
    for (const v of found) {
      if (v !== version) {
        errors.push(`${page}：版本声明 ${v} ≠ 事实源 ${version}（lockstep 漂移）`);
      }
    }
  }
  return { errors, version };
}

// ── 判据 ②：截断常量（SDK 源码为事实源，站点文档必须同值）────────────────
export function checkTruncationConstants() {
  const errors = [];
  const nodeCtx = readRepo("packages/autocodeflow-node-sdk/src/context.ts");
  const pyCallback = readRepo("packages/autoflow-sdk/autoflow_sdk/callback.py");

  const nodeErr = /ERROR_MESSAGE_MAX_LENGTH\s*=\s*(\d+)/.exec(nodeCtx)?.[1];
  const nodeLogs = /LOGS_MAX_LENGTH\s*=\s*([\d_]+)/.exec(nodeCtx)?.[1]?.replace(/_/g, "");
  const pyErr = /ERROR_MESSAGE_MAX_LENGTH\s*=\s*(\d+)/.exec(pyCallback)?.[1];
  const pyLogs = /LOGS_MAX_LENGTH\s*=\s*([\d_]+)/.exec(pyCallback)?.[1]?.replace(/_/g, "");

  if (!nodeErr || !nodeLogs || !pyErr || !pyLogs) {
    errors.push("SDK 源码截断常量解析失败（context.ts / callback.py 结构变化？）");
    return { errors, constants: null };
  }
  if (nodeErr !== pyErr || nodeLogs !== pyLogs) {
    errors.push(
      `双 SDK 截断常量不一致：errorMessage ${nodeErr}/${pyErr}，logs ${nodeLogs}/${pyLogs}`
    );
  }
  // 站点文档以「4 KB」「512 KB」表述（contract.md / sdk-node.md / sdk-python.md）
  const expectErrKB = Number(nodeErr) / 1024; // 4096 → 4
  const expectLogsKB = Number(nodeLogs) / 1024; // 512000 → 500（DTO maxLength 注释同值）
  const siteText =
    readSite("contract.md") + readSite("sdk-node.md") + readSite("sdk-python.md");
  // 站点只允许出现与常量一致的 KB 值（4 KB / 500 KB 或 512 KB 表述——
  // 512_000 字节 = 500 KiB，历史文档两种写法并存，此处按事实源字节值换算放行）
  const allowed = new Set([String(expectErrKB), String(Number(nodeErr) / 1000)]);
  const allowedLogs = new Set([
    String(expectLogsKB),
    String(Number(nodeLogs) / 1000),
    String(Math.round(Number(nodeLogs) / 1024)),
  ]);
  for (const mm of siteText.matchAll(/截断\s*(\d+)\s*KB/g)) {
    const kb = mm[1];
    if (!allowed.has(kb) && !allowedLogs.has(kb)) {
      errors.push(`站点截断表述 ${kb} KB 与 SDK 常量（errorMessage=${nodeErr}B / logs=${nodeLogs}B）不符`);
    }
  }
  return { errors, constants: { nodeErr, nodeLogs, pyErr, pyLogs } };
}

// ── 判据 ③：failureReason 枚举（admin DTO ↔ py 白名单 ↔ 站点「九类」表述）──
export function checkFailureReasonEnum() {
  const errors = [];
  const entity = readRepo("apps/admin-api/src/modules/task/entities/task-execution.entity.ts");
  const pyCallback = readRepo("packages/autoflow-sdk/autoflow_sdk/callback.py");

  const enumBody = /enum ExecutionFailureReason \{([\s\S]*?)\}/.exec(entity)?.[1];
  if (!enumBody) {
    errors.push("ExecutionFailureReason 枚举解析失败（task-execution.entity.ts 结构变化？）");
    return { errors, enumCount: null };
  }
  const enumValues = [...enumBody.matchAll(/=\s*"([a-z_]+)"/g)].map((m) => m[1]);
  const whitelistBody = /VALID_FAILURE_REASONS\s*=\s*frozenset\(\{([\s\S]*?)\}\)/.exec(pyCallback)?.[1];
  if (!whitelistBody) {
    errors.push("py SDK VALID_FAILURE_REASONS 解析失败（callback.py 结构变化？）");
    return { errors, enumCount: enumValues.length };
  }
  const whitelist = [...whitelistBody.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  for (const v of enumValues) {
    if (!whitelist.includes(v)) {
      errors.push(`py SDK 白名单缺枚举值 ${v}（admin DTO @IsIn 会拒绝，客户端却放行）`);
    }
  }
  for (const v of whitelist) {
    if (!enumValues.includes(v)) {
      errors.push(`py SDK 白名单含 admin 枚举不存在的值 ${v}（客户端会误拒合法值）`);
    }
  }
  // 站点表述「BUG-10 九类」——枚举扩类时该数字表述必须同步
  const expected = enumValues.length;
  const siteText = readSite("sdk-python.md") + readSite("capability-matrix.md");
  for (const mm of siteText.matchAll(/BUG-10\s*(\S+?)类/g)) {
    const n = Number(mm[1].replace(/[^0-9]/g, ""));
    if (!Number.isNaN(n) && n !== 0 && n !== expected) {
      errors.push(`站点「BUG-10 ${mm[1]}类」表述与枚举实际 ${expected} 类不符（ExecutionFailureReason 已扩类？）`);
    }
  }
  return { errors, enumCount: expected };
}

// ── 判据 ④：CallbackItemDto 字段清单（DTO 源码 ↔ 站点 contract.md 字段表）──
export function checkCallbackDtoFields() {
  const errors = [];
  const dto = readRepo("apps/admin-api/src/modules/task/dto/execution-callback.dto.ts");
  const classBody = /export class CallbackItemDto \{([\s\S]*?)\n\}/.exec(dto)?.[1];
  if (!classBody) {
    errors.push("CallbackItemDto 解析失败（execution-callback.dto.ts 结构变化？）");
    return { errors, dtoFields: null };
  }
  const dtoFields = [...classBody.matchAll(/^\s{2}(\w+)\??\s*:/gm)].map((m) => m[1]);
  // 站点 contract.md「回调契约（CallbackItemDto）」字段表
  const contract = readSite("contract.md");
  const section = contract.slice(contract.indexOf("## 回调契约（CallbackItemDto）"));
  const tableFields = [...section.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]);
  for (const f of dtoFields) {
    if (!tableFields.includes(f)) {
      errors.push(`站点 contract.md 字段表缺 CallbackItemDto.${f}（DTO 已加字段，站点未同步）`);
    }
  }
  for (const f of tableFields) {
    if (!dtoFields.includes(f)) {
      errors.push(`站点 contract.md 字段表含 DTO 不存在的字段 ${f}（DTO 已删/改名，站点未同步）`);
    }
  }
  return { errors, dtoFields };
}

// ── 判据 ⑤：env 注入表变量清单（docs/sdk-guide.md ↔ 站点 getting-started.md）──
export function checkEnvInjectionTable() {
  const errors = [];
  const guide = readRepo("docs/sdk-guide.md");
  const site = readSite("getting-started.md");
  const vars = ["TASK_ID", "TASK_NAME", "EXECUTION_ID", "AUTOFLOW_<KEY>", "AUTOFLOW_ADMIN_API_URL", "AUTOFLOW_CALLBACK_TOKEN", "AUTOFLOW_EXECUTOR_ADDRESS"];
  for (const v of vars) {
    const inGuide = guide.includes(`| \`${v}\` |`);
    const inSite = site.includes(`| \`${v}\` |`);
    if (inGuide !== inSite) {
      errors.push(
        `env 注入表漂移：\`${v}\` ${inGuide ? "仅在 docs/sdk-guide.md" : "仅在站点 getting-started.md"} 的注入表中出现`
      );
    }
  }
  return { errors };
}

// ── 判据 ⑥：能力矩阵行数（docs/sdk-guide.md ↔ 站点 capability-matrix.md）──
// 矩阵能力项行以「| **能力项** | ...」形态书写；两侧行名集合与行数不一致
// 即矩阵增删未同步。行名按名字比对（顺序重排不误报），名字含 `*` 的行
// （如「env 注入: AUTOFLOW_\* 参数」）取字面前缀比对。
export function checkCapabilityMatrixRows() {
  const errors = [];
  const extractRows = (text) =>
    [...text.matchAll(/^\| \*\*(.+?)\*\* \|/gm)]
      .map((m) => m[1].replace(/\\(.)/g, "$1").trim())
      .filter((name) => !name.includes("|")); // 排除表内嵌套形态的误匹配
  const guideRows = extractRows(readRepo("docs/sdk-guide.md"));
  const siteRows = extractRows(readSite("capability-matrix.md"));
  const guideSet = new Set(guideRows);
  const siteSet = new Set(siteRows);
  for (const name of guideRows) {
    if (!siteSet.has(name)) {
      errors.push(`能力矩阵缺行：docs/sdk-guide.md 有「${name}」，站点 capability-matrix.md 无`);
    }
  }
  for (const name of siteRows) {
    if (!guideSet.has(name)) {
      errors.push(`能力矩阵多行：站点 capability-matrix.md 有「${name}」，docs/sdk-guide.md 无`);
    }
  }
  // 站点首页/README 的「N 项」表述与实际行数一致
  const expected = guideRows.length;
  const claims = readSite("index.md") + readSite("README.md");
  for (const mm of claims.matchAll(/(\d+)\s*项/g)) {
    const n = Number(mm[1]);
    if (n !== expected) {
      errors.push(`站点「${n} 项」表述与能力矩阵实际 ${expected} 行不符`);
    }
  }
  return { errors, guideRows: guideRows.length, siteRows: siteRows.length };
}

// ── 判据 ⑦：契约面四条（contract-fixtures/README.md ↔ 站点 contract.md）────
// 信封/错误体行为是破坏性契约面，站点镜像必须与源头逐条同在。
export function checkContractSurface() {
  const errors = [];
  const src = readRepo("packages/contract-fixtures/README.md");
  const site = readSite("contract.md");
  const surfaces = [
    ["envelope", "成功响应一律 `{ code, message: \"success\", data }`"],
    ["passthrough", "非信封形态的 body 原样返回"],
    ["2xx 区间", "200..299 一律按成功处理"],
    ["错误体 detail 提取顺序", "`message`(string)"],
  ];
  for (const [name, marker] of surfaces) {
    const inSrc = src.includes(marker);
    const inSite = site.includes(marker);
    if (inSrc !== inSite) {
      errors.push(
        `契约面「${name}」漂移：${inSrc ? "仅源头" : "仅站点"}含关键表述「${marker}」`
      );
    }
  }
  // contract.json 的 $schemaVersion 变更属破坏性契约变更，站点必须同步提及
  const contractJson = JSON.parse(readRepo("packages/contract-fixtures/contract.json"));
  const schemaVersion = String(contractJson.$schemaVersion);
  if (!site.includes(String(schemaVersion)) && !site.includes("`$schemaVersion`")) {
    errors.push(
      `站点 contract.md 未反映 contract.json $schemaVersion=${schemaVersion}（破坏性契约变更需同步）`
    );
  }
  return { errors };
}

export function runAllChecks() {
  const checks = [
    ["lockstep 版本号", checkVersions],
    ["截断常量", checkTruncationConstants],
    ["failureReason 枚举", checkFailureReasonEnum],
    ["CallbackItemDto 字段", checkCallbackDtoFields],
    ["env 注入表", checkEnvInjectionTable],
    ["能力矩阵行数", checkCapabilityMatrixRows],
    ["契约面", checkContractSurface],
  ];
  const results = [];
  for (const [name, fn] of checks) {
    try {
      const r = fn();
      results.push({ name, errors: r.errors ?? [] });
    } catch (e) {
      results.push({ name, errors: [`校验器异常：${e?.message ?? e}`] });
    }
  }
  return results;
}

function main() {
  const results = runAllChecks();
  const errors = results.flatMap((r) => r.errors.map((e) => `[${r.name}] ${e}`));
  if (errors.length) {
    console.error(`✘ 文档站同步校验失败（DOC-09，${errors.length} 项 drift）：`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      "\n  纪律：先改源头文档（docs/sdk-guide.md / 双 SDK README / contract-fixtures），再人工同步到 packages/docs-site 对应页面；不要让脚本自动覆盖站点侧的重组改写。"
    );
    process.exit(1);
  }
  const covered = results.map((r) => r.name).join("、");
  console.log(`✔ 文档站同步校验通过（DOC-09）：${covered} 七面无 drift`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) main();
