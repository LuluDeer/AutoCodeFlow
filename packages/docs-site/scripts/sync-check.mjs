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
import { fileURLToPath, pathToFileURL } from "node:url";

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

// ── 判据 ①：lockstep 版本号（四包 manifest + py __version__ 为事实源）────
// 站点所有页面出现的「当前版本」必须与事实源一致；事实源自身不一致也红。
export function checkVersions() {
  const errors = [];
  const nodePkg = JSON.parse(readRepo("packages/autocodeflow-node-sdk/package.json"));
  const mcpPkg = JSON.parse(readRepo("packages/mcp-server/package.json"));
  const cliPkg = JSON.parse(readRepo("packages/acf-cli/package.json"));
  const pyproject = readRepo("packages/autoflow-sdk/pyproject.toml");
  const pyInit = readRepo("packages/autoflow-sdk/autoflow_sdk/__init__.py");
  const m = /^version\s*=\s*"([^"]+)"/m.exec(pyproject);
  const pyVersion = m ? m[1] : null;
  const pyInitVersion = /__version__\s*=\s*"([^"]+)"/.exec(pyInit)?.[1] ?? null;

  const sources = [
    ["packages/autocodeflow-node-sdk/package.json", nodePkg.version],
    ["packages/mcp-server/package.json", mcpPkg.version],
    ["packages/acf-cli/package.json", cliPkg.version],
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
    // 带 `x-release-please-version` 标记的行：与 release-please 的更新面**同源**
    // 判据。原先只认上面两种措辞形态，于是 release.md 版本矩阵表格里的
    // `**1.4.4**`（表格行，非「当前 X.Y.Z」措辞）长期是**校验盲区**——它已经
    // 漂到 1.4.4 而标题还写 1.4.3，守卫却一声不吭。改为「凡是 release-please
    // 会去改的行，就必须等于事实源」，判据面与更新面天然对齐，不会再有盲区。
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes("x-release-please-version")) continue;
      const mm = /\d+\.\d+\.\d+/.exec(line);
      if (mm) found.add(mm[0]);
    }
    for (const v of found) {
      if (v !== version) {
        errors.push(`${page}：版本声明 ${v} ≠ 事实源 ${version}（lockstep 漂移）`);
      }
    }
  }
  // acf-cli（@autocodeflow/cli）的版本号曾写在**无标记**的散文里（「当前包内
  // version 1.5.3」），而其 manifest 已到 1.8.0——既有的三种措辞正则都扫不到
  // 它，是本轮实证的校验盲区。锁法与上三包对齐：release.md 保留一行 acf-cli 的
  // `x-release-please-version` 标记行（版本值由上方标记行扫描与事实源比对），
  // 本检查钉住「标记行不得被删」——删行即红，盲区不得回潮。
  const cliMarkerLine = readSite("release.md")
    .split(/\r?\n/)
    .find((l) => l.includes("acf-cli") && l.includes("x-release-please-version"));
  if (!cliMarkerLine) {
    errors.push(
      "release.md 缺少 acf-cli（@autocodeflow/cli）的 x-release-please-version 标记行——第四个 lockstep 包的版本声明必须带标记锁位"
    );
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

// ── 判据 ③：failureReason 枚举（契约 ↔ admin 枚举 ↔ py 白名单 ↔ 站点「九类」表述）──
//
// A3（DEEP_REVIEW §七）：语义从「admin 枚举 == py 白名单」变为
// **「py 白名单 == 枚举 − admin 内部专用」**——`stale_recovered` 由 admin 的 stale
// sweep 写入、语义上只有 admin 才该写，执行器/SDK 上报它会被 admin 的 @IsIn 拒绝
// （且一个非法取值会拒掉**整批**回调）。单一事实源是
// `packages/executor-protocol/protocol.json`（四方共载），本判据此处顺带把契约与
// 枚举、白名单三方对齐也纳入机检。
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

  // ① 契约 ↔ admin 枚举：全集必须逐值一致
  const protocol = JSON.parse(readRepo("packages/executor-protocol/protocol.json"));
  const all = protocol.failureReason.all ?? [];
  const reportable = protocol.failureReason.executorReportable ?? [];
  const internal = protocol.failureReason.adminInternalOnly ?? [];

  for (const v of enumValues) {
    if (!all.includes(v)) {
      errors.push(`契约 failureReason.all 缺枚举值 ${v}（枚举已扩类——同步 packages/executor-protocol/protocol.json）`);
    }
  }
  for (const v of all) {
    if (!enumValues.includes(v)) {
      errors.push(`契约 failureReason.all 含枚举不存在的值 ${v}（契约与 admin 枚举漂移）`);
    }
  }

  // ② 契约 ↔ py 白名单：白名单必须等于**可上报子集**
  for (const v of reportable) {
    if (!whitelist.includes(v)) {
      errors.push(`py SDK 白名单缺可上报值 ${v}（客户端会误拒合法值）`);
    }
  }
  for (const v of whitelist) {
    if (!reportable.includes(v)) {
      errors.push(`py SDK 白名单含非可上报值 ${v}（客户端放行，但 admin DTO @IsIn 已收窄为可上报子集，会拒掉整批回调）`);
    }
  }

  // ③ 契约自洽：内部专用 ⊆ 全集，且与可上报子集互斥
  for (const v of internal) {
    if (!all.includes(v)) {
      errors.push(`契约 adminInternalOnly 含全集不存在的值 ${v}`);
    }
    if (reportable.includes(v)) {
      errors.push(`契约自相矛盾：${v} 同时出现在 adminInternalOnly 与 executorReportable`);
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

  /**
   * ⚠️ 取类体必须**按花括号配对**，不能用 `/export class X \{([\s\S]*?)\n\}/`。
   *
   * 非贪婪正则会停在**第一个** `\n}`，而类体里有嵌套的对象类型字面量，
   * 例如 `result?: Record<string, unknown>` 上方的
   * `@ApiProperty({ … properties: { … } })` 就会先遇到 `\n  }`。
   * 实测后果：捕获体越过类结尾继续延伸（拿到 2779 字符），于是
   * `^\s{2}(\w+)\??\s*:` 把**装饰器选项里的键**也当成了 DTO 字段——
   * 报出 `CallbackItemDto.example` / `.enum` / `.maxLength` / `.description`
   * 这些**根本不存在的"字段"**（14 项假红），真字段反而淹没其中。
   *
   * 这是"判据自身解析错了 ⇒ 门禁假红"的形态：假红会让人去改正确的文档，
   * 比假绿更需要优先修。故改为**计数配对**取整个类体。
   */
  const startM = /export class CallbackItemDto\s*\{/.exec(dto);
  let classBody = null;
  if (startM) {
    let depth = 0;
    let i = startM.index + startM[0].length - 1;
    const from = i;
    for (; i < dto.length; i++) {
      const c = dto[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth === 0) classBody = dto.slice(from + 1, i);
  }
  if (!classBody) {
    errors.push("CallbackItemDto 解析失败（execution-callback.dto.ts 结构变化？）");
    return { errors, dtoFields: null };
  }

  /**
   * ⚠️ 必须先**剥掉装饰器块**再抽字段。
   *
   * 类体里每个字段上方都有 `@ApiProperty({ … })`，其**选项键**
   * （`example` / `enum` / `maxLength` / `description` / `type` …）与字段声明
   * 在文本形态上无法区分：`^\s{2}(\w+)\??\s*:` 对
   * `  example: "f47a…",`（装饰器选项）与 `  executionId: string;`（真字段）
   * **都能匹配**——尤其当选项被格式化成 2 空格缩进时。
   *
   * 实测后果：门禁报出 `CallbackItemDto.example`、`.enum`、`.maxLength`、
   * `.description`、`.type`、`.additionalProperties` 这 6 个**根本不存在的
   * "字段"**（14 项假红），并淹没真字段差异。假红会驱使人去改**正确的**文档，
   * 比假绿更该优先修。
   *
   * 剥法：把 `@Name(...)` 连同其**配对括号**整体替换为空白（保留换行以维持
   * 行号）。括号计数而非正则，因为选项里含嵌套对象与字符串。
   */
  function stripDecorators(src) {
    let out = "";
    let i = 0;
    while (i < src.length) {
      if (src[i] === "@" && /[A-Za-z_$]/.test(src[i + 1] ?? "")) {
        let j = i + 1;
        while (j < src.length && /[\w$.]/.test(src[j])) j++;
        // 跳过装饰器名与括号之间的空白
        while (j < src.length && /\s/.test(src[j]) && src[j] !== "\n") j++;
        if (src[j] === "(") {
          let depth = 0;
          let inS = null;
          for (; j < src.length; j++) {
            const c = src[j];
            if (inS) {
              if (c === "\\") j++;
              else if (c === inS) inS = null;
              continue;
            }
            if (c === '"' || c === "'" || c === "`") {
              inS = c;
              continue;
            }
            if (c === "(") depth++;
            else if (c === ")") {
              depth--;
              if (depth === 0) {
                j++;
                break;
              }
            }
          }
          // 用等量空白（保留 \n）替换，维持行号
          for (let k = i; k < j; k++) out += src[k] === "\n" ? "\n" : " ";
          i = j;
          continue;
        }
      }
      out += src[i];
      i++;
    }
    return out;
  }

  // 字段判据：只认**类体顶层**声明（先剥装饰器，再按 ≤4 空格缩进匹配）。
  const bare = stripDecorators(classBody);
  const dtoFields = [...bare.matchAll(/^ {2,4}(\w+)\??\s*:/gm)].map((m) => m[1]);
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
  // A-11R：AUTOFLOW_PARAMS_JSON 是 params 类型化通道的唯一名字，出现在
  // docs/sdk-guide.md 的注入表与站点 getting-started.md 的镜像表里。漏同步
  // 会让用户照着站点文档读一个不存在的变量——与 A-11 引号事故同类的静默
  // 文档漂移，故纳入本判据。
  const vars = ["TASK_ID", "TASK_NAME", "EXECUTION_ID", "AUTOFLOW_<KEY>", "AUTOFLOW_PARAMS_JSON", "AUTOFLOW_ADMIN_API_URL", "AUTOFLOW_CALLBACK_TOKEN", "AUTOFLOW_EXECUTOR_ADDRESS"];
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


// ── 判据 ⑧：教程索引条目数/标题集合（docs/tutorials/index.md ↔ 站点 sidebar）──
// 站点教程是 docs/tutorials 的镜像：sidebar 的条目集合必须与源头索引表对得上。
// 事实（本轮实证）：源头 5 篇（01..05），sidebar 只镜像了 4 篇——差值没有判据
// 盯着，于是 05 缺席一直没人发现。本判据只比「条目/标题」，不比正文（正文由
// 人工同步纪律负责）：源头有条目而站点没有、站点有而源头没有、标题改了没跟，
// 三种漂移都红。
//
// 已知豁免：**当前为空**。05 已于 2026-10-27 补页
// （packages/docs-site/tutorial-05-sop-agent-demo.md + sidebar 条目），
// 豁免随之下线——这正是豁免表的设计意图：它是登记项而不是隐式默认，
// 补完必须删掉，否则"豁免过期"判据会红。
// 新增豁免时必须写清「补完要做什么」，否则下一个人只会续期不会偿还。
export const TUTORIAL_MIRROR_EXEMPT = [];

// 对齐键用**两位序号**而不是 slug：站点侧文件名是「重写」过的
// （源头 01-first-scheduled-task.md ↔ 站点 /tutorial-01-first-task），
// 按 slug 比会立刻误报两条；序号是两边都稳定、且人工排序时真正在意的东西。
/** 纯函数：解析源头教程索引表（| [01 · 标题](01-slug.md) | …）。 */
export function parseTutorialSource(text) {
  return [...text.matchAll(/^\|\s*\[([^\]]+)\]\((\d{2}-[a-z0-9-]+)\.md\)/gm)].map((m) => ({
    number: m[2].slice(0, 2),
    slug: m[2],
    title: m[1].trim(),
  }));
}

/** 纯函数：解析站点 sidebar 的教程条目（{ text: …, link: '/tutorial-NN-slug' }）。 */
export function parseTutorialSidebar(text) {
  return [...text.matchAll(/\{\s*text:\s*'([^']*)',\s*link:\s*'\/tutorial-(\d{2}-[a-z0-9-]+)'/g)].map((m) => ({
    number: m[2].slice(0, 2),
    slug: m[2],
    title: m[1].trim(),
  }));
}

/** 去掉「01 · 」前缀后比标题：序号由 slug 承载，标题只比主题本身。 */
function normalizeTutorialTitle(title) {
  return String(title).replace(/^\d{2}\s*·\s*/, "").replace(/\s+/g, " ").trim();
}

/**
 * 纯函数：比对源头索引与站点 sidebar（导出以便 selftest/反证直接喂字符串）。
 * @returns {{errors: string[], source: number, mirrored: number}}
 */
export function compareTutorialIndex({ source, sidebar, exempt = TUTORIAL_MIRROR_EXEMPT }) {
  const errors = [];
  const sourceByNumber = new Map(source.map((s) => [s.number, s]));
  const sidebarByNumber = new Map(sidebar.map((s) => [s.number, s]));
  const exemptByNumber = new Map(exempt.map((e) => [e.slug.slice(0, 2), e]));

  for (const item of sidebar) {
    if (!sourceByNumber.has(item.number)) {
      errors.push(
        `站点 sidebar 的教程 /tutorial-${item.slug} 在 docs/tutorials/index.md 中没有同序号条目` +
          `（源头已删/改名？）`,
      );
    }
  }
  for (const item of source) {
    const mirrored = sidebarByNumber.get(item.number);
    if (mirrored) {
      const a = normalizeTutorialTitle(item.title);
      const b = normalizeTutorialTitle(mirrored.title);
      if (a !== b) {
        errors.push(
          `教程 ${item.number} 标题漂移：源头「${item.title}」≠ 站点「${mirrored.title}」`,
        );
      }
      continue;
    }
    if (exemptByNumber.has(item.number)) continue;
    errors.push(
      `站点 sidebar 缺教程 ${item.slug}（源头 docs/tutorials/index.md 有条目「${item.title}」，` +
        `镜像未同步且未登记豁免）`,
    );
  }
  // 豁免过期也是漂移：源头删了教程而豁免还在，会把这个序号永久放行。
  for (const e of exempt) {
    if (!sourceByNumber.has(e.slug.slice(0, 2))) {
      errors.push(`教程镜像豁免 ${e.slug} 已不在源头索引中（豁免过期，删掉 TUTORIAL_MIRROR_EXEMPT 该条）`);
    }
  }
  return { errors, source: source.length, mirrored: sidebar.length };
}

export function checkTutorialIndex() {
  const source = parseTutorialSource(readRepo("docs/tutorials/index.md"));
  const sidebar = parseTutorialSidebar(readSite(".vitepress/config.mts"));
  if (source.length === 0) throw new Error("docs/tutorials/index.md 未解析出任何教程条目（表格格式变了？）");
  if (sidebar.length === 0) throw new Error("站点 .vitepress/config.mts 未解析出任何教程 sidebar 条目");
  return compareTutorialIndex({ source, sidebar });
}

function runCheck(name, fn) {
  try {
    return { name, errors: fn().errors ?? [] };
  } catch (e) {
    return { name, errors: [`校验器异常：${e?.message ?? e}`] };
  }
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
    // 判据 ⑧（2026-10-27 审计轮 #8）：站点教程索引 ↔ 源头 docs/tutorials/index.md。
    // 它此前不存在，于是"镜像 4 篇 vs 源头 5 篇"这种漂移无人发现（sync-check 只校验
    // 版本号/枚举/字段，不校验条目数）。05 号教程尚未镜像，用 TUTORIAL_MIRROR_EXEMPT
    // 显式登记豁免并写理由；豁免过期（源头新增/删改而豁免表没跟上）也会红。
    ["教程索引条目", checkTutorialIndex],
  ];
  return checks.map(([name, fn]) => runCheck(name, fn));
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
  console.log(`✔ 文档站同步校验通过（DOC-09）：${covered} ${results.length} 面无 drift`);
}

// DOC-09-GUARD（本轮审计）：入口判定此前是
//   import.meta.url.endsWith(process.argv[1].split("/").pop())
// Windows 上 Node 把脚本路径写成**反斜杠绝对路径**，`.split("/").pop()` 于是
// 返回整条路径、endsWith 恒为 false —— main() 从不执行：脚本零输出、退出 0。
// 即「文档站同步校验」在本地 Windows 上永远是绿的（CI 跑 ubuntu 故未暴露）。
// 改为 URL 比较（与 scripts/check-migrations.mjs 的 basename 写法同精神）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
