#!/usr/bin/env node
/**
 * 跨面脱敏一致性守卫：`sanitize` 的**规则集**只允许有一份，且各入口输出必须逐字相同。
 *
 * ## 为什么需要这个守卫（本次缺陷本身就是这么长出来的）
 * 曾经有四份「差不多」的实现：`ai.service.ts` 的 `sanitizeLogs`、
 * `notification.service.ts` 的 `buildContentDigest`（**内联复制**）、
 * `notification/sanitize-notification-text.util.ts`、agent 的 `sanitizeString`。
 * 前三份是同一套四条规则，agent 那份多一条「小写/混写凭据赋值」。于是：
 *
 *     "apiKey=sk-live-abc"   → 通知正文原样外发（明文）
 *     "AUTOFLOW_TOKEN=abc123"   → [REDACTED]（全大写能拦）
 *
 * 没有任何测试**同时**看两个面，所以这个漂移活了很久。本脚本就是那个「同时看」：
 *
 * ## 判据（四条，任何一条不满足即红）
 *   ① **夹具集非空且覆盖齐全**：小写/大写凭据、Bearer、32+ hex、40+ b64、
 *      已知前缀密钥、正常英文/中文文案、正常参数（`retries=3`）。
 *   ② **逐入口输出逐字相同**：共享实现、通知入口、agent 入口对同一输入必须给出
 *      同一个字符串（差异只允许出现在「截断上限」这类展示策略上，而夹具都在
 *      最短上限之内）。
 *   ③ **绝对强度**：夹具里声明的秘密串不得出现在任何入口的输出里，声明必须保留
 *      的标记（`[REDACTED]` 等）必须出现，正常文案必须逐字不变。
 *      ——只做 ② 是不够的：若有人把**共享实现**一起改弱，三个入口照样「一致」。
 *   ④ **服务面没有第二份规则**：`ai.service.sanitizeLogs` /
 *      `notification.service.buildContentDigest` / `sop.service.sanitizeUntrusted`
 *      必须是薄转发（import 共享实现 + 调用它），函数体内不得再出现规则正则；
 *      全仓（除共享实现外）也不得出现这五条规则的**字面量**。
 *
 * **结构性红**（判据瞎了要报红，而不是当绿）：入口文件/导出取不到、函数体解析
 * 不到、夹具集为空、入口返回的不是字符串——一律红。
 *
 * 零依赖：只用 node 内置模块；被检查的 TS 模块由 Node 自带类型擦除直接 import
 * （`sanitize-secrets.util.ts` / 两个薄封装都是无装饰器的纯函数模块）。
 *
 * 用法：
 *   node scripts/check-sanitize-parity.mjs            # 真仓库检查
 *   node scripts/check-sanitize-parity.mjs --selftest  # 守卫自检（含「改弱一侧 ⇒ 红」反证）
 *
 * ## 仓库根从哪来（`--root`）
 *
 * 所有被判文件（共享实现 / 通知入口 / agent 入口 / 三个服务面入口 / 全仓字面量扫描）
 * 都挂在 `apps/admin-api/src` 下，所以「根」是本守卫唯一的输入口径：
 *
 *   · 不传 `--root` ⇒ 根 = 本脚本所在树的上一级（`<repo>/scripts/` → `<repo>`），
 *     **与引入 `--root` 之前逐字节等价**（不读 `process.cwd()`：从子目录误跑不会
 *     把相对路径算到别的树上）；
 *   · `--root <dir>` / `--root=<dir>` 两种形态都认 ⇒ 根换成 `<dir>`（给 selftest
 *     夹具用：在临时目录造一个假仓库，绝不碰真仓库）；
 *   · `--root` 缺值 / 空值 / 指向不存在的目录 ⇒ **exit 2**（用法错误）。
 *     **不许静默回落到真仓库**——「以为在跑夹具、实际跑的是真仓库」是最坏的假绿；
 *   · `--selftest` 与 `--root` **互斥** ⇒ exit 2：自检的对照组**就是真仓库**
 *     （①正例控制组要证明「真仓库绿」，反证要改真源码的变异副本），把根换成夹具
 *     只会让对照组失去意义。互斥比「静默忽略 `--root`」诚实。
 *
 * 写盘：只有自检的**变异副本**会写盘，目标固定是 `os.tmpdir()`（不是仓库内），
 * 所以 `--root` 不需要写盘重定向。
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 仓库里的相对 import 不带扩展名（`from "../../common/utils/sanitize-secrets.util"`），
 * 那是 TypeScript 的写法，Node 的原生 ESM 解析器不认。这里注册一个**只补 `.ts`
 * 扩展名**的解析钩子，让守卫 import 的是**真文件**（而不是复制一份再改路径）——
 * 复制品会让「入口实际调用谁」这件事失去意义。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw e;
    }
  },
});

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** 缺省根按**脚本位置**锚定，不用 `process.cwd()`（否则从子目录跑会算到别的树上）。 */
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "..");

/** 用法错误退出码（与「判据红 = 1」分开，口径同 `check-mcp-error-hints.mjs`）。 */
const EXIT_USAGE = 2;

/**
 * 解析仓库根。**只认** `--root`（`--root <dir>` / `--root=<dir>` 两种形态）。
 *
 * 为什么在**模块加载期**解析、而不是在 `main()` 里：本脚本被判的路径（`SRC` 及
 * 其下所有入口）是模块级常量，判据函数直接引用它们。把根提前定死，`--root` 就
 * 只需要穿过这一处，判据逻辑一行不动。
 *
 * 三条用法错误的判据（缺值 / 空值 / 目录不存在 / 与 `--selftest` 混用）都在这里
 * fail-closed 成 exit 2，**绝不静默回落到真仓库**。
 */
function parseRootArg(argv = process.argv.slice(2)) {
  let root = DEFAULT_ROOT;
  let explicit = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root" || a.startsWith("--root=")) {
      const v = a === "--root" ? argv[++i] : a.slice("--root=".length);
      if (!v || v.startsWith("--")) {
        throw new Error("`--root` 需要一个目录参数（`--root <dir>` 或 `--root=<dir>`）");
      }
      root = resolve(v);
      explicit = true;
    }
  }
  if (explicit) {
    if (argv.includes("--selftest")) {
      throw new Error(
        "`--selftest` 与 `--root` 互斥：自检的正例控制组与反证都钉在**真仓库**上，换根会让对照组失去意义",
      );
    }
    if (!existsSync(root)) {
      throw new Error(`\`--root\` 指向的目录不存在：${root}`);
    }
    if (!existsSync(join(root, "apps", "admin-api", "src"))) {
      // 结构红（不是判据）：根指错树时下面每个入口都会变成「取不到 ⇒ 红」，
      // 但那 8 条红会让人以为是「脱敏实现坏了」。这里一次说清是根的问题。
      throw new Error(
        `\`--root\` 指向的树不像本仓（缺 apps/admin-api/src）：${root}——指错了树？`,
      );
    }
  }
  return root;
}

const ROOT = (() => {
  try {
    return parseRootArg();
  } catch (err) {
    console.error(`✘ 用法错误：${err.message}`);
    process.exit(EXIT_USAGE);
  }
})();
const SRC = join(ROOT, "apps", "admin-api", "src");

const SHARED_FILE = join(SRC, "common", "utils", "sanitize-secrets.util.ts");
const NOTIF_UTIL_FILE = join(
  SRC,
  "modules",
  "notification",
  "sanitize-notification-text.util.ts",
);
const AGENT_UTIL_FILE = join(
  SRC,
  "modules",
  "agent",
  "tools",
  "agent-sanitize.util.ts",
);

/** 运行时可 import 的入口（装饰器-free 的薄封装）。 */
const RUNTIME_ENTRIES = [
  { id: "shared/common.utils.sanitizeSecrets", file: SHARED_FILE, exportName: "sanitizeSecrets" },
  {
    id: "notification/sanitizeNotificationText",
    file: NOTIF_UTIL_FILE,
    exportName: "sanitizeNotificationText",
  },
  {
    id: "agent/tools.sanitizeString",
    file: AGENT_UTIL_FILE,
    exportName: "sanitizeString",
  },
];

/**
 * 服务面入口：方法是 private 且文件带 Nest 装饰器（Node 的类型擦除不处理装饰器），
 * 因此不做运行时比对，改用**结构判据**：必须 import 共享实现并调用它，
 * 且函数体内不得残留规则正则（历史漂移的形态就是「把正则链抄进方法体」）。
 */
const DELEGATED_ENTRIES = [
  {
    id: "ai/ai.service.sanitizeLogs",
    file: join(SRC, "modules", "ai", "ai.service.ts"),
    fn: "sanitizeLogs",
    importFrom: "common/utils/sanitize-secrets.util",
    mustCall: "sanitizeSecrets(",
  },
  {
    id: "notification/notification.service.buildContentDigest",
    file: join(SRC, "modules", "notification", "notification.service.ts"),
    fn: "buildContentDigest",
    importFrom: "sanitize-notification-text.util",
    mustCall: "sanitizeNotificationText(",
  },
  {
    id: "sop/sop.service.sanitizeUntrusted",
    file: join(SRC, "modules", "sop", "sop.service.ts"),
    fn: "sanitizeUntrusted",
    importFrom: "common/utils/sanitize-secrets.util",
    mustCall: "sanitizeSecrets(",
  },
];

/**
 * 规则正则的**字面量**（逐字来自共享实现）。全仓出现第二份即红——
 * 只认字面量而不是「长得像」的正则，避免把参数校验（如 traceparent 的
 * `^[0-9a-fA-F]{32}$`）误判成脱敏规则。
 */
const RULE_LITERALS = [
  "([A-Z_]{3,}\\s*=\\s*)[^\\s\\n]+",
  "(Bearer\\s+)[A-Za-z0-9\\-._~+/]+=*",
  "[0-9a-fA-F]{32,}",
  "[A-Za-z0-9+/]{40,}={0,2}",
  "sk-[A-Za-z0-9_-]{8,}",
];

/**
 * 夹具。`secret` = 绝不允许出现在输出里的原文；`markers` = 必须出现的标记；
 * `exact` = 输出必须与输入逐字相同（防空转/防误伤，两个方向都钉）。
 */
const FIXTURES = [
  {
    id: "lowercase-apiKey",
    input: "apiKey=sk-live-abc",
    secret: "sk-live-abc",
    markers: ["[REDACTED]"],
  },
  {
    id: "uppercase-env",
    input: "AUTOFLOW_TOKEN=abc123",
    secret: "abc123",
    markers: ["AUTOFLOW_TOKEN=[REDACTED]"],
  },
  {
    id: "lowercase-token-query",
    input: "token=abcdef1234&user=bob",
    secret: "abcdef1234",
    markers: ["token=[REDACTED]"],
  },
  {
    id: "json-secret",
    input: '{"api_key": "json-plaintext-key"}',
    secret: "json-plaintext-key",
    markers: ["[REDACTED]"],
  },
  {
    id: "bearer-jwt",
    input: "Authorization: Bearer eyJhbG.eyJzdWI.sig",
    secret: "eyJhbG.eyJzdWI.sig",
    markers: ["[REDACTED]"],
  },
  {
    id: "hex-32",
    input: "key=deadbeefcafebabe0123456789abcdef",
    secret: "deadbeefcafebabe0123456789abcdef",
    markers: ["[REDACTED_HEX]"],
  },
  {
    id: "base64-40",
    input:
      "blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHU=",
    secret: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHU=",
    markers: ["[REDACTED_B64]"],
  },
  {
    id: "sk-prefix",
    input: "leaked sk-abcdefghijklmnop end",
    secret: "sk-abcdefghijklmnop",
    markers: ["[REDACTED]"],
  },
  {
    id: "ghp-prefix",
    input: "leaked ghp_abcdefghijklmnopqrst end",
    secret: "ghp_abcdefghijklmnopqrst",
    markers: ["[REDACTED]"],
  },
  {
    id: "plain-english",
    input: "script_error: Traceback\ndivide by zero",
    exact: true,
  },
  {
    id: "plain-chinese",
    input: "请确认部署窗口是否在 2026-10-01 之后",
    exact: true,
  },
  {
    id: "plain-params",
    input: "retries=3 timeout=30 path=/srv/app",
    exact: true,
  },
];

const failures = [];
const notes = [];

function fail(msg) {
  failures.push(msg);
}

function rel(p) {
  return relative(ROOT, p) || p;
}

/** 读文件；不存在即结构性红（判据瞎了，不能当绿）。 */
function readSource(file, sink = failures) {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    sink.push(`取不到入口文件：${rel(file)}（${e instanceof Error ? e.message : e}）`);
    return null;
  }
}

/**
 * import 一个纯函数 TS 模块并取出导出；取不到即红。
 * `sink` 收集失败信息：真仓库跑用全局 `failures`，selftest 用局部数组
 * （反证「取不到入口 ⇒ 红」时不能污染真结论）。
 */
async function loadEntry(entry, sink = failures) {
  const src = readSource(entry.file, sink);
  if (src === null) return null;
  if (!src.includes(`export function ${entry.exportName}`) && !src.includes("export {")) {
    sink.push(`入口 ${entry.id} 找不到导出 ${entry.exportName}（${rel(entry.file)}）`);
    return null;
  }
  let mod;
  try {
    mod = await import(pathToFileURL(entry.file).href);
  } catch (e) {
    sink.push(
      `入口 ${entry.id} 无法加载：${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
  const fn = mod[entry.exportName];
  if (typeof fn !== "function") {
    sink.push(`入口 ${entry.id} 的导出 ${entry.exportName} 不是函数`);
    return null;
  }
  return fn;
}

/**
 * 取一个方法的函数体源码（按花括号配对）。解析不到 = 结构性红。
 * 只看方法体，不看注释：注释里提到正则不算「内联规则」。
 */
function extractMethodBody(source, fnName) {
  const head = new RegExp(
    `(?:private|public|protected)\\s+(?:async\\s+)?${fnName}\\s*\\(`,
  );
  const m = head.exec(source);
  if (!m) return null;
  const start = source.indexOf("{", m.index);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/** 服务面结构判据：纯函数，便于 selftest 喂变异源码。 */
function checkDelegationSource(spec, source) {
  const out = [];
  const importRe = new RegExp(
    `from\\s+["'][^"']*${spec.importFrom.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}["']`,
  );
  if (!importRe.test(source)) {
    out.push(`${spec.id}: 没有 import 共享实现（期望 …/${spec.importFrom}）`);
  }
  const body = extractMethodBody(source, spec.fn);
  if (!body) {
    out.push(`${spec.id}: 找不到方法体（${spec.fn}）——判据无法成立`);
    return out;
  }
  if (!body.includes(spec.mustCall)) {
    out.push(`${spec.id}: 方法体没有调用 ${spec.mustCall}）——脱敏可能被旁路`);
  }
  const code = stripComments(body);
  for (const lit of RULE_LITERALS) {
    if (code.includes(lit)) {
      out.push(`${spec.id}: 方法体内又出现了规则正则（${lit}）——第二份实现`);
    }
  }
  return out;
}

/** 去掉行注释与块注释，避免「注释里提到正则」被判成内联实现。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 全仓不得出现第二份规则字面量（共享实现自身除外）。 */
function checkNoSecondCopy() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(p);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) {
        if (p === SHARED_FILE) continue;
        const src = readFileSync(p, "utf8");
        const code = stripComments(src);
        for (const lit of RULE_LITERALS) {
          if (code.includes(lit)) {
            out.push(`${rel(p)}: 出现第二份脱敏规则字面量（${lit}）——请 import 共享实现`);
          }
        }
      }
    }
  };
  walk(SRC);
  return out;
}

/** 夹具比对：返回失败信息数组（纯函数，selftest 复用）。 */
function checkFixtures(entries, fixtures) {
  const out = [];
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    return ["夹具集为空——判据瞎了"];
  }
  if (fixtures.length < 8) {
    out.push(`夹具集过小（${fixtures.length} < 8）——覆盖不足等于没判据`);
  }
  for (const fx of fixtures) {
    if (!fx.secret && !fx.exact) {
      out.push(`夹具 ${fx.id} 既没有 secret 也没有 exact——空断言`);
      continue;
    }
    const outputs = new Map();
    for (const { id, fn } of entries) {
      let value;
      try {
        value = fn(fx.input);
      } catch (e) {
        out.push(`入口 ${id} 在夹具 ${fx.id} 上抛错：${e instanceof Error ? e.message : e}`);
        continue;
      }
      if (typeof value !== "string") {
        out.push(`入口 ${id} 在夹具 ${fx.id} 上返回非字符串（${typeof value}）——输出不可解析`);
        continue;
      }
      outputs.set(id, value);
      if (fx.exact && value !== fx.input) {
        out.push(`入口 ${id} 误伤正常文案 ${fx.id}：${JSON.stringify(value)}`);
      }
      if (fx.secret && value.includes(fx.secret)) {
        out.push(`入口 ${id} 在夹具 ${fx.id} 上仍含明文凭据 ${JSON.stringify(fx.secret)}`);
      }
      for (const marker of fx.markers ?? []) {
        if (!value.includes(marker)) {
          out.push(`入口 ${id} 在夹具 ${fx.id} 上缺少标记 ${marker}：${JSON.stringify(value)}`);
        }
      }
    }
    const distinct = new Set(outputs.values());
    if (distinct.size > 1) {
      const detail = [...outputs.entries()]
        .map(([id, v]) => `    ${id} => ${JSON.stringify(v)}`)
        .join("\n");
      out.push(`夹具 ${fx.id} 各入口输出不一致（${distinct.size} 种）：\n${detail}`);
    }
  }
  return out;
}

async function resolveRuntimeEntries(overrides = new Map()) {
  const list = [];
  for (const entry of RUNTIME_ENTRIES) {
    const fn = overrides.get(entry.id) ?? (await loadEntry(entry));
    if (fn) list.push({ id: entry.id, fn });
  }
  return list;
}

async function realRun() {
  const entries = await resolveRuntimeEntries();
  failures.push(...checkFixtures(entries, FIXTURES));

  for (const spec of DELEGATED_ENTRIES) {
    const src = readSource(spec.file);
    if (src === null) continue;
    failures.push(...checkDelegationSource(spec, src));
  }

  failures.push(...checkNoSecondCopy());
  notes.push(`运行时入口：${entries.map((e) => e.id).join(" / ")}`);
  notes.push(`服务面结构入口：${DELEGATED_ENTRIES.map((e) => e.id).join(" / ")}`);
  notes.push(`夹具：${FIXTURES.length} 条`);
}

/** 临时目录里放一份变异副本，import 后返回其导出（用完删目录）。 */
async function withTempModule(source, prefix, pick) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const file = join(dir, "mutant.ts");
  writeFileSync(file, source, "utf8");
  try {
    const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`);
    return pick(mod);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function selftest() {
  const results = [];
  const expect = (name, ok, detail) => {
    results.push({ name, ok, detail });
    if (!ok) failures.push(`selftest: ${name} —— ${detail}`);
  };

  // ① 正例控制组：真仓库的入口必须全绿（否则反证没有意义）
  const entries = await resolveRuntimeEntries();
  const realIssues = checkFixtures(entries, FIXTURES);
  expect("正例控制组：当前仓库入口一致且无明文", realIssues.length === 0, realIssues.join("; "));

  // ② 反证一：把共享实现的「小写凭据赋值」规则删掉（= 把强的一侧改弱）
  const sharedSrc = readFileSync(SHARED_FILE, "utf8");
  const weakenedShared = sharedSrc.replace(
    '.replace(SECRET_ASSIGN_RE, "$1$2$3[REDACTED]")',
    '.replace(/(?!x)x/g, "")',
  );
  expect(
    "反证准备：共享实现确实被改弱",
    weakenedShared !== sharedSrc,
    "替换点没命中（共享实现结构变了，请更新 selftest）",
  );
  const weakenedFn = await withTempModule(weakenedShared, "parity-shared-", (m) => m.sanitizeSecrets);
  if (typeof weakenedFn === "function") {
    const issues = checkFixtures(
      [{ id: "mutant/shared-weakened", fn: weakenedFn }],
      FIXTURES,
    );
    expect(
      "反证一：共享实现被改弱（丢小写凭据规则）⇒ 红",
      issues.length > 0,
      "改弱后居然还是绿的，守卫瞎了",
    );
  } else {
    expect("反证一：共享实现被改弱（丢小写凭据规则）⇒ 红", false, "变异副本 import 失败");
  }

  // ③ 反证二：把通知入口改回「历史漂移形态」（旧的四条规则）⇒ 与共享实现不一致
  const oldNotificationChain = `export function sanitizeNotificationText(input: string): string {
  if (!input) return input;
  return input
    .replace(/([A-Z_]{3,}\\s*=\\s*)[^\\s\\n]+/g, "$1[REDACTED]")
    .replace(/(Bearer\\s+)[A-Za-z0-9\\-._~+/]+=*/gi, "$1[REDACTED]")
    .replace(/([0-9a-fA-F]{32,})/g, "[REDACTED_HEX]")
    .replace(/([A-Za-z0-9+/]{40,}={0,2})/g, "[REDACTED_B64]");
}
`;
  const oldFn = await withTempModule(oldNotificationChain, "parity-notif-", (m) => m.sanitizeNotificationText);
  if (typeof oldFn === "function") {
    const issues = checkFixtures(
      [
        { id: "shared/current", fn: entries.find((e) => e.id === RUNTIME_ENTRIES[0].id).fn },
        { id: "notification/old-drifted", fn: oldFn },
      ],
      FIXTURES,
    );
    expect(
      "反证二：通知入口退回旧四条规则（历史漂移）⇒ 红",
      issues.some((i) => i.includes("输出不一致") || i.includes("明文凭据")),
      "旧实现居然与共享实现一致，夹具没覆盖到差异",
    );
  } else {
    expect("反证二：通知入口退回旧四条规则（历史漂移）⇒ 红", false, "变异副本 import 失败");
  }

  // ④ 反证三：把规则正则抄回服务方法体（本次缺陷的根因形态）⇒ 结构红
  const aiSpec = DELEGATED_ENTRIES[0];
  const aiSrc = readFileSync(aiSpec.file, "utf8");
  const mutatedAi = aiSrc.replace(
    "return sanitizeSecrets(raw, { maxLength: 3000 });",
    'return raw.replace(/([A-Z_]{3,}\\s*=\\s*)[^\\s\\n]+/g, "$1[REDACTED]");',
  );
  expect("反证准备：ai 服务确实被注入内联规则", mutatedAi !== aiSrc, "替换点没命中");
  const mutatedIssues = checkDelegationSource(aiSpec, mutatedAi);
  expect(
    "反证三：服务方法体重新内联规则 ⇒ 结构红",
    mutatedIssues.some((i) => i.includes("第二份实现")),
    mutatedIssues.join("; ") || "没有报红",
  );
  const cleanIssues = checkDelegationSource(aiSpec, aiSrc);
  expect(
    "正例控制组：服务面结构判据对真源码为绿",
    cleanIssues.length === 0,
    cleanIssues.join("; "),
  );

  // ⑤ 反证四：入口解析失败 ⇒ 红（判据瞎了要报红，不能静默通过）
  const ghostSink = [];
  const ghost = await loadEntry(
    {
      id: "ghost/missing",
      file: join(SRC, "common", "utils", "does-not-exist.util.ts"),
      exportName: "nope",
    },
    ghostSink,
  );
  expect(
    "反证四：取不到入口 ⇒ 红",
    ghost === null && ghostSink.length > 0,
    "不存在的入口居然被解析成功（或没有报红）",
  );

  const bad = results.filter((r) => !r.ok);
  for (const r of results) {
    notes.push(`${r.ok ? "✔" : "✘"} ${r.name}`);
  }
  return bad.length === 0;
}

async function main() {
  const selftestMode = process.argv.includes("--selftest");
  if (selftestMode) {
    await selftest();
  } else {
    await realRun();
  }

  for (const note of notes) console.log(`  ${note}`);
  if (failures.length > 0) {
    console.error(`\n✘ 脱敏一致性守卫失败（${failures.length} 项）：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    selftestMode
      ? "\n✔ check-sanitize-parity selftest 全绿（含 4 条反证）"
      : `\n✔ check-sanitize-parity 全绿：${RUNTIME_ENTRIES.length} 个运行时入口 + ${DELEGATED_ENTRIES.length} 个服务面入口，${FIXTURES.length} 条夹具一致`,
  );
}

await main();
