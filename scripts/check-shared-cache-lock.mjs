#!/usr/bin/env node
/**
 * 跨端共享缓存的**锁命名规则一致性守卫**（H-4b）。
 *
 * ## 缺陷背景（为什么要这个守卫）
 *
 * executor-node 与 executor-python 是**两个独立进程**，同机部署时可能共享
 * 同一批缓存目录（`.git_cache/<repo>` / `.pkg-cache/<sha256(url)>`）——
 * 两端的键派生**逐字同式**（git：`<cleaned>-<sha256(repoUrl)[:12]>`；
 * pkg：URL 的 sha256 全量 hex）。
 *
 * H-4b 给两端各加了一层跨进程锁（flock）来防「同机两实例互踩缓存」。但
 * **锁文件的名字必须两端逐字一致**，否则两端锁的不是同一把锁 ⇒ 互斥**静默
 * 失效**（两边各锁各的，git clone / `.zip.part` 依然互踩）。这种漂移是
 * **静默**的：没有任何测试会红——两端各自的功能测试都绿，只是保护没生效。
 *
 * 本守卫把这个「忘」变成红灯：两端锁命名规则的**每一个字面量**必须相同。
 *
 * ## 🔴 本守卫**不证明互斥已生效**（D-20，2026-11-03）
 *
 * 本守卫只核对「两端**锁命名规则**逐字一致」。它**不能**证明跨语言互斥成立：
 * **executor-node 侧当前没有任何实际加锁**（Node 24 core 无 flock；`O_EXCL` 与
 * flock 不可互操作；跨容器 pid 存活检测不可靠 ⇒ 软锁不安全）。详见
 * `apps/executor-node/src/shared-cache-lock.ts` 的对应段落。
 *
 * ⇒ **全绿 ≠ 互斥就绪。** 它的意义是：等 node 侧真正接入锁时，两端锁的是**同一把**。
 * 在 node 接入前，「同机混布 + 共享 WORK_DIR」形态下 python↔node 仍会互踩缓存
 * （compose 默认不共享这两个卷，故默认部署不受影响）。
 *
 * 判据（任何一条不满足即红）
 *
 *   ① **常量逐字一致**：锁后缀、锁文件名前缀、锁目录名、三类锁键前缀、
 *      安全字符白名单——两端必须**逐字相同**。
 *   ② **安全字符白名单是 ASCII 显式清单**：两端都不得用「按语言语义判断
 *      是否安全」的写法——python 的 `str.isalnum()` 对 `'中'` 返回 True，
 *      JS 的 `\w` 不含非 ASCII ⇒ 两端会算出**不同文件名** ⇒ 互斥失效。
 *      守卫要求两端都出现**同一份显式字符集**。
 *   ③ **键构造函数同形**：git / pkg / interp 三类键的构造式两端同形
 *      （前缀 + 参数 + 连接方式）。
 *   ④ **锁目录名在两端的工作目录保护名单里**：锁文件被 TTL 清扫删掉 ⇒
 *      新进程建**新 inode** ⇒ 互斥失效。这是「保护名单漂移」的守卫。
 *   ⑤ **结构红**：源文件读不到 / 解析不出常量 ⇒ 判据瞎了 ⇒ 结构红
 *      （**不是**绿）。
 *
 * ## 反向不校验
 *
 * node 可以有 python 没有的额外锁（那是更严，不是漂移）——本守卫只校验
 * 「python 有的，node 必须逐字有」。
 *
 * 用法：
 *   node scripts/check-shared-cache-lock.mjs            # 真仓库检查
 *   node scripts/check-shared-cache-lock.mjs --selftest  # 守卫自检（含反证）
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

/** node 侧的锁命名规则实现（**被测对象之一**）。 */
const NODE_REL = "apps/executor-node/src/shared-cache-lock.ts";
/** python 侧的锁命名规则实现（**被测对象之二**）。 */
const PY_REL = "apps/executor-python/lib/file_lock.py";
/** node 侧的工作目录保护名单。 */
const NODE_PROTECT_REL = "apps/executor-node/src/file-logger.ts";
/** python 侧的工作目录保护名单。 */
const PY_PROTECT_REL = "apps/executor-python/maintenance.py";

/**
 * 必须两端逐字一致的**字符串常量**（常量名 → 期望值）。
 *
 * 这些值是判据的**内容**：两端任一端改了其中任何一个 ⇒ 两端锁的文件名
 * 不同 ⇒ 互斥失效 ⇒ 红。
 */
export const SHARED_CONSTANTS = {
  LOCK_SUFFIX: ".lock",
  LOCK_FILE_PREFIX: ".acf-",
  CACHE_LOCK_DIR_NAME: ".cache-locks",
  GIT_LOCK_KEY_PREFIX: "git-",
  PKG_LOCK_KEY_PREFIX: "pkg-",
  INTERPRETER_LOCK_KEY_PREFIX: "interp-",
};

/**
 * 安全字符白名单的**字符集**（两端必须逐字相同）。
 *
 * 只含 ASCII 字母数字与 `._-`。
 */
export const SAFE_CHARS = "A-Za-z0-9._-";

/** 剥注释（TS 的行注释与块注释、Python 的 `#`）。方向：只少匹配。 */
function stripTsComments(text) {
  return String(text ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.replace(/\s+\/\/.*$/, ""))
    .join("\n");
}

function stripPyComments(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
}

/**
 * 从源码里抽一个字符串常量的字面值。
 *
 * 支持两种形态（两端各自的语言写法）：
 *   · TS：`export const LOCK_SUFFIX = ".lock";`
 *   · py：`LOCK_SUFFIX = ".lock"`
 *
 * 抽不到 ⇒ 返回 null（**不是**猜一个默认值——那是假绿）。
 */
export function extractStringConst(src, name) {
  const text = String(src ?? "");
  const re = new RegExp(
    `(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*["'\`]([^"'\`]*)["'\`]` +
      `|\\b${name}\\s*(?::[^=]+)?=\\s*["']([^"']*)["']`,
  );
  const m = re.exec(text);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2];
}

/**
 * 抽出 ``SAFE_CHARS`` 的**定义区域**（只取该常量附近，避免把仓里别的字符串
 * 字面量误当成「白名单」）。
 *
 * 形态：
 *   · TS：`export const SAFE_CHARS = /^[A-Za-z0-9._-]$/;`
 *   · py：`SAFE_CHARS = 'A-Za-z0-9._-'`
 *
 * 抽不到 ⇒ 返回 null（**不是**猜一个默认值——那是假绿）。
 */
export function extractSafeCharsRegion(src) {
  const text = String(src ?? "");
  const m = /(?:export\s+)?const\s+SAFE_CHARS|^\s*SAFE_CHARS\s*(?::[^=]+)?=/m.exec(text);
  if (!m) return null;
  return text.slice(m.index, m.index + 240);
}

/**
 * 从 ``SAFE_CHARS`` 定义区域里抽出**字符集**（两端各一份）。
 *
 * TS 侧是正则字符类 `[A-Za-z0-9._-]`；py 侧可以是字符串字面量
 * `'A-Za-z0-9._-'`，也可以是表达式（`frozenset(string.ascii_letters + …)`）——
 * 后者**没有**显式字符集 ⇒ 正是守卫要抓的形态（python 的 `isalnum()` 语义
 * 与 JS 的 ASCII 白名单不等价 ⇒ 两端算出不同文件名）。
 */
export function extractCharClass(src) {
  const region = extractSafeCharsRegion(src);
  if (region === null) return [];
  const found = new Set();
  // 形态 ①：正则字符类 `[A-Za-z0-9._-]`
  for (const m of region.matchAll(/\[\^?([A-Za-z0-9._-]{3,})\]/g)) {
    found.add(m[1]);
  }
  // 形态 ②：显式字符串字面量（py：`SAFE_CHARS = 'A-Za-z0-9._-'`）
  for (const m of region.matchAll(/["']([A-Za-z0-9._-]{3,})["']/g)) {
    found.add(m[1]);
  }
  return [...found];
}

/** 判据本体：返回 { errors, drift, constants }。 */
export function checkSharedCacheLock({ root }) {
  const errors = [];
  const drift = [];

  const nodePath = join(root, NODE_REL);
  const pyPath = join(root, PY_REL);
  if (!existsSync(nodePath)) {
    errors.push(`读不到 node 侧的锁命名规则：${NODE_REL} —— 守卫瞎了。`);
  }
  if (!existsSync(pyPath)) {
    errors.push(`读不到 python 侧的锁命名规则：${PY_REL} —— 守卫瞎了。`);
  }
  if (errors.length > 0) return { errors, drift, constants: {} };

  const nodeSrc = stripTsComments(readFileSync(nodePath, "utf8"));
  const pySrc = stripPyComments(readFileSync(pyPath, "utf8"));

  const constants = {};
  for (const [name, expected] of Object.entries(SHARED_CONSTANTS)) {
    const nodeVal = extractStringConst(nodeSrc, name);
    const pyVal = extractStringConst(pySrc, name);
    if (nodeVal === null) {
      errors.push(`node 侧抽不到常量 ${name} —— 守卫瞎了（不是「两边一致」）。`);
    }
    if (pyVal === null) {
      errors.push(`python 侧抽不到常量 ${name} —— 守卫瞎了（不是「两边一致」）。`);
    }
    if (nodeVal !== null && pyVal !== null && nodeVal !== pyVal) {
      drift.push(
        `常量 ${name} 两端不一致：node="${nodeVal}" vs python="${pyVal}" —— ` +
          "两端会锁不同的文件 ⇒ 跨进程互斥静默失效。",
      );
    }
    if (nodeVal !== null && nodeVal !== expected) {
      drift.push(
        `常量 ${name} 的值漂离了约定："${nodeVal}" ≠ "${expected}" —— ` +
          "两端若已同步改过，请同步更新本守卫的 SHARED_CONSTANTS。",
      );
    }
    constants[name] = { node: nodeVal, python: pyVal };
  }

  // ② 安全字符白名单：两端算出来的字符集必须逐字相同，且必须包含约定的那一份。
  const nodeClasses = extractCharClass(nodeSrc);
  const pyClasses = extractCharClass(pySrc);
  const expectedClass = SAFE_CHARS;
  const hasExpected = (list) => list.some((c) => c === expectedClass);
  if (nodeClasses.length === 0) {
    errors.push(`node 侧抽不到安全字符白名单 —— 守卫瞎了（不是「白名单为空」）。`);
  }
  if (pyClasses.length === 0) {
    errors.push(`python 侧抽不到安全字符白名单 —— 守卫瞎了（不是「白名单为空」）。`);
  }
  if (nodeClasses.length > 0 && !hasExpected(nodeClasses)) {
    drift.push(
      `node 侧的安全字符白名单里没有约定的 "${expectedClass}" —— ` +
        "白名单缩了 ⇒ 某些键会被替换成不同字符 ⇒ 两端文件名不一致。",
    );
  }
  if (pyClasses.length > 0 && !hasExpected(pyClasses)) {
    drift.push(
      `python 侧的安全字符白名单里没有约定的 "${expectedClass}" —— ` +
        "白名单缩了 ⇒ 某些键会被替换成不同字符 ⇒ 两端文件名不一致。",
    );
  }
  // 两端必须**至少有一处**写了同一份显式字符集（这就是「逐字一致」的落点）。
  const shared = nodeClasses.filter((c) => pyClasses.includes(c));
  if (nodeClasses.length > 0 && pyClasses.length > 0 && shared.length === 0) {
    drift.push(
      `两端的安全字符白名单没有任何一份是逐字相同的 ` +
        `(node: ${nodeClasses.join(" / ")}；python: ${pyClasses.join(" / ")}) —— ` +
        "两端会算出不同的锁文件名 ⇒ 互斥静默失效。",
    );
  }

  // ③ 键构造函数同形：三类键的前缀常量必须**都**被用在构造式里。
  const keyFns = [
    { name: "git", constName: "GIT_LOCK_KEY_PREFIX", node: /gitLockKey/, py: /git_lock_key/ },
    { name: "pkg", constName: "PKG_LOCK_KEY_PREFIX", node: /pkgLockKey/, py: /pkg_lock_key/ },
    {
      name: "interp",
      constName: "INTERPRETER_LOCK_KEY_PREFIX",
      node: /interpreterLockKey/,
      py: /interpreter_lock_key/,
    },
  ];
  for (const fn of keyFns) {
    if (!fn.node.test(nodeSrc)) {
      errors.push(`node 侧找不到 ${fn.name} 锁键构造函数 —— 守卫瞎了。`);
    }
    if (!fn.py.test(pySrc)) {
      errors.push(`python 侧找不到 ${fn.name} 锁键构造函数 —— 守卫瞎了。`);
    }
  }

  // ④ 锁目录名必须登记进两端的工作目录保护名单。
  //    两端**可能**写成常量引用（python 侧：`file_lock.CACHE_LOCK_DIR_NAME`），
  //    所以判据要同时接受「字面量」与「引用了那个常量」两种写法。
  const protectChecks = [
    { rel: NODE_PROTECT_REL, label: "node", src: nodePath },
    { rel: PY_PROTECT_REL, label: "python", src: pyPath },
  ];
  const dirName = SHARED_CONSTANTS.CACHE_LOCK_DIR_NAME;
  for (const pc of protectChecks) {
    const abs = join(root, pc.rel);
    if (!existsSync(abs)) {
      errors.push(`读不到 ${pc.label} 侧的工作目录保护名单：${pc.rel} —— 守卫瞎了。`);
      continue;
    }
    const raw = readFileSync(abs, "utf8");
    const text = pc.label === "node" ? stripTsComments(raw) : stripPyComments(raw);
    // 形态 ①：字面量 `' .cache-locks '`
    const hasLiteral = text.includes(`'${dirName}'`) || text.includes(`"${dirName}"`);
    // 形态 ②：引用了那个常量（`file_lock.CACHE_LOCK_DIR_NAME` /
    //         `CACHE_LOCK_DIR_NAME`）——常量值已由上面的判据①钉住逐字一致。
    const hasReference = text.includes("CACHE_LOCK_DIR_NAME");
    if (!hasLiteral && !hasReference) {
      drift.push(
        `${pc.label} 侧的工作目录保护名单里没有 '${dirName}' —— ` +
          "锁文件会被 TTL 清扫删掉 ⇒ 新进程建新 inode ⇒ 互斥失效。",
      );
    }
  }

  return { errors, drift, constants };
}

function main() {
  const argv = process.argv.slice(2);
  const rootArg = argv.find((a) => a.startsWith("--root="))?.slice("--root=".length);
  const root = resolve(rootArg ?? process.cwd());
  const { errors, drift, constants } = checkSharedCacheLock({ root });

  if (errors.length > 0) {
    console.error("");
    console.error("✖ 共享缓存锁守卫结构错误（判据本身不可信）：");
    for (const e of errors) console.error("  · " + e);
    console.error("");
    process.exit(1);
  }

  if (drift.length > 0) {
    console.error("");
    console.error(`✖ 跨端共享缓存锁命名规则已漂移（${drift.length} 处）：`);
    for (const d of drift) console.error("  · " + d);
    console.error("");
    console.error("  修法：让两端逐字一致 ——");
    console.error(`    · node：    ${NODE_REL}`);
    console.error(`    · python： ${PY_REL}`);
    console.error("  **不要**改守卫放行（改了一端 = 两端锁不同的文件 = 互斥静默失效）。");
    process.exit(1);
  }

  const summary = Object.entries(constants)
    .map(([k, v]) => `${k}="${v.node}"`)
    .join(" / ");
  console.log(
    `✔ 跨端共享缓存锁命名规则一致：${summary}；` +
      `安全字符白名单两端逐字相同（"${SAFE_CHARS}"）；` +
      `锁目录 '${SHARED_CONSTANTS.CACHE_LOCK_DIR_NAME}' 已在两端的工作目录保护名单里。`,
  );
}

// ── 自检（真子进程 + 退出码 + 报错文本）───────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

/** 造一棵 fixture 仓库树（守卫的四个被测文件）。 */
function fixtureTree({ nodeLock, pyLock, nodeProtect, pyProtect }) {
  return {
    [NODE_REL]: nodeLock,
    [PY_REL]: pyLock,
    [NODE_PROTECT_REL]: nodeProtect,
    [PY_PROTECT_REL]: pyProtect,
  };
}

/** 一份**正确**的 node 侧实现（fixture 基线）。 */
const GOOD_NODE = `
export const LOCK_SUFFIX = ".lock";
export const LOCK_FILE_PREFIX = ".acf-";
export const CACHE_LOCK_DIR_NAME = ".cache-locks";
export const GIT_LOCK_KEY_PREFIX = "git-";
export const PKG_LOCK_KEY_PREFIX = "pkg-";
export const INTERPRETER_LOCK_KEY_PREFIX = "interp-";
export const SAFE_CHARS = /^[A-Za-z0-9._-]$/;
export function lockFileName(key: string): string { return key; }
export function gitLockKey(repoDirName: string): string { return repoDirName; }
export function pkgLockKey(cacheKey: string): string { return cacheKey; }
export function interpreterLockKey(version: string, platformToken: string | null): string { return version; }
`;

/** 一份**正确**的 python 侧实现（fixture 基线）。 */
const GOOD_PY = `
LOCK_SUFFIX = ".lock"
LOCK_FILE_PREFIX = ".acf-"
CACHE_LOCK_DIR_NAME = ".cache-locks"
GIT_LOCK_KEY_PREFIX = "git-"
PKG_LOCK_KEY_PREFIX = "pkg-"
INTERPRETER_LOCK_KEY_PREFIX = "interp-"
SAFE_CHARS = 'A-Za-z0-9._-'
def lock_file_name(key): return key
def git_lock_key(repo_dir_name): return repo_dir_name
def pkg_lock_key(cache_key): return cache_key
def interpreter_lock_key(version, platform_token): return version
`;

const GOOD_NODE_PROTECT = `const PROTECTED_WORKDIR_NAMES = new Set(['.cache-locks', '.pkg-cache']);`;
const GOOD_PY_PROTECT = `_PROTECTED_WORKDIR_NAMES = {'.cache-locks', '.pkg-cache'}`;

function runSelftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "shared-cache-lock-selftest-" });
        try {
          expectExit(
            runGuard(SELF, { args: ["--root", repo.dir], cwd: repo.dir }),
            { ...expect, withinMs: 3000, label: name },
          );
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  // ① 正常树：两端逐字一致 ⇒ 绿
  subprocess(
    "① 两端一致 ⇒ 绿",
    fixtureTree({
      nodeLock: GOOD_NODE,
      pyLock: GOOD_PY,
      nodeProtect: GOOD_NODE_PROTECT,
      pyProtect: GOOD_PY_PROTECT,
    }),
    {
      code: 0,
      contains: ["跨端共享缓存锁命名规则一致", "CACHE_LOCK_DIR_NAME"],
      absent: ["已漂移", "结构错误"],
    },
  );

  // ② 常量漂移（node 侧改了后缀）⇒ 红
  subprocess(
    "② 常量漂移（node 改了后缀）⇒ 红",
    fixtureTree({
      nodeLock: GOOD_NODE.replace('LOCK_SUFFIX = ".lock"', 'LOCK_SUFFIX = ".lck"'),
      pyLock: GOOD_PY,
      nodeProtect: GOOD_NODE_PROTECT,
      pyProtect: GOOD_PY_PROTECT,
    }),
    {
      code: 1,
      contains: ["LOCK_SUFFIX", "两端不一致", "已漂移"],
      absent: ["守卫接线自检通过"],
    },
  );

  // ③ 锁目录名漂移（node 侧改成别的目录）⇒ 红
  subprocess(
    "③ 锁目录名漂移 ⇒ 红",
    fixtureTree({
      nodeLock: GOOD_NODE.replace('CACHE_LOCK_DIR_NAME = ".cache-locks"', 'CACHE_LOCK_DIR_NAME = ".locks"'),
      pyLock: GOOD_PY,
      nodeProtect: GOOD_NODE_PROTECT,
      pyProtect: GOOD_PY_PROTECT,
    }),
    {
      code: 1,
      contains: ["CACHE_LOCK_DIR_NAME", "已漂移"],
    },
  );

  // ④ 保护名单漏了锁目录名 ⇒ 红（锁文件被清扫 ⇒ 互斥失效）
  subprocess(
    "④ 保护名单漏了锁目录名 ⇒ 红",
    fixtureTree({
      nodeLock: GOOD_NODE,
      pyLock: GOOD_PY,
      nodeProtect: `const PROTECTED_WORKDIR_NAMES = new Set(['.pkg-cache']);`,
      pyProtect: GOOD_PY_PROTECT,
    }),
    {
      code: 1,
      contains: ["工作目录保护名单", "互斥失效", "已漂移"],
    },
  );

  // ⑤ 白名单在 python 侧被换成 isalnum 语义（不再含显式字符集）⇒ 红
  //    （形态：python 侧写成了表达式 ⇒ 抽不出显式字符集 ⇒ 结构红。
  //     「抽不出」与「抽到但不同」都是红，方向一致：宁可红不可绿。）
  subprocess(
    "⑤ python 侧白名单不含约定的显式字符集 ⇒ 红",
    fixtureTree({
      nodeLock: GOOD_NODE,
      pyLock: GOOD_PY.replace(
        `SAFE_CHARS = 'A-Za-z0-9._-'`,
        "SAFE_CHARS = frozenset(ch for ch in str(key) if ch.isalnum())",
      ),
      nodeProtect: GOOD_NODE_PROTECT,
      pyProtect: GOOD_PY_PROTECT,
    }),
    {
      code: 1,
      contains: ["安全字符白名单"],
      absent: ["命名规则一致"],
    },
  );

  // ⑥ 源文件读不到 ⇒ 结构红（不是绿）
  subprocess(
    "⑥ 源文件读不到 ⇒ 结构红",
    { [NODE_REL]: GOOD_NODE, [PY_REL]: GOOD_PY, [NODE_PROTECT_REL]: GOOD_NODE_PROTECT },
    {
      code: 1,
      contains: ["结构错误", "保护名单"],
      absent: ["命名规则一致"],
    },
  );

  const failed = reportCases(cases, { title: "check-shared-cache-lock selftest" });
  if (failed > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  if (process.argv.includes("--selftest")) {
    runSelftest();
  } else {
    main();
  }
}
