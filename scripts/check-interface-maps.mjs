#!/usr/bin/env node
/**
 * 接口地图 vs 代码守卫（几类自述清单，同一个病）。
 *
 * 病名：**手写枚举单向腐烂** —— 加功能的人不会回头改清单，删功能的人才会（因为删了会报错）。
 * 本仓已为此建过三道：CLI 命令表（`check-cli-doc.mjs`）、REST 全量附录
 * （`gen-api-reference-appendix --check`）、审计动作表（`check-audit-actions-doc.mjs`）。
 * 本脚本盯另外四处：
 *
 * ① `docs/atlas/05-interfaces/mcp-tools.md` —— 曾长期写「40 个」，而 `tools.ts` 实际注册 **56** 个，
 *    **漏了 16 个**且是**有序地漏**（越新的域越不在表里：Mutex / Project / SOP 三节整节缺失）。
 *    分域小标题里的计数（`### Task 域 — registerTaskTools（21 个）`）同样是手写的，R95 时
 *    名字全对、数字全错（「18 个」而实际 21 个），所以名字与计数两条都判。
 * ② `docs/atlas/05-interfaces/rest-api.md` —— 头部曾写「24 个 controller 文件，21 个路由前缀」，
 *    而实际 30 / 28；更糟的是 **7 个路由前缀整域未出现**（agent / agent-collab / auth-oidc / mutex-groups /
 *    sop / task-templates / webhooks-tasks）。本页是「地图」不是全量清单，但**整个域缺失**属于漂移。
 * ③ `docs/atlas/05-interfaces/sdks.md` —— lockstep 单版本线，「当前 X.Y.Z」必须等于
 *    `packages/mcp-server/package.json` 的 version。
 * ④ 审计动作 → 前端标签映射（`apps/admin-web/src/pages/audit/index.tsx` 的 `ACTION_LABEL_KEYS`）
 *    与 zh/en 词条：动作在代码里写了、前端没映射 → 界面直接显示原始码（`task.killExecution`）。
 *
 * 反向均不校验：文档可以记叙已废弃/未注册项，那是沿革不是漂移。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的假绿
 *
 *   · **前缀误配 + 散文命中**（判据①）：旧实现 `doc.includes(name)` 在**整篇**文档里找子串。
 *     两个后果：①删掉 `| get_task |` 那行后，`update_task` 行里的散文「冲突 409 → get_task 重取重试」
 *     还命中 → 假绿；②工具名是别名的**前缀**时也命中（表里只剩 `alpha_01` 时 `alpha_0` 仍算「已收录」）。
 *     现在只认**表格首格里的独立名字**（`| pause_task / resume_task |` 这类合并写法仍成立）或
 *     反引号包住的独立 token。
 *   · **注释算数**（判据④）：旧实现把 `ACTION_LABEL_KEYS` 区段当纯文本抽键，注释掉的
 *     `// 'task.killExecution': 'audit.action.task_kill'` 被算成**已映射**——于是删掉真映射、
 *     留一行注释就能让闸放行。源码侧同理（`// action: "sop.draft"` 被当成写入点，逼人往文档里
 *     记一个并不发生的动作）。现在源码与被抽区段都先剥注释。
 *   · **词条命中只看子串**（判据④）：旧实现 `zh.includes("'" + key + "'")` 会在注释/别处散文里
 *     命中；现在只认**行首键定义**（`^\s*'key':`）且先剥注释。
 *   · **扫描面下界不齐**：controller 文件数、`register*Tools` 函数数、解析出的 action 数都没有下界
 *     （只有前缀数与工具数有），且 `@Controller` 只有**空字符串**这一种形态被容忍、其它写法
 *     （对象 / 模板串）被**静默跳过**——那些 controller 从不进比对。现在两者都是**结构红**，
 *     并且一个文件里的多个 `@Controller` 全部计入（旧实现只看第一个）。
 *   · **崩溃 ≠ 红灯**：文档/源码读不到时旧实现直接 `readFileSync` 抛栈（`Error: ENOENT`），
 *     与「算出来不一致」混在同一个退出通道。现在结构错误单独成形、单独文案。
 *   · `--root` + 导出 `check()`：模块级 `process.cwd()` 收成参数，`import` 时不实扫、不 `process.exit`。
 *     （旧实现的四段判据是模块级 IIFE，`import` 就实扫真仓库。）
 *   · `--selftest`：跑真脚本的子进程，15 条用例逐条断言退出码 + 关键文本（含上述全部反证）。
 *
 * 用法：`node scripts/check-interface-maps.mjs [--selftest] [--root <dir>]`
 *   --selftest：在临时 fixture 树里跑真脚本（需要仓库根布局：packages/ + apps/ + docs/atlas）。
 *   --root    ：只给 selftest 用：把 fixture 树当仓库根（默认 process.cwd()）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const MCP_SRC_REL = "packages/mcp-server/src/tools.ts";
export const MCP_PKG_REL = "packages/mcp-server/package.json";
export const MCP_DOC_REL = "docs/atlas/05-interfaces/mcp-tools.md";
export const REST_SRC_REL = "apps/admin-api/src";
export const REST_DOC_REL = "docs/atlas/05-interfaces/rest-api.md";
export const SDK_DOC_REL = "docs/atlas/05-interfaces/sdks.md";
export const AUDIT_UI_REL = "apps/admin-web/src/pages/audit/index.tsx";
export const ZH_REL = "apps/admin-web/src/locales/zh.ts";
export const EN_REL = "apps/admin-web/src/locales/en.ts";

/**
 * 扫描面下界（2026-10-29 实测：56 个工具 / 9 个 register*Tools / 30 个前缀 / 33 个 controller
 * 文件 / 68 个审计动作 / 72 个标签键）。只增不减：这些数一旦塌下去，对应的
 * 「0 条 = 0 缺失」就是永真断言。
 */
export const MIN_TOOLS = 40;
export const MIN_REGISTER_FNS = 5;
export const MIN_PREFIXES = 20;
export const MIN_CONTROLLER_FILES = 20;
export const MIN_ACTIONS = 40;

export const TOOL_RE = /server\.(?:tool|registerTool)\(\s*["'`]([a-z0-9_]+)["'`]/g;
export const ACTION_RE = /action:\s*"([a-z0-9_]+\.[a-z0-9_.]+)"/g;

const relOf = (root, abs) => relative(root, abs).split(sep).join("/");

/** 剥掉 TS/JS 注释（`//` 与块注释），保留换行。字符串**不透明**（避免误剥 URL 里的 `//`）。 */
export function stripComments(src) {
  let out = "";
  let state = "code";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : "";
    if (state === "code") {
      if (c === "/" && d === "/") {
        state = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "/" && d === "*") {
        state = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === '"') state = "dquote";
      else if (c === "'") state = "squote";
      else if (c === "`") state = "template";
      out += c;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      } else {
        out += c === "\t" ? "\t" : " ";
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") {
        state = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (c === "\\") {
      out += c + d;
      i += 2;
      continue;
    }
    if ((state === "dquote" && c === '"') || (state === "squote" && c === "'") || (state === "template" && c === "`")) {
      state = "code";
    } else if ((state === "squote" || state === "dquote") && c === "\n") {
      state = "code"; // 未闭合引号容错，别把余下整文件吞成字符串
    }
    out += c;
    i += 1;
  }
  return out;
}

function readText(abs) {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/** 目录遍历；读不到目录时把结构错误推进 `structure`（而不是抛栈）。 */
function walkTs(root, dir, structure, filter) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    structure.push(`读不到目录 ${relOf(root, dir)}（${error.code ?? error.message}）—— 扫描面不完整，判据不可信。`);
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(root, p, structure, filter));
    else if (filter(e.name)) out.push(p);
  }
  return out;
}

/**
 * 判据本体。返回 `{ structure, problems, counts }`：
 *   · structure = 结构性（事实源读不到 / 扫描面塌了 / 写法解析不了）——「判据本身不可信」；
 *   · problems  = 地图漂移（{ section, head, items }，section 决定 CLI 的文案与修法行）。
 */
export function check({ root = process.cwd() } = {}) {
  const structure = [];
  const problems = [];
  const counts = { tools: 0, registerFns: 0, prefixes: 0, controllerFiles: 0, actions: 0, labelKeys: 0, version: null };

  // ── ① MCP 工具地图（名字 + 分域计数）────────────────────────────────────
  const toolSrc = readText(join(root, MCP_SRC_REL));
  const toolDoc = readText(join(root, MCP_DOC_REL));
  if (toolSrc === null) {
    structure.push(`读不到 ${MCP_SRC_REL} —— 工具注册面不存在了（不是「工具变少了」）。`);
  } else if (toolDoc === null) {
    structure.push(`读不到 ${MCP_DOC_REL} —— 地图被删/改名，判据已经瞎了。`);
  } else {
    const names = [...toolSrc.matchAll(TOOL_RE)].map((m) => m[1]);
    counts.tools = names.length;
    if (names.length < MIN_TOOLS) {
      structure.push(`MCP：只解析出 ${names.length} 个工具（下界 ${MIN_TOOLS}）—— 扫描器失效了。`);
    } else {
      // 命中面 = 表格**首格**里的独立名字（`| pause_task / resume_task |` 成立），
      // 或反引号包住的独立 token。散文里的顺口一提、别名的前缀都不算。
      const firstCells = new Set();
      const backticked = new Set();
      for (const line of toolDoc.split("\n")) {
        if (line.startsWith("|")) {
          const cell = line.split("|")[1] ?? "";
          for (const tok of cell.split(/[^A-Za-z0-9_]+/)) if (tok) firstCells.add(tok);
        }
        for (const m of line.matchAll(/`([a-z0-9_]+)`/g)) backticked.add(m[1]);
      }
      const missing = names.filter((n) => !firstCells.has(n) && !backticked.has(n));
      if (missing.length > 0) {
        problems.push({
          section: "mcp-names",
          head: `MCP 工具地图漂移：源码注册 ${names.length} 个，文档缺 ${missing.length} 个`,
          items: missing.map((n) => "· " + n),
        });
      }

      // 分域计数：`### <域> 域 — register<X>Tools（N 个…）` 的 N 必须等于该函数实际注册数。
      const fnPositions = [...toolSrc.matchAll(/export function (register\w+Tools)\(/g)].map((m) => ({
        name: m[1],
        idx: m.index,
      }));
      counts.registerFns = fnPositions.length;
      if (fnPositions.length < MIN_REGISTER_FNS) {
        structure.push(`MCP：只解析出 ${fnPositions.length} 个 register*Tools 函数（下界 ${MIN_REGISTER_FNS}）—— 解析器失效。`);
      } else {
        const actualByFn = new Map();
        for (let i = 0; i < fnPositions.length; i += 1) {
          const start = fnPositions[i].idx;
          const end = i + 1 < fnPositions.length ? fnPositions[i + 1].idx : toolSrc.length;
          const seg = toolSrc.slice(start, end);
          actualByFn.set(fnPositions[i].name, [...seg.matchAll(TOOL_RE)].length);
        }
        const docCounts = new Map();
        for (const m of toolDoc.matchAll(/^###[^\n]*—\s*(register\w+Tools)（(\d+) 个[^）]*）/gm)) {
          docCounts.set(m[1], Number(m[2]));
        }
        const countProblems = [];
        for (const [fn, actual] of actualByFn) {
          const documented = docCounts.get(fn);
          if (documented === undefined) {
            countProblems.push(`${fn}：文档没有带计数的分节标题（实际 ${actual} 个）`);
          } else if (documented !== actual) {
            countProblems.push(`${fn}：文档写 ${documented} 个，实际 ${actual} 个`);
          }
        }
        if (countProblems.length > 0) {
          problems.push({
            section: "mcp-counts",
            head: "MCP 工具地图**分域计数**漂移：",
            items: countProblems.map((p) => "· " + p),
          });
        }
      }
    }
  }

  // ── ② REST 路由前缀 ────────────────────────────────────────────────────
  const restSrcDir = join(root, REST_SRC_REL);
  if (!existsSync(restSrcDir)) {
    structure.push(`读不到目录 ${REST_SRC_REL} —— 路径变了，扫描面为 0（不是「路由都删了」）。`);
  } else {
    const controllerFiles = walkTs(
      root,
      restSrcDir,
      structure,
      (name) => /\.controller\.ts$/.test(name) && !name.endsWith(".spec.ts"),
    );
    counts.controllerFiles = controllerFiles.length;
    if (controllerFiles.length < MIN_CONTROLLER_FILES) {
      structure.push(
        `REST：只扫到 ${controllerFiles.length} 个 .controller.ts（下界 ${MIN_CONTROLLER_FILES}）—— 目录改名或全被排除了。`,
      );
    } else {
      const prefixes = new Set();
      for (const f of controllerFiles) {
        const src = readText(f);
        const rel = relOf(root, f);
        if (src === null) {
          structure.push(`读不到 ${rel} —— 扫描面不完整，前缀清单不可信。`);
          continue;
        }
        // 一个文件里的**所有** @Controller 都算（旧实现只看第一个）。
        const code = stripComments(src);
        for (const m of code.matchAll(/@Controller\(\s*(?:"([^"]*)"|'([^']*)'|)\s*\)/g)) {
          const p = (m[1] ?? m[2] ?? "").trim();
          if (p) prefixes.add(p);
        }
        // 有前缀但形态解析不了（对象 / 模板串 / 常量引用）→ 结构红，别静默跳过。
        if (/@Controller\(\s*[`{]/.test(code)) {
          structure.push(
            `${rel}：\`@Controller(\` 的参数不是字符串字面量（对象/模板串）—— 本判据解析不了它的前缀，别静默跳过。`,
          );
        }
      }
      counts.prefixes = prefixes.size;
      if (prefixes.size < MIN_PREFIXES) {
        structure.push(`REST：只解析出 ${prefixes.size} 个路由前缀（下界 ${MIN_PREFIXES}）—— 扫描器失效了。`);
      }
      const restDoc = readText(join(root, REST_DOC_REL));
      if (restDoc === null) {
        structure.push(`读不到 ${REST_DOC_REL} —— 地图被删/改名，判据已经瞎了。`);
      } else if (prefixes.size >= MIN_PREFIXES) {
        // 必须作为**反引号包住的路由路径**出现（`/sop` 或 `/sop/...`），而不是随便在正文里提一句。
        // 正则转义：把前缀里的元字符字面化（历史版本这里写坏过，含`.`的前缀会永久假绿）。
        const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const probe = escapeRe("a.b(c)");
        if (probe !== "a\\.b\\(c\\)") {
          structure.push(
            "escapeRe 自检失败：期望 a\\.b\\(c\\)，实际 " +
              JSON.stringify(probe) +
              " —— 判据对含正则元字符的路由前缀会永久假绿。",
          );
        } else {
          const absent = [...prefixes].filter((p) => !new RegExp("`/" + escapeRe(p) + "(`|/)").test(restDoc)).sort();
          if (absent.length > 0) {
            problems.push({
              section: "rest",
              head: `REST 地图漂移：源码有 ${prefixes.size} 个路由前缀，文档完全没出现 ${absent.length} 个`,
              items: absent.map((p) => "· /" + p),
            });
          }
        }
      }
    }
  }

  // ── ③ SDK lockstep 版本声明 ────────────────────────────────────────────
  const sdkDoc = readText(join(root, SDK_DOC_REL));
  const mcpPkgText = readText(join(root, MCP_PKG_REL));
  if (sdkDoc === null) {
    structure.push(`读不到 ${SDK_DOC_REL} —— 版本声明无从核对。`);
  } else if (mcpPkgText === null) {
    structure.push(`读不到 ${MCP_PKG_REL} —— 版本事实源不存在了。`);
  } else {
    let mcpVersion = null;
    try {
      mcpVersion = JSON.parse(mcpPkgText).version ?? null;
    } catch (error) {
      structure.push(`${MCP_PKG_REL} 不是合法 JSON（${error.message}）—— 版本事实源不可解析。`);
    }
    if (mcpVersion !== null && typeof mcpVersion !== "string") {
      structure.push(`${MCP_PKG_REL} 的 version 不是字符串 —— 事实源格式变了。`);
      mcpVersion = null;
    }
    if (mcpVersion !== null) {
      counts.version = mcpVersion;
      const claimed = /当前\s*\**\s*(\d+\.\d+\.\d+)/.exec(sdkDoc);
      if (!claimed) {
        structure.push(`${SDK_DOC_REL} 里找不到「当前 X.Y.Z」版本声明 —— 判据失配（不是声明消失了就是格式变了）。`);
      } else if (claimed[1] !== mcpVersion) {
        problems.push({
          section: "sdk-version",
          head: `sdks.md 版本声明与实际不符：文档写 ${claimed[1]}，mcp-server 实际 ${mcpVersion}（lockstep 单版本线）。`,
          items: [],
          hint: "修法：把 sdks.md 的「当前 X.Y.Z」改成实际版本；不要改守卫。",
        });
      }
    }
  }

  // ── ④ 审计动作 → 前端标签与双语词条 ────────────────────────────────────
  const uiSrc = readText(join(root, AUDIT_UI_REL));
  const zhSrc = readText(join(root, ZH_REL));
  const enSrc = readText(join(root, EN_REL));
  if (uiSrc === null) {
    structure.push(`读不到 ${AUDIT_UI_REL} —— 标签映射表不存在了。`);
  } else if (zhSrc === null || enSrc === null) {
    structure.push(`读不到 ${zhSrc === null ? ZH_REL : EN_REL} —— 词条面不完整，判据不可信。`);
  } else if (existsSync(restSrcDir)) {
    const srcFiles = walkTs(root, restSrcDir, structure, (name) => name.endsWith(".ts") && !name.endsWith(".spec.ts"));
    const actions = new Set();
    for (const f of srcFiles) {
      const src = readText(f);
      const rel = relOf(root, f);
      if (src === null) {
        structure.push(`读不到 ${rel} —— 扫描面不完整，动作清单不可信。`);
        continue;
      }
      // 先剥注释：注释里的 `action: "x.y"` 不是「谁在写审计」。
      for (const m of stripComments(src).matchAll(ACTION_RE)) actions.add(m[1]);
    }
    counts.actions = actions.size;
    if (actions.size < MIN_ACTIONS) {
      structure.push(
        `只解析出 ${actions.size} 个审计动作（下界 ${MIN_ACTIONS}）—— 扫描器失效了，不是动作变少了。`,
      );
    }

    const block = /const ACTION_LABEL_KEYS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(stripComments(uiSrc));
    if (!block) {
      structure.push("找不到 ACTION_LABEL_KEYS 字面量 —— 判据失配（映射表的写法变了）。");
    } else if (actions.size >= MIN_ACTIONS) {
      const mapped = new Set([...block[1].matchAll(/'([a-z0-9_.]+)'\s*:/g)].map((m) => m[1]));
      const labelKeys = new Set([...block[1].matchAll(/:\s*'(audit\.action\.[a-z0-9_]+)'/g)].map((m) => m[1]));
      counts.labelKeys = labelKeys.size;

      const unmapped = [...actions].filter((a) => !mapped.has(a)).sort();
      if (unmapped.length > 0) {
        problems.push({
          section: "audit-unmapped",
          head: `${unmapped.length} 个审计动作在前端没有标签映射（会显示原始码）：`,
          items: unmapped.map((a) => "· " + a),
        });
      }

      // 词条只认**行首键定义**（`'key': …`），且先剥注释——子串命中会让注释里的
      // `// 'audit.action.x' 待补` 也算「有词条」。
      const localeKeys = (text) => {
        const keys = new Set();
        for (const m of stripComments(text).matchAll(/^\s*'([^']+)'\s*:/gm)) keys.add(m[1]);
        return keys;
      };
      const zhKeys = localeKeys(zhSrc);
      const enKeys = localeKeys(enSrc);
      const missingI18n = [...labelKeys].flatMap((k) => {
        const out = [];
        if (!zhKeys.has(k)) out.push(`${k} (zh)`);
        if (!enKeys.has(k)) out.push(`${k} (en)`);
        return out;
      });
      if (missingI18n.length > 0) {
        problems.push({
          section: "audit-i18n",
          head: `${missingI18n.length} 个标签键缺少词条：`,
          items: missingI18n.map((k) => "· " + k),
        });
      }
    }
  }

  return { structure, problems, counts };
}

// ── 自检（T4：全部跑真脚本子进程）─────────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

// fixture 事实源：5 个域 × 8 个工具 = 40；20 个路由前缀；40 个审计动作（8 域 × 5）。
const FN_DOMAINS = [
  ["alpha", "registerAlphaTools"],
  ["beta", "registerBetaTools"],
  ["gamma", "registerGammaTools"],
  ["delta", "registerDeltaTools"],
  ["epsilon", "registerEpsilonTools"],
];
const PER_FN = 8;
const TOOLS = FN_DOMAINS.flatMap(([d]) => Array.from({ length: PER_FN }, (_, i) => `${d}_${i}`));
const PREFIXES = [...Array.from({ length: 19 }, (_, i) => `p${i}`), "a.b"];
const ACTION_DOMAINS = ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"];
const ACTIONS = ACTION_DOMAINS.flatMap((d) => Array.from({ length: 5 }, (_, i) => `${d}.a${i}`));
const VERSION = "1.4.0";

const toolsFile = () =>
  FN_DOMAINS.map(
    ([d, fn]) =>
      `export function ${fn}(server) {\n` +
      Array.from({ length: PER_FN }, (_, i) => `  server.tool("${d}_${i}", {}, async () => ({}));`).join("\n") +
      "\n}\n",
  ).join("\n");

const mcpDoc = ({ omit = [], counts: countOverride = {}, prose = [] } = {}) =>
  [
    `# MCP 工具地图（${TOOLS.length} 个）`,
    "",
    "> 工具名由 `scripts/check-interface-maps.mjs` 守护。",
    "",
    ...prose,
    ...FN_DOMAINS.flatMap(([d, fn]) => {
      const n = countOverride[fn] ?? PER_FN;
      return [
        `### ${d} 域 — ${fn}（${n} 个）`,
        "",
        "| 工具 | 参数概要 | 语义 |",
        "|---|---|---|",
        ...Array.from({ length: PER_FN }, (_, i) => `| ${d}_${i} | — | 说明 ${d}_${i} |`),
        "",
      ];
    }),
  ]
    .join("\n")
    .split("\n")
    .filter((line) => !omit.some((o) => line.startsWith(`| ${o} |`)))
    .join("\n");

const controllerFile = (prefix) =>
  ["import { Controller, Get } from \"@nestjs/common\";", "", `@Controller("${prefix}")`, "export class Fixture {} ", ""].join("\n");

const restDoc = ({ omit = [] } = {}) =>
  [
    "# REST 接口地图",
    "",
    `> **${PREFIXES.length}** 个 controller 文件，**${PREFIXES.length}** 个路由前缀`,
    "",
    ...PREFIXES.filter((p) => !omit.includes(p)).flatMap((p) => [
      `## 域 ${p}`,
      "",
      "| 方法 | 路径 | 说明 |",
      "|---|---|---|",
      `| GET | \`/${p}/items\` | 列表 |`,
      "",
    ]),
  ].join("\n");

const sdkDoc = ({ version = VERSION, claim = true } = {}) =>
  [
    "# SDK 指南",
    "",
    claim
      ? `版本走 lockstep 单版本线（当前 **${version}**，与 mcp-server 同步）。`
      : "版本走 lockstep 单版本线（与 mcp-server 同步）。",
    "",
  ].join("\n");

const auditWriter = () =>
  "export const auditPoints = [\n" + ACTIONS.map((a) => `  { action: "${a}", resource: "thing" },`).join("\n") + "\n];\n";

const auditUi = ({ omit = [], comments = [] } = {}) =>
  [
    "const ACTION_LABEL_KEYS: Record<string, string> = {",
    ...comments,
    ...ACTIONS.filter((a) => !omit.includes(a)).map((a) => `  '${a}': 'audit.action.${a.replace(".", "_")}',`),
    "};",
    "",
  ].join("\n");

const localeFile = (lang, { omit = [], comments = [] } = {}) =>
  [
    `// ${lang} fixture`,
    "export default {",
    ...comments,
    ...ACTIONS.filter((a) => !omit.includes(a)).map((a) => `  'audit.action.${a.replace(".", "_")}': '${lang} 文案',`),
    "};",
    "",
  ].join("\n");

function mapsTree({
  tools = toolsFile(),
  toolDoc = mcpDoc(),
  rest = restDoc(),
  controllers = PREFIXES,
  sdk = sdkDoc(),
  ui = auditUi(),
  zh = localeFile("zh"),
  en = localeFile("en"),
  extra = {},
  drop = [],
  noRest = false,
} = {}) {
  const files = {
    [MCP_SRC_REL]: tools,
    [MCP_PKG_REL]: { name: "autocodeflow-mcp-server", version: VERSION },
    [MCP_DOC_REL]: toolDoc,
    [REST_DOC_REL]: rest,
    [SDK_DOC_REL]: sdk,
    [AUDIT_UI_REL]: ui,
    [ZH_REL]: zh,
    [EN_REL]: en,
  };
  if (!noRest) {
    for (const p of controllers) files[`${REST_SRC_REL}/modules/x-${p}/${p}.controller.ts`] = controllerFile(p);
    files[`${REST_SRC_REL}/modules/audit/audit.writer.ts`] = auditWriter();
  }
  Object.assign(files, extra);
  for (const d of drop) delete files[d];
  return files;
}

/**
 * 自检：15 条用例，全部 `spawn` 真脚本（`--root` 指向 fixture 树）。
 *
 * 旧版**没有 selftest**（四段判据是模块级 IIFE，`import` 就实扫真仓库），所以下面
 * 标【反证】的四处假绿都没有被任何东西钉住。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "interface-maps-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            ...expect,
            withinMs: 1000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocess("① 干净树：40 个工具 / 5 个分域计数 / 20 个前缀 / 版本 / 40 个动作 → 绿", mapsTree(), {
    code: 0,
    contains: [
      "MCP 工具地图一致：40 个工具全部在文档中出现，5 个分域计数相符",
      "REST 地图一致：20 个路由前缀全部在文档中出现（20 个 controller 文件）",
      `SDK 版本声明一致：sdks.md 与 mcp-server 均为 ${VERSION}`,
      "审计动作标签一致：40 个动作全部有标签，40 个键在 zh/en 都有词条",
    ],
    absent: ["结构错误", "漂移"],
  });

  // ② 修掉的假绿（散文命中）：表格行删了，但别的行的散文里还写着这个名字
  subprocess(
    "② 【反证·散文命中】工具行删掉、散文里还提了一嘴 → 仍红（旧实现 doc.includes 命中）",
    mapsTree({
      toolDoc: mcpDoc({ omit: ["beta_3"] }).replace("| beta_0 | — | 说明 beta_0 |", "| beta_0 | — | 兼容 beta_3 的历史写法 |"),
    }),
    { code: 1, contains: ["MCP 工具地图漂移：源码注册 40 个，文档缺 1 个", "· beta_3"], absent: ["地图一致"] },
  );

  // ③ 修掉的假绿（前缀误配）：表里只剩更长名字（alpha_01），alpha_0 仍算「已收录」是错的
  subprocess(
    "③ 【反证·前缀误配】工具名只是另一个工具名的前缀 → 不算已收录",
    mapsTree({ toolDoc: mcpDoc().replace("| alpha_0 | — | 说明 alpha_0 |", "| alpha_01 | — | 说明 alpha_01 |") }),
    { code: 1, contains: ["文档缺 1 个", "· alpha_0"], absent: ["地图一致"] },
  );

  subprocess(
    "④ 分域计数不符（文档写 7 / 实际 8）→ 红",
    mapsTree({ toolDoc: mcpDoc({ counts: { registerBetaTools: 7 } }) }),
    { code: 1, contains: ["**分域计数**漂移", "registerBetaTools：文档写 7 个，实际 8 个"], absent: ["地图一致"] },
  );

  subprocess(
    "⑤ 分域标题的计数格式消失（`（8 个）` 被删）→ 红",
    mapsTree({ toolDoc: mcpDoc().replace("— registerGammaTools（8 个）", "— registerGammaTools") }),
    { code: 1, contains: ["registerGammaTools：文档没有带计数的分节标题"], absent: ["地图一致"] },
  );

  subprocess(
    "⑥ REST 整个路由前缀缺失（文档删掉 /p2 整节）→ 红",
    mapsTree({ rest: restDoc({ omit: ["p2"] }) }),
    { code: 1, contains: ["文档完全没出现 1 个", "· /p2"], absent: ["地图一致"] },
  );

  // ⑦ 判据自身的判据：转义失效时 `a.b` 会匹配到 `axb`（含元字符的前缀永久假绿）
  subprocess(
    "⑦ 【反证·正则转义】前缀 a.b 的文档只剩 `/axb` → 红（未转义的正则才会命中）",
    mapsTree({ rest: restDoc().replace("`/a.b/items`", "`/axb/items`") }),
    { code: 1, contains: ["文档完全没出现 1 个", "· /a.b"], absent: ["地图一致"] },
  );

  subprocess(
    "⑧ SDK 版本声明与实际不符（文档 1.3.0 / 实际 1.4.0）→ 红",
    mapsTree({ sdk: sdkDoc({ version: "1.3.0" }) }),
    { code: 1, contains: ["sdks.md 版本声明与实际不符：文档写 1.3.0，mcp-server 实际 1.4.0"], absent: ["版本声明一致"] },
  );

  subprocess(
    "⑨ 【反证·注释算数】标签映射被注释掉 → 仍算「没有标签映射」",
    mapsTree({
      ui: auditUi({ omit: ["d1.a2"], comments: ["  // 'd1.a2': 'audit.action.d1_a2', 待补"] }),
    }),
    { code: 1, contains: ["1 个审计动作在前端没有标签映射", "· d1.a2"], absent: ["审计动作标签一致"] },
  );

  // ⑩ 反向（防假红）：源码**注释**里的 action 不是写入点，不该被要求进前端映射
  subprocess(
    "⑩ 【反证·注释算数】源码注释里的 action 不算写入点 → 绿",
    mapsTree({
      extra: {
        [`${REST_SRC_REL}/modules/legacy/legacy.ts`]:
          '// 旧写法：svc.log({ action: "d9.a9" })\n/* action: "d9.a8" —— 已下线 */\nexport const legacy = 1;\n',
      },
    }),
    { code: 0, contains: ["审计动作标签一致：40 个动作"], absent: ["d9.a9", "d9.a8", "漂移"] },
  );

  subprocess(
    "⑪ 词条缺失（en 少一个键）→ 红",
    mapsTree({ en: localeFile("en", { omit: ["d3.a1"] }) }),
    { code: 1, contains: ["1 个标签键缺少词条", "audit.action.d3_a1 (en)"], absent: ["审计动作标签一致"] },
  );

  subprocess(
    "⑫ 词条只在注释里出现 → 不算有词条（旧实现 zh.includes 会命中）",
    mapsTree({ zh: localeFile("zh", { omit: ["d4.a0"], comments: ["  // 'audit.action.d4_a0': '待补',"] }) }),
    { code: 1, contains: ["audit.action.d4_a0 (zh)"], absent: ["审计动作标签一致"] },
  );

  subprocess(
    "⑬ 【反证·扫描面】controller 文件只剩 3 个 → 结构红",
    mapsTree({ controllers: PREFIXES.slice(0, 3) }),
    { code: 1, contains: ["结构错误", `只扫到 3 个 .controller.ts（下界 ${MIN_CONTROLLER_FILES}）`], absent: ["地图一致"] },
  );

  subprocess(
    "⑭ 【反证·解析失败】tools.ts 一个 server.tool( 都解析不到 → 结构红",
    mapsTree({ tools: "export function registerAlphaTools(server) {\n  server.register(\"nope\");\n}\n" }),
    { code: 1, contains: ["结构错误", `只解析出 0 个工具（下界 ${MIN_TOOLS}）`], absent: ["地图一致"] },
  );

  subprocess(
    "⑮ 【反证·解析失败】@Controller 的参数不是字符串字面量 → 结构红（不再静默跳过）",
    mapsTree({
      extra: {
        [`${REST_SRC_REL}/modules/obj/obj.controller.ts`]: '@Controller({ path: "obj" })\nexport class Obj {}\n',
      },
    }),
    { code: 1, contains: ["结构错误", "不是字符串字面量"], absent: ["地图一致"] },
  );

  subprocess("⑯ 事实源缺失（mcp-tools.md 被删）→ 结构红且点名路径", mapsTree({ drop: [MCP_DOC_REL] }), {
    code: 1,
    contains: ["结构错误", `读不到 ${MCP_DOC_REL}`],
    absent: ["地图一致", "Error:", "\n    at "],
  });

  subprocess("⑰ 事实源缺失（admin-api/src 整个不在）→ 结构红且不崩栈", mapsTree({ noRest: true }), {
    code: 1,
    contains: ["结构错误", `读不到目录 ${REST_SRC_REL}`],
    absent: ["地图一致", "Error:", "\n    at "],
  });

  const failed = reportCases(cases, { title: "check-interface-maps selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const HINTS = {
  "mcp-names": "  修法：补进 docs/atlas/05-interfaces/mcp-tools.md 的对应域表格，并同步各域计数与文首总数。",
  "mcp-counts": "  修法：改 docs/atlas/05-interfaces/mcp-tools.md 里对应小标题的计数。",
  rest: "  修法：在 docs/atlas/05-interfaces/rest-api.md 补该域一节（至少列出主要路由），并同步头部计数。",
  "audit-unmapped": "  修法：补 ACTION_LABEL_KEYS 与 zh/en 词条；不要改守卫。",
  "audit-i18n": "  修法：补 ACTION_LABEL_KEYS 与 zh/en 词条；不要改守卫。",
};

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    const { structure, problems, counts } = check({ root });

    if (structure.length > 0) {
      console.error("");
      console.error("✖ 接口地图守卫结构错误（判据本身不可信）：");
      for (const e of structure) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    if (problems.length > 0) {
      console.error("");
      for (const p of problems) {
        console.error("✖ " + p.head);
        for (const item of p.items) console.error("  " + item);
        if (p.hint ?? HINTS[p.section]) console.error(p.hint ?? HINTS[p.section]);
      }
      console.error("");
      process.exit(1);
    }

    console.log(
      "✔ MCP 工具地图一致：" + counts.tools + " 个工具全部在文档中出现，" + counts.registerFns + " 个分域计数相符。",
    );
    console.log(
      "✔ REST 地图一致：" + counts.prefixes + " 个路由前缀全部在文档中出现（" + counts.controllerFiles + " 个 controller 文件）。",
    );
    console.log("✔ SDK 版本声明一致：sdks.md 与 mcp-server 均为 " + counts.version + "。");
    console.log(
      "✔ 审计动作标签一致：" + counts.actions + " 个动作全部有标签，" + counts.labelKeys + " 个键在 zh/en 都有词条。",
    );
  }
}
