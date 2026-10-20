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
 * 用法：node scripts/check-ssrf-deny-parity.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "apps", "admin-api", "src", "common", "utils", "__tests__", "ssrf-deny-matrix.spec.ts");
/**
 * 三个消费方（本仓的 SSRF 拒绝判据有三份实现，都必须被同一张矩阵钉住）：
 *   ① admin-api —— 矩阵的**出处**（表驱动 + 18 条），本身已有自己的 spec；
 *   ② executor-node —— 镜像用例 `ssrf-deny-parity.spec.ts`；
 *   ③ executor-python —— 镜像用例 `tests/test_ssrf_guard.py`（R79 新增）。
 *
 * 只校验 ②③：它们才是「会漏」的地方（① 是矩阵本身）。
 */
const TARGETS = [
  {
    path: join(ROOT, "apps", "executor-node", "src", "lib", "ssrf-deny-parity.spec.ts"),
    label: "executor-node",
    needle: (addr) => `addr: ${JSON.stringify(addr)}`,
  },
  {
    path: join(ROOT, "apps", "executor-python", "tests", "test_ssrf_guard.py"),
    label: "executor-python",
    needle: (addr) => `"${addr}"`,
  },
];

const src = readFileSync(SRC, "utf8");
const sources = TARGETS.map((t) => ({ ...t, src: readFileSync(t.path, "utf8") }));

/** admin-api 矩阵条目：`{ name: "…", addr: "…", risk: "…" }`。 */
const entries = [...src.matchAll(/\{\s*name:\s*"([^"]+)",\s*addr:\s*"([^"]+)",\s*risk:\s*"([^"]+)"\s*\}/g)].map(
  (m) => ({ name: m[1], addr: m[2], risk: m[3] }),
);

if (entries.length === 0) {
  // 扫描器自身带守卫：正则失效时「0 条 → 0 缺失」是永真断言，必须红。
  console.error("✖ 从 admin-api 矩阵里解析出 0 条地址 —— 正则失效了（不是矩阵空了）。");
  process.exit(1);
}

const missing = [];
for (const target of sources) {
  for (const e of entries) {
    if (!target.src.includes(target.needle(e.addr))) {
      missing.push({ ...e, target: target.label });
    }
  }
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

console.log(
  "✔ SSRF 拒绝矩阵已对齐：admin-api 的 " + entries.length + " 条危险地址全部出现在 " +
    sources.map((s) => s.label).join(" / ") + " 的镜像用例中。",
);
