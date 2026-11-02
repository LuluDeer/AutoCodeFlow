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
  inspectFreshness,
  MIN_MD_FILES,
  MIN_ATLAS_FILES,
} from "./check-doc-style.mjs";

/** 搭一个满足 MIN_MD_FILES 的最小仓库：1 篇真实内容 + 若干占位文档。 */
function repo(files, { filler = true, atlas = false } = {}) {
  const all = { ...files };
  if (filler) {
    // 占位文档只用于把扫描面抬过下界；内容合规，不会产生额外违规。
    for (let i = 0; i < MIN_MD_FILES; i += 1) {
      const rel = `docs/filler/f-${String(i).padStart(3, "0")}.md`;
      if (!(rel in all)) all[rel] = "# filler\n\n> 最后核对：2026-01-01\n\ntext\n";
    }
  }
  if (atlas) {
    // atlas 是**目录级**扫描面，有独立下界：不足下界即结构红，
    // 所以负例必须先把这个面填满，才谈得上「这一篇不合规」。
    for (let i = 0; i < MIN_ATLAS_FILES; i += 1) {
      const rel = `docs/atlas/filler/a-${String(i).padStart(3, "0")}.md`;
      if (!(rel in all)) all[rel] = "# atlas 页\n\n> 所属: docs/atlas/filler · 最后核对: 2026-01-01\n\ntext\n";
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
    const errors = checkFreshness(r.dir, ["docs/quickstart.md"], []);
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
    assert.deepEqual(checkFreshness(r.dir, ["docs/quickstart.md"], []), []);
  } finally {
    r.cleanup();
  }
});

add("新鲜度：USER_FACING 列出的文件不存在 → 结构红（判据面消失）", () => {
  const r = repo({});
  try {
    const errors = checkFreshness(r.dir, ["docs/quickstart.md"], []);
    assert.ok(errors.some((e) => e.includes("docs/quickstart.md") && e.includes("不存在")));
  } finally {
    r.cleanup();
  }
});

// ── 判据 ②：日期形状（2026-11-02 扩面到 docs/atlas/**）────────────────
//
// 这些用例存在的理由：扩面前，判据只看「文件里有没有『最后核对』这几个字」，
// 于是 `2026-09（P4）`（月粒度）与「正文里提到这个词」都能过。扩面本身不会让
// 判据变强——**变强靠的正是下面这几条会红的负例**。
add("新鲜度：月粒度 2026-09（P4）→ 红（标记必须到日）", () => {
  const r = repo(
    { "docs/atlas/x.md": "# X\n\n> 所属: docs/atlas · 最后核对: 2026-09（P4） · 对应代码: a\n\n正文\n" },
    { atlas: true },
  );
  try {
    const errors = checkFreshness(r.dir, [], ["docs/atlas/"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /docs\/atlas\/x\.md/);
    assert.match(errors[0], /没有到日/);
    assert.match(errors[0], /2026-09/);
  } finally {
    r.cleanup();
  }
});

add("新鲜度：atlas 行内格式 2026-09-13 → 绿（不误伤存量写法）", () => {
  const r = repo(
    { "docs/atlas/x.md": "# X\n\n> 所属: docs/atlas · 最后核对: 2026-09-13 · 对应代码: a\n\n正文\n" },
    { atlas: true },
  );
  try {
    assert.deepEqual(checkFreshness(r.dir, [], ["docs/atlas/"]), []);
  } finally {
    r.cleanup();
  }
});

add("新鲜度：日期格式对但日历上不存在（2026-02-30）→ 红", () => {
  const r = repo({ "docs/quickstart.md": "# Q\n\n> 最后核对：2026-02-30\n" });
  try {
    const errors = checkFreshness(r.dir, ["docs/quickstart.md"], []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /不是合法日历日/);
  } finally {
    r.cleanup();
  }
});

add("新鲜度：日期在未来 → 红（核对日期不能超前）", () => {
  const r = repo({ "docs/quickstart.md": "# Q\n\n> 最后核对：2099-01-01\n" });
  try {
    const errors = checkFreshness(r.dir, ["docs/quickstart.md"], []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /在未来/);
  } finally {
    r.cleanup();
  }
});

add("新鲜度：正文提到「最后核对」四个字 ≠ 声明 → 红", () => {
  const prose = '# Atlas\n\n> 2. 改动代码时同步更新对应文档的"最后核对"日期。\n';
  const r = repo({ "docs/atlas/README.md": prose });
  try {
    const errors = checkFreshness(r.dir, ["docs/atlas/README.md"], []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /没有到日/);
    assert.match(errors[0], /最后核对"日期/, "报错要引到那句话本身，作者才知道改哪");
  } finally {
    r.cleanup();
  }
  // 同一段正文前加一行真标记 → 变绿（正文提及不是合规声明，也不该被惩罚）
  const r2 = repo({
    "docs/atlas/README.md": `# Atlas\n\n> **最后更新**：2026-01-01\n${prose.split("\n").slice(2).join("\n")}`,
  });
  try {
    assert.deepEqual(checkFreshness(r2.dir, ["docs/atlas/README.md"], []), []);
  } finally {
    r2.cleanup();
  }
});

add("新鲜度：模板占位符（围栏内的 YYYY-MM-DD）不误伤已合规的文件", () => {
  // 实测形状照抄 docs/atlas/08-workflows/*/TEMPLATE.md：文首有真标记，
  // 正文的 ```markdown 里还有一个待填槽位 `最后核对: YYYY-MM-DD`。
  // 判据是「至少一处声明带到日的日期」，因此不该因为模板槽位判红。
  const r = repo({
    "docs/atlas/t.md": [
      "# 模板",
      "",
      "> 所属: docs/atlas · 最后核对: 2026-09-13",
      "",
      "````markdown",
      "> 最后核对: YYYY-MM-DD · 对应代码: <主要嫌疑路径>",
      "````",
      "",
    ].join("\n"),
  });
  try {
    assert.deepEqual(checkFreshness(r.dir, ["docs/atlas/t.md"], []), []);
  } finally {
    r.cleanup();
  }
  // 但「只有占位符、没有真日期」必须红（否则模板会把判据洗绿）
  const r2 = repo({
    "docs/atlas/t.md": "# 模板\n\n> 最后核对: YYYY-MM-DD\n",
  });
  try {
    const errors = checkFreshness(r2.dir, ["docs/atlas/t.md"], []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /没有到日/);
  } finally {
    r2.cleanup();
  }
});

add("新鲜度：只有围栏里的「示例日期」→ 红（示例不是声明）", () => {
  // 反证：若判据不围栏感知，一篇「正文没有任何标记、只在 ```markdown 里示范了格式」
  // 的文档会被洗绿——而它恰恰是最需要被提醒去写标记的那种文档。
  const r = repo({
    "docs/atlas/t.md": [
      "# 模板说明",
      "",
      "标头这样写：",
      "",
      "```markdown",
      "> **最后核对**：2026-01-01",
      "```",
      "",
    ].join("\n"),
  });
  try {
    const errors = checkFreshness(r.dir, ["docs/atlas/t.md"], []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /缺少「最后核对/);
  } finally {
    r.cleanup();
  }
});

add("新鲜度：atlas 目录扫描面塌陷（不足下界）→ 结构红", () => {
  const r = repo({ "docs/atlas/x.md": "# X\n\n> 所属: docs/atlas · 最后核对: 2026-09-13\n" });
  try {
    const errors = checkFreshness(r.dir, [], ["docs/atlas/"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /扫描面塌了/);
    assert.match(errors[0], /docs\/atlas\//);
  } finally {
    r.cleanup();
  }
});

add("新鲜度：atlas 面 100 篇合规 + 1 篇月粒度 → 只报那一篇（不拿合规篇垫背）", () => {
  const r = repo(
    { "docs/atlas/bad.md": "# B\n\n> 所属: docs/atlas · 最后核对: 2026-09（P1）\n" },
    { atlas: true },
  );
  try {
    const errors = checkFreshness(r.dir, [], ["docs/atlas/"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /docs\/atlas\/bad\.md/);
    assert.ok(!errors.some((e) => e.includes("filler")));
  } finally {
    r.cleanup();
  }
});

add("inspectFreshness：五种形态可区分（含英文写法）", () => {
  const today = "2026-11-02";
  assert.deepEqual(inspectFreshness("> 最后核对：2026-11-02", today), { ok: true, iso: "2026-11-02" });
  assert.equal(inspectFreshness("> 最后核对：2026-11-03", today).kind, "date-future");
  assert.equal(inspectFreshness("> 最后核对：2026-02-30", today).kind, "date-invalid");
  assert.equal(inspectFreshness("> 最后核对：2026-09", today).kind, "date-missing");
  // 有这个词但没到日的日期 → date-missing；连词都没有 → marker-missing
  assert.equal(inspectFreshness("正文提到最后核对，但没写日期", today).kind, "date-missing");
  assert.equal(inspectFreshness("只有正文，没有任何日期声明", today).kind, "marker-missing");
  assert.deepEqual(inspectFreshness("Last updated: 2026-10-01", today), { ok: true, iso: "2026-10-01" });
  // 关键边界：月粒度**后面**跟着别的日期，不能算数（那日期属于另一个字段）
  assert.equal(
    inspectFreshness("> 最后核对: 2026-09（P4） · 对应代码: 2026-01-01", today).kind,
    "date-missing",
  );
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
    assert.deepEqual(checkFreshness(r.dir, ["docs/quickstart.md"], []), []);
    assert.deepEqual(checkFenceLang(r.dir), []);
  } finally {
    r.cleanup();
  }
});

const failed = reportCases(cases, { title: "check-doc-style 自检" });
process.exit(failed > 0 ? 1 : 0);
