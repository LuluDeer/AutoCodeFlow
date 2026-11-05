#!/usr/bin/env node
/**
 * R63：`expectRequiredKeys` / `expectRequiredPaths` 的自检（正例 + 各 2 反例）。
 *
 * 为什么单独一个脚本而不并进某个守卫：这两个助手是**跨守卫共用**的，理应独立被测；
 * 它**不进链**（`check:*` 之外的纯工具自检，同 `backlog:stale`），手工 `node` 运行即可。
 */
import assert from "node:assert/strict";
import { expectRequiredKeys, expectRequiredPaths } from "./guard-selftest.mjs";

let passed = 0;
const failures = [];
const t = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures.push([name, err]);
  }
};

// ── expectRequiredKeys ──
t("Keys 正例：夹具覆盖全部必需项 ⇒ []", () => {
  const req = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(expectRequiredKeys(req, [{ id: "a", file: "x" }, { id: "b", file: "y" }]), []);
});
t("Keys 反例①：缺一条 ⇒ 点名", () => {
  const miss = expectRequiredKeys([{ id: "a" }, { id: "b" }], [{ id: "a", file: "x" }]);
  assert.equal(miss.length, 1);
  assert.match(miss[0], /「b」/);
});
t("Keys 反例②：字段为空 ⇒ 点名该字段", () => {
  const miss = expectRequiredKeys([{ id: "a" }], [{ id: "a", file: "" }]);
  assert.equal(miss.length, 1);
  assert.match(miss[0], /file/);
});

// ── expectRequiredPaths ──
t("Paths 正例：路径都在且有内容 ⇒ []", () => {
  const req = ["scripts/a.mjs", "scripts/b.mjs"];
  assert.deepEqual(
    expectRequiredPaths(req, { "scripts/a.mjs": "x", "scripts/b.mjs": "y" }),
    [],
  );
});
t("Paths 反例①：路径缺失 ⇒ 点名", () => {
  const miss = expectRequiredPaths(["scripts/a.mjs"], { "packages/x/README.md": "y" });
  assert.equal(miss.length, 1);
  assert.match(miss[0], /scripts\/a\.mjs/);
});
t("Paths 反例②：路径存在但内容为空 ⇒ 点名", () => {
  const miss = expectRequiredPaths(["scripts/a.mjs"], { "scripts/a.mjs": "   " });
  assert.equal(miss.length, 1);
  assert.match(miss[0], /内容为空/);
});

console.log(`\n自检结果：${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const [n, e] of failures) console.error(`\n[${n}]\n${e.stack}`);
  process.exit(1);
}
