#!/usr/bin/env node
/**
 * 「可发布包必须接线」守卫。
 *
 * 由来：`packages/autocodeflow-{ai,http,notify,db}` 四个包有源码 + 测试 + pyproject + CHANGELOG，
 * 却**不在** `release.yml` 的 version-guard 里、**不在**任何 publish 矩阵里、**版本停在 0.3.2**
 * （平台主线已到 1.15.x），且**全仓零消费者**。
 *
 * 这又是「**文件存在 ≠ 在链路里**」那一族 —— 本 session 已经在这个形态上抓到过三次：
 * 守卫写了没接 CI、selftest 写了没进 test:main、`ZIP_MAX_*` 定义了没有调用方。现在是第四个载体。
 *
 * 判据：
 *   ① `packages/*` 下**有可发布清单**的包（`pyproject.toml`，或 `package.json` 且不是 `private: true`）
 *      必须出现在 `.github/workflows/release.yml` 里；
 *   ② 例外必须逐条进 `UNWIRED_BASELINE` 并写明理由；**新出现的未接线包即红**；
 *   ③ 反向：基线里的包若**已经接线** ⇒ 也红（基线该瘦身，否则豁免名单会腐烂）；
 *   ④ 基线里的包若**已不存在** ⇒ 也红。
 *
 * 为什么基线里那四个不直接判红：它们的存在与否是**产品决策**（接进发布线 or 删掉），
 * 守卫的职责不是替人做决定，而是让这个状态**不能安静地待着**。一旦有人加第五个这样的包，立刻红。
 *
 * 用法：
 *   node scripts/check-publishable-wiring.mjs            # 守卫
 *   node scripts/check-publishable-wiring.mjs --report   # 列出全部包及其接线状态
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PKGS = join(ROOT, "packages");
const RELEASE = join(ROOT, ".github", "workflows", "release.yml");

/**
 * 已知未接线（**待产品决策**）。每条必须写清「为什么允许它现在不接线」与「决策后要做什么」。
 */
const UNWIRED_BASELINE = new Map([
  [
    "autocodeflow-ai",
    "待决策：接进 PyPI 发布线（含 version-guard 与文档）或删除；版本 0.3.2（落后平台主线 1.15.x 十余个 minor）、仓内零消费者",
  ],
  [
    "autocodeflow-http",
    "同上（四包同批：ai / http / notify / db）",
  ],
  [
    "autocodeflow-notify",
    "同上（四包同批：ai / http / notify / db）",
  ],
  [
    "autocodeflow-db",
    "同上（四包同批：ai / http / notify / db）",
  ],
]);

/** 可发布清单：`pyproject.toml`，或非 private 的 `package.json`。 */
function publishable(name) {
  const dir = join(PKGS, name);
  if (existsSync(join(dir, "pyproject.toml"))) return true;
  const pkgJson = join(dir, "package.json");
  if (!existsSync(pkgJson)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
    return pkg.private !== true;
  } catch {
    // 清单坏了是**另一个**问题，这里按「不可发布」跳过，避免把 JSON 错误伪装成接线错误。
    return false;
  }
}

const release = readFileSync(RELEASE, "utf8");
const all = readdirSync(PKGS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("."))
  .map((d) => d.name)
  .sort();

if (all.length < 8) {
  console.error(`✖ 只扫到 ${all.length} 个 package（下界 8）—— 扫描器失效了。`);
  process.exit(1);
}

const rows = all.map((name) => ({
  name,
  publishable: publishable(name),
  wired: release.includes(`packages/${name}`),
}));

const publishables = rows.filter((r) => r.publishable);
const unwired = publishables.filter((r) => !r.wired).map((r) => r.name);
const newlyUnwired = unwired.filter((n) => !UNWIRED_BASELINE.has(n));
const staleBaseline = [...UNWIRED_BASELINE.keys()].filter(
  (n) => !unwired.includes(n),
);

if (process.argv.includes("--report")) {
  for (const r of rows) {
    const tag = !r.publishable ? "（无发布清单，不适用）" : r.wired ? "✅ 已接线" : "⚠️ 未接线";
    console.log(`  ${r.name.padEnd(26)} ${tag}`);
  }
  console.log("");
}

if (newlyUnwired.length > 0 || staleBaseline.length > 0) {
  console.error("");
  if (newlyUnwired.length > 0) {
    console.error(`✖ ${newlyUnwired.length} 个可发布包**没有接进 release.yml**（版本守卫与发布矩阵都覆盖不到）：`);
    for (const n of newlyUnwired) console.error("  · packages/" + n);
    console.error("  修法二选一：① 接进 .github/workflows/release.yml（version-guard + 对应 publish 矩阵）；");
    console.error("           ② 若它本该只在本仓内部使用，从 packages/ 移走，或让它成为 private 包。");
  }
  if (staleBaseline.length > 0) {
    console.error(`✖ 基线里 ${staleBaseline.length} 个包**已接线或已不存在** —— 基线该瘦身：`);
    for (const n of staleBaseline) console.error("  · " + n);
  }
  console.error("");
  process.exit(1);
}

const wiredCount = publishables.length - unwired.length;
console.log(
  `✔ 可发布包接线一致：${publishables.length} 个可发布包中 ${wiredCount} 个已接线，` +
    `${unwired.length} 个显式基线豁免（待产品决策）。`,
);
