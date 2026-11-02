#!/usr/bin/env node
// check-doc-style.mjs 的有齿自检。
//
// 原则与仓内其它守卫一致：**每条用例都必须能失败**。正例用一个真实形状的
// 最小仓库（能通过），每条负例只破坏一个维度（必须红），并断言报错文本里
// 能看出「是哪条判据、哪个文件、哪一行」——只断言退出码会漏掉「红错了地方」。
//
// 运行：node scripts/docs/check-doc-style.selftest.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeFixtureRepo, reportCases } from "../lib/guard-selftest.mjs";
import {
  checkHeading,
  checkFreshness,
  checkFenceLang,
  listMarkdown,
  scanStructure,
  MIN_MD_FILES,
} from "./check-doc-style.mjs";

/** 搭一个满足 MIN_MD_FILES 的最小仓库：1 篇真实内容 + 若干占位文档。 */
function repo(files, { filler = true } = {}) {
  const all = { ...files };
  if (filler) {
    // 占位文档只用于把扫描面抬过下界；内容合规，不会产生额外违规。
    for (let i = 0; i < MIN_MD_FILES; i += 1) {
      const rel = `docs/filler/f-${String(i).padStart(3, "0")}.md`;
      if (!(rel in all)) all[rel] = "# filler\n\n> 最后核对：2026-01-01\n\ntext\n";
    }
  }
  return makeFixtureRepo(all);
}

const GOOD = `# 标题

> **受众**：开发者 · **状态**：稳定 · **最后核对**：2026-11-02

正文。

\`\`\`bash
echo hi
\`\`\`
`;

const cases = [];
const add = (name, fn) => cases.push({ name, fn });

// ── scanStructure：围栏感知 ────────────────────────────────────────────
add("scanStructure：代码块里的 # 不算标题、| 不算空表格行", () => {
  const s = scanStructure("# T\n\n```text\n# not a heading\n|\n```\n");
  assert.deepEqual(s.headings.map((h) => h.level), [1]);
  assert.deepEqual(s.emptyTableRows, []);
});

add("scanStructure：能识别围栏语言，未标语言时 lang 为空串", () => {
  const s = scanStructure("```bash\nls\n```\n\n```\nx\n```\n");
  assert.deepEqual(s.fenceOpens.map((f) => f.lang), ["bash", ""]);
});

// ── 判据 ①：结构 ──────────────────────────────────────────────────────
add("结构：合规文档 → 0 报错", () => {
  const r = repo({ "docs/a.md": GOOD });
  try {
    assert.deepEqual(checkHeading(r.dir), []);
  } finally {
    r.cleanup();
  }
});

add("结构：两个 H1 → 报错（README 三语切片豁免）", () => {
  const r = repo({ "docs/a.md": "# A\n\ntext\n\n# B\n\ntext\n" });
  try {
    const errors = checkHeading(r.dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /docs\/a\.md/);
    assert.match(errors[0], /2 个 H1/);
  } finally {
    r.cleanup();
  }
});

add("结构：README.md 出现两个 H1 → 豁免（双语切片）", () => {
  const r = repo({ "README.md": "# EN\n\ntext\n\n# 中文\n\ntext\n" });
  try {
    assert.deepEqual(checkHeading(r.dir), []);
  } finally {
    r.cleanup();
  }
});

add("结构：缺 H1 → 报错", () => {
  const r = repo({ "docs/a.md": "text only\n\n## H2\n" });
  try {
    const errors = checkHeading(r.dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /没有 H1/);
  } finally {
    r.cleanup();
  }
});

add("结构：H2 → H4 跳级 → 报错", () => {
  const r = repo({ "docs/a.md": "# T\n\n## A\n\n#### B\n" });
  try {
    const errors = checkHeading(r.dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /H2 跳到 H4/);
  } finally {
    r.cleanup();
  }
});

add("结构：空表格行 → 报错", () => {
  const r = repo({ "docs/a.md": "# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n|\n" });
  try {
    const errors = checkHeading(r.dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /空表格行/);
  } finally {
    r.cleanup();
  }
});

add("结构：扫描面塌了（文件数 < 下界）→ 结构红，不是「零违规全绿」", () => {
  const r = repo({ "docs/a.md": GOOD }, { filler: false });
  try {
    const errors = checkHeading(r.dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /扫描面塌了/);
  } finally {
    r.cleanup();
  }
});

// ── 判据 ②：新鲜度 ────────────────────────────────────────────────────
add("新鲜度：USER_FACING 文档无日期标记 → 报错", () => {
  const r = repo({ "docs/quickstart.md": "# 快速上手\n\ntext\n" });
  try {
    const errors = checkFreshness(r.dir, ["docs/quickstart.md"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /docs\/quickstart\.md/);
    assert.match(errors[0], /最后核对/);
  } finally {
    r.cleanup();
  }
});

add("新鲜度：有「最后更新」也算（不只认「最后核对」）", () => {
  const r = repo({ "docs/quickstart.md": "# 快速上手\n\n> 最后更新：2026-11-02\n" });
  try {
    assert.deepEqual(checkFreshness(r.dir, ["docs/quickstart.md"]), []);
  } finally {
    r.cleanup();
  }
});

add("新鲜度：USER_FACING 列出的文件不存在 → 结构红（判据面消失）", () => {
  const r = repo({});
  try {
    const errors = checkFreshness(r.dir, ["docs/quickstart.md"]);
    assert.ok(errors.some((e) => e.includes("docs/quickstart.md") && e.includes("不存在")));
  } finally {
    r.cleanup();
  }
});

// ── 判据 ③：围栏语言 ──────────────────────────────────────────────────
add("围栏语言：全部标了语言 → 0 报错", () => {
  const r = repo({ "docs/a.md": GOOD });
  try {
    assert.deepEqual(checkFenceLang(r.dir), []);
  } finally {
    r.cleanup();
  }
});

add("围栏语言：裸围栏 → 报错并给出行号", () => {
  const r = repo({ "docs/a.md": "# T\n\n```\nx\n```\n" });
  try {
    const errors = checkFenceLang(r.dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /docs\/a\.md/);
    assert.match(errors[0], /行 3/);
  } finally {
    r.cleanup();
  }
});

add("围栏语言：归档区裸围栏 → 豁免（历史证据不重写）", () => {
  const r = repo({ "docs/archive/x.md": "# T\n\n```\nraw evidence\n```\n" });
  try {
    assert.deepEqual(checkFenceLang(r.dir), []);
  } finally {
    r.cleanup();
  }
});

add("围栏语言：ADR 裸围栏 → 不再豁免（判据真实生效）", () => {
  const r = repo({ "docs/adr/adr-999.md": "# T\n\n```\nx\n```\n" });
  try {
    const errors = checkFenceLang(r.dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /docs\/adr\/adr-999\.md/);
  } finally {
    r.cleanup();
  }
});

// ── listMarkdown：跳过规则 ────────────────────────────────────────────
add("listMarkdown：跳过 node_modules / .git / dist / .venv", () => {
  const r = repo({
    "docs/a.md": "# a\n",
    "node_modules/x/README.md": "# x\n",
    "dist/y.md": "# y\n",
    ".venv/z.md": "# z\n",
  });
  try {
    const files = listMarkdown(r.dir);
    assert.ok(files.includes("docs/a.md"));
    assert.ok(!files.some((f) => f.startsWith("node_modules/")));
    assert.ok(!files.some((f) => f.startsWith("dist/")));
    assert.ok(!files.some((f) => f.startsWith(".venv/")));
  } finally {
    r.cleanup();
  }
});

// 夹具自检：GOOD 本身必须真的合规，否则正例是假绿。
add("夹具自检：GOOD 文档三项判据都通过", () => {
  const r = repo({ "docs/quickstart.md": GOOD, "docs/a.md": GOOD });
  try {
    assert.deepEqual(checkHeading(r.dir), []);
    assert.deepEqual(checkFreshness(r.dir, ["docs/quickstart.md"]), []);
    assert.deepEqual(checkFenceLang(r.dir), []);
  } finally {
    r.cleanup();
  }
});

const failed = reportCases(cases, { title: "check-doc-style 自检" });
process.exit(failed > 0 ? 1 : 0);
