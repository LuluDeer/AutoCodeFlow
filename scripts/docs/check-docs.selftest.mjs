#!/usr/bin/env node
// check-docs.mjs 的有齿自检。
//
// 目的：守卫本身不能腐烂。每个用例在临时目录里搭一个**最小仓库**，
// 断言判据在「该红」时真的红、在「该绿」时真的绿。全部用例必须通过，
// 否则 `npm run test:docs` 失败。
//
// 运行：node scripts/docs/check-docs.selftest.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkLinks,
  checkOrphans,
  checkRootHygiene,
  checkBarePaths,
  checkReadmeSync,
  README_SYNC,
  checkAdrStructure,
  checkReleaseNotesSections,
  RELEASE_NOTES_SECTIONS,
} from "./check-docs.mjs";
import { expectRequiredFixtures } from "../lib/guard-selftest.mjs";

let passed = 0;
const failures = [];

/** 在临时目录搭一个仓库：files = { 相对路径: 内容 } */
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acf-docs-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures.push([name, err]);
    console.log(`  ✘ ${name}\n      ${err.message.split("\n")[0]}`);
  }
}

console.log("check-docs 自检：");

// ── 判据 ①：死链 ─────────────────────────────────────────────────────────
test("死链：指向不存在的文件 → 报错", () => {
  const dir = fixture({
    "docs/README.md": "# x\n\n[a](missing.md)\n",
  });
  const errors = checkLinks(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing\.md/);
});

test("死链：相对路径存在 → 通过", () => {
  const dir = fixture({
    "docs/README.md": "# x\n\n[a](guide.md)\n",
    "docs/guide.md": "# g\n",
  });
  assert.deepEqual(checkLinks(dir), []);
});

test("死链：无扩展名约定补 .md → 通过", () => {
  const dir = fixture({
    "docs/README.md": "# x\n\n[a](guide)\n",
    "docs/guide.md": "# g\n",
  });
  assert.deepEqual(checkLinks(dir), []);
});

test("死链：目录下有 README.md → 通过", () => {
  const dir = fixture({
    "docs/README.md": "# x\n\n[a](atlas/)\n",
    "docs/atlas/README.md": "# a\n",
  });
  assert.deepEqual(checkLinks(dir), []);
});

test("死链：目录下既无 README 也无 index → 报错", () => {
  const dir = fixture({
    "docs/README.md": "# x\n\n[a](atlas/)\n",
    "docs/atlas/page.md": "# p\n",
  });
  assert.equal(checkLinks(dir).length, 1);
});

test("死链：外链与纯锚点不参与检查", () => {
  const dir = fixture({
    "docs/README.md": "# x\n\n[a](https://example.com/x.md) [b](#section)\n",
  });
  assert.deepEqual(checkLinks(dir), []);
});

test("死链：锚点后缀不影响解析", () => {
  const dir = fixture({
    "docs/README.md": "# x\n\n[a](guide.md#part)\n",
    "docs/guide.md": "# g\n",
  });
  assert.deepEqual(checkLinks(dir), []);
});

test("死链：围栏代码块里的链接不检查（代码块不渲染 Markdown）", () => {
  const BACKTICK3 = String.fromCharCode(96).repeat(3);
  const dir = fixture({
    "docs/README.md":
      "# x\n\n" +
      BACKTICK3 +
      "\n$ grep CHANGELOG\npkg/CHANGELOG.md:3:## [1.9.0](…compare/v1.8.0...v1.9.0) (2026-10-07)\n" +
      BACKTICK3 +
      "\n",
  });
  // 假红会让守卫逼作者篡改审计证据原文——这是本轮实测踩到的形态（sdk-dx.md）。
  assert.deepEqual(checkLinks(dir), []);
});

test("死链：代码块结束后的正文链接仍然检查（不能整篇跳过）", () => {
  const BACKTICK3 = String.fromCharCode(96).repeat(3);
  const dir = fixture({
    "docs/README.md":
      "# x\n\n" +
      BACKTICK3 +
      "\n[ok](…compare/v1.9.0...v1.10.0)\n" +
      BACKTICK3 +
      "\n\n[bad](missing.md)\n",
  });
  const errors = checkLinks(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing\.md/);
});

// ── 判据 ②：孤儿 ─────────────────────────────────────────────────────────
test("孤儿：从入口走不到的 docs 文档 → 报错", () => {
  const dir = fixture({
    "docs/README.md": "# x\n",
    "README.md": "# root\n",
    "docs/orphan.md": "# o\n",
  });
  const orphans = checkOrphans(dir);
  assert.deepEqual(orphans, ["docs/orphan.md"]);
});

test("孤儿：入口链到的文档不算孤儿（含多跳）", () => {
  const dir = fixture({
    "docs/README.md": "# x\n\n[a](a.md)\n",
    "README.md": "# root\n",
    "docs/a.md": "# a\n\n[b](b.md)\n",
    "docs/b.md": "# b\n",
  });
  assert.deepEqual(checkOrphans(dir), []);
});

test("孤儿：docs/archive/ 豁免", () => {
  const dir = fixture({
    "docs/README.md": "# x\n",
    "README.md": "# root\n",
    "docs/archive/old.md": "# old\n",
  });
  assert.deepEqual(checkOrphans(dir), []);
});

// ── 判据 ③：根目录洁癖 ───────────────────────────────────────────────────
test("根目录：白名单外的 md → 报错", () => {
  const dir = fixture({
    "README.md": "# x\n",
    "FINAL-SUMMARY.md": "# y\n",
  });
  const errors = checkRootHygiene(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /FINAL-SUMMARY\.md/);
});

test("根目录：白名单内的 md → 通过", () => {
  const dir = fixture({
    "README.md": "# x\n",
    "CHANGELOG.md": "# c\n",
    "CONTRIBUTING.md": "# c\n",
    "SECURITY.md": "# s\n",
  });
  assert.deepEqual(checkRootHygiene(dir), []);
});

test("根目录：README.en.md / README.zh.md 是构建产物，放行", () => {
  const dir = fixture({
    "README.md": "# x\n",
    "README.en.md": "# en\n",
    "README.zh.md": "# zh\n",
  });
  assert.deepEqual(checkRootHygiene(dir), []);
});

test("根目录：子目录里的 md 不受洁癖检查影响", () => {
  const dir = fixture({
    "README.md": "# x\n",
    "docs/FINAL-SUMMARY.md": "# y\n",
  });
  assert.deepEqual(checkRootHygiene(dir), []);
});

// ── 判据 ④：正文裸路径指针 ───────────────────────────────────────────────
// 这一组的每条反例都对应一次真实误报/漏报：省略号与花括号简写是作者主动的
// 写法约定（强行展开只会让作者放弃写指针），文档内相对路径若按仓库根解析会
// 把 apps/admin-web 的 scripts/lhci-serve.cjs 判成死指针。
const BACKTICK = String.fromCharCode(96);
const code = (s) => BACKTICK + s + BACKTICK;
const fence = (s) => BACKTICK + BACKTICK + BACKTICK + "\n" + s + "\n" + BACKTICK + BACKTICK + BACKTICK;

test("裸路径：行内路径指向不存在的文件 → 报错", () => {
  const dir = fixture({
    "docs/README.md": "# x\n\n见 " + code("scripts/gone.mjs") + "\n",
  });
  const errors = checkBarePaths(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /scripts\/gone\.mjs/);
});

test("裸路径：行内路径存在 → 通过", () => {
  const dir = fixture({
    "docs/README.md": "# x\n\n见 " + code("scripts/here.mjs") + "\n",
    "scripts/here.mjs": "// x\n",
  });
  assert.deepEqual(checkBarePaths(dir), []);
});

test("裸路径：文档内相对路径（按文档目录解析）→ 通过", () => {
  const dir = fixture({
    "apps/web/notes.md": "见 " + code("scripts/serve.cjs") + "\n",
    "apps/web/scripts/serve.cjs": "// x\n",
  });
  assert.deepEqual(checkBarePaths(dir), []);
});

test("裸路径：围栏代码块里的路径不检查", () => {
  const dir = fixture({
    "docs/README.md": "# x\n\n" + fence("node " + code("scripts/not-real.mjs")) + "\n",
  });
  assert.deepEqual(checkBarePaths(dir), []);
});

test("裸路径：花括号简写与省略号豁免", () => {
  const dir = fixture({
    "docs/README.md":
      "# x\n\n" +
      code("apps/executor-node/src/{callback,config}.ts") +
      " 与 " +
      code("docs/atlas/…/audit.md") +
      " 与 " +
      code("apps/admin-api/.../x.spec.ts") +
      "\n",
  });
  assert.deepEqual(checkBarePaths(dir), []);
});

test("裸路径：docs/archive/ 源文件整体豁免（历史快照不改写）", () => {
  const dir = fixture({
    "docs/archive/old.md": "见 " + code("scripts/deleted-long-ago.mjs") + "\n",
  });
  assert.deepEqual(checkBarePaths(dir), []);
});

test("裸路径：普通行内代码（非仓库路径）不误报", () => {
  const dir = fixture({
    "docs/README.md": "# x\n\n" + code("npm run test:api") + " " + code("ConfigService") + "\n",
  });
  assert.deepEqual(checkBarePaths(dir), []);
});

// ── 扫描面：artifacts/ 是 .gitignore 里的本地草稿，不参与判据（R2-3a-2）──────
//
// 这两条是**一组**，缺一条都不算有牙：
//   · 正例（豁免真的生效）：同样的坏指针放在 artifacts/ 下 ⇒ 不红；
//   · 反例（豁免没把判据整体弄哑）：一模一样的坏指针放在 docs/ 下 ⇒ 必须红。
// 只写正例会得到一个「把扫描面砍光也能过」的假绿守卫——那正是本次要修的问题的镜像。
test("裸路径：artifacts/ 下的坏指针不报（gitignored 草稿不在仓库里）", () => {
  const dir = fixture({
    "artifacts/rounds/report.md":
      "# 轮次报告\n\n见 " + code("packages/modules/order/src/services/order-service.ts") + "\n",
  });
  assert.deepEqual(checkBarePaths(dir), []);
});

test("裸路径：同一坏指针放在 docs/ 下仍必须报（证明豁免没弄哑判据）", () => {
  const bad = code("packages/modules/order/src/services/order-service.ts");
  const skipped = fixture({ "artifacts/rounds/report.md": "# r\n\n见 " + bad + "\n" });
  const scanned = fixture({ "docs/guide.md": "# g\n\n见 " + bad + "\n" });
  assert.deepEqual(checkBarePaths(skipped), []);
  const errors = checkBarePaths(scanned);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /docs\/guide\.md/);
  assert.match(errors[0], /order-service\.ts/);
});

// 死链判据共用同一份 listMarkdown（同一张 SKIP_DIR），故一并钉住：
// artifacts/ 里的 Markdown 链接同样不该产生死链红。
test("死链：artifacts/ 下的坏 Markdown 链接不报（与裸路径同源豁免）", () => {
  const dir = fixture({
    "artifacts/rounds/report.md": "# r\n\n[证据](other-repo/path.ts)\n",
  });
  assert.deepEqual(checkLinks(dir), []);
});

// ── 判据 ⑤：README 三语切片一致性 ─────────────────────────────────────────
// fixture 的「期望产物」**手写**（不复用实现里的 `expectedReadmeProduct`）：
// 用被测代码造期望值，等于让实现自己给自己出题——切片边界错了也照样绿。
const README_MD =
  [
    "# T",
    "",
    '<a name="english"></a>',
    "",
    "# T (EN)",
    "",
    '<a name="chinese"></a>',
    "",
    "# T（中文）",
  ].join("\n") + "\n";
const FOOTER_EN = "📖 **[查看中文版](README.md#chinese) | View Chinese Version**";
const FOOTER_ZH = "📖 **[View English Version](README.md#english) | 查看英文版**";
// en 切片含 chinese 锚点**之前**那个空行（awk 会 print 它），所以 `---` 前是两个空行。
const README_EN_OK =
  ['<a name="english"></a>', "", "# T (EN)", "", "", "---", "", FOOTER_EN].join("\n") + "\n";
const README_ZH_OK =
  ['<a name="chinese"></a>', "", "# T（中文）", "", "---", "", FOOTER_ZH].join("\n") + "\n";

const readmeFixture = (overrides = {}) =>
  fixture({
    "README.md": README_MD,
    "README.en.md": README_EN_OK,
    "README.zh.md": README_ZH_OK,
    ...overrides,
  });

test("三语切片：产物与 README.md 切片 + 尾注一致 → 通过（正例控制组）", () => {
  assert.deepEqual(checkReadmeSync(readmeFixture()), []);
});

test("三语切片：产物多一行（手改/上一次生成的残留）→ 报错", () => {
  const dir = readmeFixture({ "README.en.md": README_EN_OK + "手改的一行\n" });
  const errors = checkReadmeSync(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /README\.en\.md/);
  assert.match(errors[0], /第 \d+ 行起不同/);
});

test("三语切片：产物少一行 → 报错", () => {
  const dir = readmeFixture({ "README.en.md": README_EN_OK.replace("# T (EN)\n", "") });
  const errors = checkReadmeSync(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /README\.en\.md/);
});

test("三语切片：改了 README.md 忘了重跑生成（产物停在旧内容）→ 报错", () => {
  const dir = readmeFixture({
    "README.md": README_MD.replace("# T (EN)", "# T (EN)\n\n新增的一段英文说明"),
  });
  const errors = checkReadmeSync(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /README\.en\.md/);
  assert.match(errors[0], /重跑 readme-sync/);
});

test("三语切片：产物缺失 → 报错（不是「没有文件要检查」）", () => {
  const dir = readmeFixture();
  fs.rmSync(path.join(dir, "README.zh.md"));
  const errors = checkReadmeSync(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /README\.zh\.md 缺失/);
});

test("三语切片：手改产物尾注（链接被改）→ 报错", () => {
  const dir = readmeFixture({
    "README.zh.md": README_ZH_OK.replace("README.md#english", "README.en.md"),
  });
  const errors = checkReadmeSync(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /README\.zh\.md/);
});

test("三语切片：README.md 里缺切片起点 → 报错（awk 会产出空文件）", () => {
  const dir = readmeFixture({
    "README.md": "# T\n\n没有英文/中文锚点的 README\n",
  });
  const errors = checkReadmeSync(dir);
  assert.equal(errors.length, README_SYNC.targets.length);
  assert.match(errors[0], /找不到切片起点/);
});

// ── CLI 黑盒：失败必须**以失败收尾** ─────────────────────────────────────
//
// 为什么这三条放在函数级用例之后：前面 33 条都只断言「errors 数组对不对」，
// 而真正害人的失效模式在**报告面**，不在判据面。
//
// 2026-11-05（R02）实测：`npm run test:guards:repo` 是 85 段 `&&` 链，第一段
// `test:docs` 因孤儿文档失败时整链正确中断（exit=1），但**可见的最后 4 行是 ✔**
// ——旧 main() 按 CHECKS 声明顺序逐条打印，失败的「孤儿文档」排第 2，后面 3 条
// 通过的判据继续打 ✔，且没有终态摘要行。人/agent 读尾部 → 判绿。
// 判据：① 失败时最后一行必须是 ✘ 终态摘要；② ✘ 之后不许再出现 ✔；
// ③ 全绿时最后一行必须是 ✔ 终态摘要（正例控制组，防止「永远打 ✘」也能骗过 ①②）。

const CLI = fileURLToPath(new URL("./check-docs.mjs", import.meta.url));

function runCli(argv) {
  const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test("CLI：有孤儿文档 → exit 1，且**最后一行是 ✘ 终态**（链断不许以 ✔ 收尾）", () => {
  const dir = fixture({
    "docs/README.md": "# 入口\n\n没有任何链接\n",
    "docs/orphan.md": "# 走不到\n",
  });
  const { code, out } = runCli([`--root=${dir}`, "--only=links,orphans,root-hygiene"]);
  const lines = out.trimEnd().split("\n").filter((l) => l.trim());
  assert.equal(code, 1, "失败必须 exit 1（真实退出码，不看输出措辞）");
  assert.match(
    lines.at(-1),
    /^✘ 判据失败：1\/3 项/,
    `最后一行必须是失败终态摘要，实际是：${JSON.stringify(lines.at(-1))}`,
  );
});

test("CLI：✘ 之后不再出现 ✔（旧实现正是这样把失败埋掉）", () => {
  const dir = fixture({
    "docs/README.md": "# 入口\n\n没有任何链接\n",
    "docs/orphan.md": "# 走不到\n",
  });
  const { out } = runCli([`--root=${dir}`, "--only=links,orphans,root-hygiene"]);
  const lines = out.trimEnd().split("\n").filter((l) => l.trim());
  const firstFail = lines.findIndex((l) => l.startsWith("✘"));
  assert.ok(firstFail >= 0, "该红的树必须出现 ✘");
  const greenAfterRed = lines.slice(firstFail).filter((l) => l.startsWith("✔"));
  assert.deepEqual(greenAfterRed, [], `✘ 之后仍然打 ✔：${JSON.stringify(greenAfterRed)}`);
});

test("CLI：全绿 → exit 0，且最后一行是 ✔ 终态（正例控制组）", () => {
  const dir = fixture({
    "docs/README.md": "# 入口\n\n[a](a.md)\n",
    "docs/a.md": "# a\n\n[回来](README.md)\n",
  });
  const { code, out } = runCli([`--root=${dir}`, "--only=links,orphans,root-hygiene"]);
  const lines = out.trimEnd().split("\n").filter((l) => l.trim());
  assert.equal(code, 0);
  assert.match(lines.at(-1), /^✔ 判据全过：3\/3 项/);
});

// ── R61：ADR 结构判据（R60/A 新加）的两条反例 + 必需项绑定 ────────────────
//
// 为什么必须有反例：R49/R58 两次事故都是"守卫有正例没反例/夹具没同步" ⇒ 链内红而单独绿。
// 这里用 `expectRequiredFixtures()` 把「夹具必须覆盖每条必需项」也变成断言（R59 的助手首次用于 check-docs）。
const ADR_OK = `# ADR-099 · 示例

状态：Proposed

## 1. 动机
见 \`apps/admin-api/src/x.ts:10\` 与 \`apps/admin-api/src/y.ts:20\` 与 \`apps/admin-api/src/z.ts:30\`。

## 2. 方案
方案正文。

## 3. 影响面
影响面正文。

## 4. 回滚
回滚正文。

## 5. 分步计划
分步正文。

## 6. 明确不做
明确不做正文。
`;
const ADR_README_OK = "| [ADR-099](adr-099-demo.md) | 示例 |\n";

/** 必需项（与 check-docs 的 REQUIRED_SECTIONS 同源）—— 夹具必须逐条覆盖。 */
const ADR_REQUIRED_SECTIONS = ["动机", "方案", "影响面", "回滚", "分步计划", "明确不做"];

{
  const name = "R61·ADR 结构判据：夹具覆盖全部六个必需小节（expectRequiredFixtures 绑定）";
  try {
    const miss = expectRequiredFixtures(
      ADR_REQUIRED_SECTIONS.map((k) => ({ id: k, re: new RegExp(`##[^\\n]*${k}`) })),
      ADR_OK,
    );
    assert.deepEqual(miss, [], `夹具未覆盖：${miss.join("；")}`);
    passed += 1;
  } catch (err) {
    failures.push([name, err]);
  }
}

{
  const name = "R61·ADR 结构判据反例①：删「回滚」小节 ⇒ 必须红且点名";
  try {
    const dir = fixture({
      "docs/adr/README.md": ADR_README_OK,
      "docs/adr/adr-099-demo.md": ADR_OK.replace("## 4. 回滚\n回滚正文。\n", ""),
    });
    const errors = checkAdrStructure(dir);
    assert.equal(errors.length > 0, true, "删小节后仍然绿 ⇒ 判据没牙");
    assert.match(errors.join("\n"), /回滚/, "报错没有点名缺失小节");
    passed += 1;
  } catch (err) {
    failures.push([name, err]);
  }
}

{
  const name = "R61·ADR 结构判据反例②：删 README 索引行 ⇒ 必须红且点名";
  try {
    const dir = fixture({
      "docs/adr/README.md": "| [ADR-098](adr-098-other.md) | 别的 |\n",
      "docs/adr/adr-099-demo.md": ADR_OK,
    });
    const errors = checkAdrStructure(dir);
    assert.equal(errors.length > 0, true, "删索引行后仍然绿 ⇒ 判据没牙");
    assert.match(errors.join("\n"), /索引行出现 0 次|README/, "报错没有点名索引");
    passed += 1;
  } catch (err) {
    failures.push([name, err]);
  }
}

// ── R77-B：发版公告五节判据（三条反例 + 夹具绑定）────────────────────────
{
  const name = "R77-B：发版公告夹具覆盖五节关键词（expectRequiredFixtures 绑定）";
  try {
    const doc = RELEASE_NOTES_SECTIONS.map((k) => `## ${k}\n内容\n`).join("\n");
    const miss = expectRequiredFixtures(
      RELEASE_NOTES_SECTIONS.map((k) => ({ id: k, re: new RegExp(`^##\\s.*${k}`, "m") })),
      doc,
    );
    assert.deepEqual(miss, [], `夹具未覆盖：${miss.join("；")}`);
    passed += 1;
  } catch (err) {
    failures.push([name, err]);
  }
}

{
  const name = "R77-B 反例①：白名单文档删一节 ⇒ 红且点名缺哪节";
  try {
    const dir = fixture({
      "docs/RELEASE-NOTES-demo.md": "## 一句话影响面\n## 谁会被打断\n## 升级步骤\n## 自检清单\n",
    });
    const errors = checkReleaseNotesSections(dir);
    assert.equal(errors.length > 0, true, "删「回滚」后仍然绿 ⇒ 判据没牙");
    assert.match(errors.join("\n"), /回滚/, "报错没有点名缺失小节");
    passed += 1;
  } catch (err) {
    failures.push([name, err]);
  }
}

{
  const name = "R77-B 反例②：**非白名单**文档缺同样小节 ⇒ 不红（防误伤）";
  try {
    const dir = fixture({ "docs/SOME-OTHER-DOC.md": "## 随便写\n正文\n" });
    const errors = checkReleaseNotesSections(dir);
    assert.deepEqual(errors.filter((e) => e.includes("SOME-OTHER-DOC")), []);
    passed += 1;
  } catch (err) {
    failures.push([name, err]);
  }
}

{
  const name = "R77-B 反例③：围栏代码块里的假标题不算数 ⇒ 仍红";
  try {
    const dir = fixture({
      "docs/RELEASE-NOTES-demo.md":
        "## 一句话影响面\n## 谁会被打断\n## 升级步骤\n## 回滚\n```\n## 自检清单\n```\n",
    });
    const errors = checkReleaseNotesSections(dir);
    assert.equal(errors.length > 0, true, "围栏里的假标题被当真 ⇒ 判据有洞");
    assert.match(errors.join("\n"), /自检清单/);
    passed += 1;
  } catch (err) {
    failures.push([name, err]);
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
console.log(`\n自检结果：${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const [name, err] of failures) console.error(`\n[${name}]\n${err.stack}`);
  process.exit(1);
}
