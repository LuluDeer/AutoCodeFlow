#!/usr/bin/env node
// check-docs.mjs 的有齿自检。
//
// 目的：守卫本身不能腐烂。每个用例在临时目录里搭一个**最小仓库**，
// 断言判据在「该红」时真的红、在「该绿」时真的绿。全部用例必须通过，
// 否则 `npm run test:docs` 失败。
//
// 运行：node scripts/docs/check-docs.selftest.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkLinks,
  checkOrphans,
  checkRootHygiene,
} from "./check-docs.mjs";

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

// ── 汇总 ─────────────────────────────────────────────────────────────────
console.log(`\n自检结果：${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const [name, err] of failures) console.error(`\n[${name}]\n${err.stack}`);
  process.exit(1);
}
