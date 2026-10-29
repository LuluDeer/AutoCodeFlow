#!/usr/bin/env node
/**
 * 跨 app 的 SSRF 拒绝矩阵对齐守卫。
 *
 * 背景：`admin-api` 的 SEC-04 把 SSRF 判定收敛成一张表 + 18 条危险地址矩阵
 * （`src/common/utils/__tests__/ssrf-deny-matrix.spec.ts`）。而 `executor-node` 是**同一道闸的
 * 第二份实现**，且长期是弱版本 —— R74-A1 实测它把 `[::ffff:127.0.0.1]`（WHATWG 规范化为
 * `[::ffff:7f00:1]`）整条放行。R77 加了镜像矩阵后，**第一次跑就揪出 198.18.0.0/15 缺失**。
 *
 * 但镜像不会自动同步：往 admin-api 加一条危险段、忘了加到 executor-node，测试依然全绿。
 * 本守卫把这个「忘」变成红灯：admin-api 矩阵里的每个 addr，必须出现在
 * `apps/executor-node/src/lib/ssrf-deny-parity.spec.ts` 里。
 *
 * 反向不校验（executor-node 可以有 admin-api 没有的额外地址）——那是更严，不是漂移。
 *
 * ## T4（第 4 轮守卫自检审计）加的三道防线
 *
 * 审计给本脚本打 3 分，原因是「表被清空 → 零差异全绿」：判据只是
 * `for (entry of 源) if (!镜像.includes(entry)) 红`，**没有任何下界**。三种形态都能骗过它：
 *   ① admin-api 矩阵被删空（或正则因格式变化解析成 0 条）—— 已有 `entries.length === 0`
 *      兜底，但只挡住「0 条」，挡不住「从 18 条掉到 3 条」；
 *   ② 镜像侧的表被清空 —— 那时每条源地址都「缺失」，反而红，不算误绿；但**镜像侧
 *      被注释掉一半**时会误绿（见 ③）；
 *   ③ 镜像侧的条目被 `//`/`#` 注释掉 —— 旧实现用 `src.includes(needle)` 纯子串匹配，
 *      注释行照样命中 → 用例根本没跑，守卫报绿。
 * 现在：三处文本先剥注释再匹配；三处各有条目数下界（低于实测值即红）。
 *
 * 用法：`node scripts/check-ssrf-deny-parity.mjs [--selftest] [--root <dir>]`
 *   --selftest：跑真脚本的子进程，5 条用例逐条断言退出码 + 关键报错文本（<1s）。
 *   --root    ：只给 selftest 用：在任意临时树上跑（默认仓库根）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const SRC_REL = "apps/admin-api/src/common/utils/__tests__/ssrf-deny-matrix.spec.ts";

/**
 * 条目数下界 = **实测值**（2026-10-29 实测：源 18 / executor-node 18 / executor-python 18）。
 *
 * 这是棘轮，只增不减：`check-ssrf-deny-parity` 的正确性依赖「源表非空且镜像表非空」，
 * 而「表被清空/被注释」会让「零差异」变成一句永真断言。确实要缩减矩阵时，请同步
 * 改这三个常量并在 PR 里说明为什么要放宽（默认应该补地址，而不是删地址）。
 */
export const MIN_SOURCE_ENTRIES = 18;

/**
 * 三个消费方（本仓的 SSRF 拒绝判据有三份实现，都必须被同一张矩阵钉住）：
 *   ① admin-api —— 矩阵的**出处**（表驱动 + 18 条），本身已有自己的 spec；
 *   ② executor-node —— 镜像用例 `ssrf-deny-parity.spec.ts`；
 *   ③ executor-python —— 镜像用例 `tests/test_ssrf_guard.py`（R79 新增）。
 *
 * 只校验 ②③：它们才是「会漏」的地方（① 是矩阵本身）。
 */
export const TARGETS = [
  {
    relPath: "apps/executor-node/src/lib/ssrf-deny-parity.spec.ts",
    label: "executor-node",
    lang: "ts",
    needle: (addr) => `addr: ${JSON.stringify(addr)}`,
    countEntries: (src) => [...src.matchAll(/\baddr:\s*"[^"]*"/g)].length,
    minEntries: 18,
  },
  {
    relPath: "apps/executor-python/tests/test_ssrf_guard.py",
    label: "executor-python",
    lang: "py",
    needle: (addr) => `"${addr}"`,
    countEntries: (src) => {
      const block = src.match(/DANGER_ADDRESSES\s*=\s*\[([\s\S]*?)\n\]/);
      if (!block) return 0;
      return [...block[1].matchAll(/"([^"]*)"/g)].length;
    },
    minEntries: 18,
  },
];

// ── 剥注释 ──────────────────────────────────────────────────────────────────
// 方向只有「少匹配」：注释里的条目**不算**镜像已同步（旧实现正是靠子串误绿）。
// 行内剥离要求 `//` / `#` 前有空白，避免切掉 `http://` 之类的正文。
const stripTsComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.replace(/\s+\/\/.*$/, ""))
    .join("\n");

const stripPyComments = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");

const stripFor = (lang, text) => (lang === "py" ? stripPyComments(text) : stripTsComments(text));

/** admin-api 矩阵条目：`{ name: "…", addr: "…", risk: "…" }`。 */
export function parseSourceEntries(src) {
  return [...src.matchAll(/\{\s*name:\s*"([^"]+)",\s*addr:\s*"([^"]+)",\s*risk:\s*"([^"]+)"\s*\}/g)].map(
    (m) => ({ name: m[1], addr: m[2], risk: m[3] }),
  );
}

/**
 * 纯判定（打印与退出码留给 CLI）：返回 {errors, missing, entries, sideCounts}。
 * errors = 结构性（表被清空/文件读不到/低于下界）；missing = 真实的镜像漂移。
 */
export function checkParity({ root }) {
  const errors = [];
  const missing = [];

  const srcPath = join(root, SRC_REL);
  if (!existsSync(srcPath)) {
    errors.push(`读不到 admin-api 矩阵：${SRC_REL} —— 路径变了或文件被移走，守卫瞎了。`);
    return { errors, missing, entries: 0, sideCounts: {} };
  }
  const src = stripFor("ts", readFileSync(srcPath, "utf8"));
  const entries = parseSourceEntries(src);

  if (entries.length === 0) {
    errors.push("从 admin-api 矩阵里解析出 0 条地址 —— 正则失效了（不是矩阵空了）。");
    return { errors, missing, entries: 0, sideCounts: {} };
  }
  if (entries.length < MIN_SOURCE_ENTRIES) {
    errors.push(
      `admin-api 矩阵只解析到 ${entries.length} 条（实测下界 ${MIN_SOURCE_ENTRIES}）—— ` +
        "表被清空/被注释掉了，此时「零差异全绿」是永真断言。",
    );
  }

  const sideCounts = {};
  for (const target of TARGETS) {
    const abs = join(root, target.relPath);
    if (!existsSync(abs)) {
      errors.push(`读不到 ${target.label} 的镜像用例：${target.relPath} —— 守卫瞎了。`);
      continue;
    }
    const text = stripFor(target.lang, readFileSync(abs, "utf8"));
    const count = target.countEntries(text);
    sideCounts[target.label] = count;
    if (count < target.minEntries) {
      errors.push(
        `${target.label} 的 deny 表只解析到 ${count} 条（实测下界 ${target.minEntries}）—— ` +
          "表被清空/被注释掉了；条目不在，差异也就无从谈起。",
      );
    }
    for (const e of entries) {
      if (!text.includes(target.needle(e.addr))) {
        missing.push({ ...e, target: target.label });
      }
    }
  }

  return { errors, missing, entries, sideCounts };
}

function main() {
  const argv = process.argv.slice(2);
  const root = resolve(argValue(argv, "--root") ?? process.cwd());
  const { errors, missing, entries, sideCounts } = checkParity({ root });

  if (errors.length > 0) {
    console.error("");
    console.error("✖ SSRF 矩阵守卫结构错误（判据本身不可信）：");
    for (const e of errors) console.error("  · " + e);
    console.error("");
    process.exit(1);
  }

  if (missing.length > 0) {
    console.error("");
    console.error("✖ SSRF 拒绝矩阵未对齐：admin-api 有、镜像里没有 " + missing.length + " 条");
    for (const m of missing) {
      console.error(`  · ${m.addr}（${m.name}, risk=${m.risk}）—— 缺在 ${m.target}`);
    }
    console.error("");
    console.error("  修法：把上面每条加进对应镜像文件的 DANGER_ADDRESSES ——");
    console.error("    · executor-node：apps/executor-node/src/lib/ssrf-deny-parity.spec.ts");
    console.error("    · executor-python：apps/executor-python/tests/test_ssrf_guard.py（带 # 注释即可）");
    console.error("  并确认该侧的闸真的拒绝它。**不要**改守卫放行。");
    process.exit(1);
  }

  const sides = TARGETS.map((t) => `${t.label} ${sideCounts[t.label]}`).join(" / ");
  console.log(
    "✔ SSRF 拒绝矩阵已对齐：admin-api 的 " + entries.length + " 条危险地址全部出现在 " +
      TARGETS.map((s) => s.label).join(" / ") + " 的镜像用例中" +
      `（条目数 ${sides}，下界 ${MIN_SOURCE_ENTRIES}）。`,
  );
}

// ── 自检（T4：真子进程 + 退出码 + 报错文本）────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

const ADD = Array.from({ length: 18 }, (_, i) => `10.0.${i}.1`);

const sourceSpec = (addrs) =>
  "export const SSRF_DENY_HOST_PATTERNS = [\n" +
  addrs.map((a, i) => `  { name: "seg-${i}", addr: "${a}", risk: "private-lan" },`).join("\n") +
  "\n];\n";

const nodeSpec = (entries) =>
  "const DANGER_ADDRESSES: Array<{ name: string; addr: string }> = [\n" +
  entries
    .map((e) => (e.commented ? `  // { name: "x", addr: "${e.addr}" },` : `  { name: "x", addr: "${e.addr}" },`))
    .join("\n") +
  "\n];\n";

const pySpec = (entries) =>
  "DANGER_ADDRESSES = [\n" +
  entries
    .map((e) => (e.commented ? `    # "${e.addr}",` : `    "${e.addr}",  # seg`))
    .join("\n") +
  "\n]\n";

const plain = (addrs) => addrs.map((addr) => ({ addr }));

/** 造一棵 fixture 仓库树（默认三侧各 18 条、完全对齐）。 */
const ssrfTree = ({ srcAddrs = ADD, nodeEntries = plain(ADD), pyEntries = plain(ADD) } = {}) => ({
  [SRC_REL]: sourceSpec(srcAddrs),
  "apps/executor-node/src/lib/ssrf-deny-parity.spec.ts": nodeSpec(nodeEntries),
  "apps/executor-python/tests/test_ssrf_guard.py": pySpec(pyEntries),
});

/**
 * 自检：5 条用例，全部跑真脚本子进程。
 *
 * 旧版**没有 selftest**（审计 3 分的直接原因）—— 判据里的 `entries.length === 0`
 * 是唯一的结构性兜底，没人验证它还活着。
 */
function runSelftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "ssrf-parity-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), { ...expect, withinMs: 1000, label: name });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  // ① 三侧一致 → 绿（且报出条目数与下界，防止「静默跑过」）
  subprocess("① 三侧各 18 条完全一致 → 绿", ssrfTree(), {
    code: 0,
    contains: ["SSRF 拒绝矩阵已对齐", "admin-api 的 18 条", "executor-node 18 / executor-python 18", "下界 18"],
    absent: ["未对齐", "结构错误"],
  });

  // ② 一侧多一条（admin-api 新增一条、镜像没跟上）→ 红，且点名两侧
  {
    const extra = [...ADD, "10.0.99.1"];
    subprocess("② admin-api 多一条、镜像没跟上 → 红（点名两侧）", ssrfTree({ srcAddrs: extra }), {
      code: 1,
      contains: ["未对齐", "10.0.99.1", "缺在 executor-node", "缺在 executor-python"],
      absent: ["已对齐"],
    });
  }

  // ③ 注释里的条目不算（旧实现 includes 子串匹配 → 这里会误绿）
  //    刻意补一条「源里没有的」地址把条数补回 18：把「注释不算数」这条判据与
  //    「下界」解耦，否则下界先红，就分不清是哪个判据在生效了。
  {
    const py = plain(ADD).map((e, i) => (i === 5 ? { ...e, commented: true } : e));
    py.push({ addr: "192.0.2.1" });
    subprocess("③ 镜像侧被注释掉的条目不算已同步 → 红（下界不触发）", ssrfTree({ pyEntries: py }), {
      code: 1,
      contains: ["未对齐", ADD[5], "缺在 executor-python"],
      absent: ["缺在 executor-node", "已对齐"],
    });
  }

  // ④ 条目数下界：表被清空成「零差异」→ 必须红（旧实现唯一的误绿路径）
  {
    const tiny = ADD.slice(0, 3);
    subprocess("④ 三侧只剩 3 条（零差异但表被掏空）→ 下界红", ssrfTree({ srcAddrs: tiny, nodeEntries: plain(tiny), pyEntries: plain(tiny) }), {
      code: 1,
      contains: ["结构错误", "实测下界 18", "admin-api 矩阵只解析到 3 条"],
      absent: ["已对齐"],
    });
  }

  // ⑤ 反向不校验（既有语义，不许悄悄变红）：镜像侧多一条 → 仍绿
  {
    const extraNode = [...ADD, "10.0.42.1"];
    subprocess("⑤ 镜像侧多一条（比源更严）→ 仍绿（反向不校验）", ssrfTree({ nodeEntries: plain(extraNode) }), {
      code: 0,
      contains: ["已对齐", "executor-node 19"],
      absent: ["未对齐"],
    });
  }

  // ⑥ 镜像侧的表被整块注释/清空 → 结构性红（不能只靠「源侧也有下界」兜着）
  subprocess("⑥ 镜像侧 deny 表被清空 → 结构性红（不是靠源侧下界兜）", ssrfTree({ nodeEntries: [] }), {
    code: 1,
    contains: ["结构错误", "executor-node 的 deny 表只解析到 0 条"],
    absent: ["已对齐"],
  });

  const failed = reportCases(cases, { title: "check-ssrf-deny-parity selftest" });
  if (failed > 0) process.exit(1);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  if (process.argv.includes("--selftest")) runSelftest();
  else main();
}
