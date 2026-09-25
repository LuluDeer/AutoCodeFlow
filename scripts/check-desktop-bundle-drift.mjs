#!/usr/bin/env node
// F-19 / ADR-005 加固：desktop 内嵌 executor-node bundle 的**语义漂移**守卫。
//
// 背景（为什么需要第二道闸）：
// 现有的 .github/workflows/ci.yml 的 desktop-bundle-drift job 比对的是
// 「ncc 重打产物的 sha256 == 清单 executor-node-bundle.sha256」。该判据有两个
// 结构性问题，见 docs/design/python-task-upload-and-multiversion/BUNDLE-DRIFT-FINDING.md：
//
//   ① **构建路径依赖**：ncc 的 module id 由模块解析后的**真实绝对路径**派生，
//      同一份源码在不同目录下重打得到不同哈希。CI 固定在
//      `/home/runner/work/<repo>/<repo>`，本地开发者**永远算不出** CI 的值，
//      只能"推 CI → 读 actual → 回填"。这使该闸对本地开发**不可用**。
//   ② **构建器版本依赖**：ncc 换版（如 0.44 → 0.45）会整体改变产物字节，
//      即使源码一字未改，清单哈希也会失效——把"工具链升级"误报成"源码漂移"。
//      （2026-09 依赖审计二轮即命中：ncc 0.44→0.45，bundle 2600kB → 4035kB。）
//   ③ 失败信息不可诊断："本地算不出"与"真的漏打"给出同一句话。
//
// 本闸的判据**故意不看产物字节**，而是回答该闸真正要回答的问题：
//   「apps/executor-node/src 的内容，与清单记录的**那份源码**是否一致？」
// 做法：对 bundle 的**输入源文件**（排除 .spec/.test——它们不进产物）按
// 路径排序后，逐个喂 `路径\n内容` 求 sha256，得到一个与构建路径、OS、
// ncc 版本**全都无关**的语义摘要，与清单里的 `source-digest` 比对。
//
// 两个闸分工（都保留）：
//   · 本闸（语义）：抓"改了 executor-node/src 却没重打 bundle"——ADR-005 的本意，
//     且**本地可复现**，推送前就能自查。
//   · 原闸（字节）：抓"重打了但产物与源码不符"（更严，但只在 CI 可判）。
//
// 退出码：0 = 无漂移；1 = 源码与清单记录的摘要不一致（漂移）。
//
// 用法：
//   node scripts/check-desktop-bundle-drift.mjs            # 检查真实代码库
//   node scripts/check-desktop-bundle-drift.mjs --selftest # 验证判据本身
//   node scripts/check-desktop-bundle-drift.mjs --print    # 只打印当前摘要（供回填）
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

const SRC_DIR = "apps/executor-node/src";
const MANIFEST = "apps/executor-desktop/executor-node-bundle.sha256";

/** bundle 输入 = src 下所有 .ts，排除测试文件（实测不进 ncc 产物）。 */
export function isBundleInput(name) {
  return (
    name.endsWith(".ts") &&
    !name.endsWith(".spec.ts") &&
    !name.endsWith(".test.ts") &&
    !name.endsWith(".d.ts")
  );
}

/** 递归列出 bundle 输入文件（仓库相对路径，POSIX 分隔符，已排序）。 */
export function listBundleInputs(srcDir = SRC_DIR) {
  const out = [];
  if (!existsSync(srcDir)) return out;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === "node_modules" || name === "dist") continue;
        walk(p);
      } else if (isBundleInput(name)) {
        out.push(p);
      }
    }
  };
  walk(srcDir);
  return out
    .map((p) => p.replace(/\\/g, "/"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 语义摘要：对排序后的 (路径, 内容) 求 sha256。
 * 关键点——**不包含**绝对路径、构建时间、OS、ncc 版本，故跨环境可复现；
 * 但包含每个文件的相对路径，故"文件改名/移动"同样会被判为漂移。
 * 行尾统一为 \n：Windows checkout（core.autocrlf）不应造成假漂移。
 */
export function computeSourceDigest(files, read = (f) => readFileSync(f, "utf8")) {
  const h = createHash("sha256");
  // 内部再排一次序：调用方传什么顺序都不影响结果（自检 ⑤ 钉住该契约）。
  for (const f of [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const content = read(f).replace(/\r\n/g, "\n");
    h.update(f);
    h.update("\n");
    h.update(content);
    h.update("\n");
  }
  return h.digest("hex");
}

/** 从清单文本里取 `source-digest: <hex>`（# 注释行忽略）。 */
export function parseManifestDigest(manifestText) {
  for (const line of manifestText.split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const m = line.match(/source-digest:\s*([0-9a-f]{64})/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** 从清单文本里取末行字节哈希（既有判据，保留供提示用）。 */
export function parseManifestBundleHash(manifestText) {
  for (const line of manifestText.split(/\r?\n/).reverse()) {
    if (line.trimStart().startsWith("#")) continue;
    const m = line.match(/^([0-9a-f]{64})\s/m);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

export function check({
  srcDir = SRC_DIR,
  manifestPath = MANIFEST,
  read = (f) => readFileSync(f, "utf8"),
} = {}) {
  const errors = [];
  const files = listBundleInputs(srcDir);
  if (files.length === 0) {
    errors.push(`未在 ${srcDir} 找到任何 bundle 输入文件 —— guard is blind`);
    return { errors, files, actual: null, expected: null };
  }
  if (!existsSync(manifestPath)) {
    errors.push(`清单不存在：${manifestPath}`);
    return { errors, files, actual: null, expected: null };
  }
  const actual = computeSourceDigest(files, read);
  const expected = parseManifestDigest(read(manifestPath));
  if (!expected) {
    errors.push(
      `清单缺少 source-digest 行：${manifestPath} —— 运行 'node scripts/check-desktop-bundle-drift.mjs --print' 取值后按格式补一行`,
    );
    return { errors, files, actual, expected: null };
  }
  if (actual !== expected) {
    errors.push(
      `executor-node 源码语义摘要漂移：actual=${actual.slice(0, 12)}… expected=${expected.slice(0, 12)}…`,
    );
  }
  return { errors, files, actual, expected };
}

// ── 自检（fixture 驱动；不读真实代码库）────────────────────────────────────
export function selftest() {
  const F = ["a.ts", "sub/b.ts"];
  const mk = (m) => (f) => m[f] ?? "";
  const base = mk({ "a.ts": "export const x = 1;\n", "sub/b.ts": "export const y = 2;\n" });
  const d1 = computeSourceDigest(F, base);

  // ① 同内容 → 同摘要（可复现性：跨环境同源码必须同值）
  if (d1 !== computeSourceDigest(F, base)) {
    console.error("selftest FAIL: digest is not deterministic");
    process.exit(1);
  }
  // ② CRLF vs LF 视为相同（Windows checkout 不该假漂移）
  const crlf = mk({ "a.ts": "export const x = 1;\r\n", "sub/b.ts": "export const y = 2;\r\n" });
  if (computeSourceDigest(F, crlf) !== d1) {
    console.error("selftest FAIL: CRLF/LF should normalize to the same digest");
    process.exit(1);
  }
  // ③ 内容变化 → 摘要变化（这是本闸的核心判据）
  const changed = mk({ "a.ts": "export const x = 999;\n", "sub/b.ts": "export const y = 2;\n" });
  if (computeSourceDigest(F, changed) === d1) {
    console.error("selftest FAIL: content change did NOT change digest — guard has no teeth");
    process.exit(1);
  }
  // ④ 改名/移动 → 摘要变化（路径参与摘要）
  if (computeSourceDigest(["z.ts", "sub/b.ts"], mk({ "z.ts": "export const x = 1;\n", "sub/b.ts": "export const y = 2;\n" })) === d1) {
    console.error("selftest FAIL: rename did NOT change digest");
    process.exit(1);
  }
  // ⑤ 顺序无关（内部排序）——同内容不同列出顺序必须同值
  if (computeSourceDigest(["sub/b.ts", "a.ts"], base) !== d1) {
    console.error("selftest FAIL: digest depends on input order (should sort)");
    process.exit(1);
  }
  // ⑥ 测试文件必须被排除（否则改测试会触发假漂移）
  if (isBundleInput("x.spec.ts") || isBundleInput("x.test.ts") || isBundleInput("x.d.ts")) {
    console.error("selftest FAIL: spec/test/d.ts must not be bundle inputs");
    process.exit(1);
  }
  if (!isBundleInput("x.ts")) {
    console.error("selftest FAIL: plain .ts must be a bundle input");
    process.exit(1);
  }

  // ⑦ 清单解析：注释行里的示例不得被当成真值；缺失 → null
  const manifest = `# source-digest: ${"0".repeat(64)}  <- 注释里的示例，必须被忽略\n${"a".repeat(64)}  index.js\nsource-digest: ${d1}\n`;
  if (parseManifestDigest(manifest) !== d1) {
    console.error("selftest FAIL: parseManifestDigest picked the commented sample or missed the real line");
    process.exit(1);
  }
  if (parseManifestDigest("# nothing here\n") !== null) {
    console.error("selftest FAIL: parseManifestDigest should return null when absent");
    process.exit(1);
  }
  if (parseManifestBundleHash(`${"b".repeat(64)}  index.js\n`) !== "b".repeat(64)) {
    console.error("selftest FAIL: parseManifestBundleHash broken");
    process.exit(1);
  }
  // ⑧ source-digest 与 bundle 哈希必须是两条独立信息（末行字节哈希不受影响）
  if (parseManifestDigest(manifest) === parseManifestBundleHash(manifest)) {
    console.error("selftest FAIL: digest fields should be independent");
    process.exit(1);
  }

  console.log(
    "selftest OK: semantic digest deterministic, CRLF-normalized, order-independent, path-sensitive, spec-excluded, manifest-parsed",
  );
}

// ── CLI ────────────────────────────────────────────────────────────────────
const invoked = process.argv[1]?.replace(/\\/g, "/").split("/").pop();
const isMain = invoked === "check-desktop-bundle-drift.mjs";
if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else if (process.argv.includes("--print")) {
    const files = listBundleInputs();
    console.log(`source-digest: ${computeSourceDigest(files)}`);
    console.log(`(${files.length} bundle input files)`);
  } else {
    const { errors, files, actual, expected } = check();
    if (errors.length > 0) {
      console.error(`desktop bundle 语义漂移（${errors.length} 项）：`);
      for (const e of errors) console.error(`  - ${e}`);
      console.error("");
      console.error("处置：按 ADR-005，改了 apps/executor-node/src 后须在 apps/executor-desktop 重打 bundle");
      console.error("      （npm run build:executor），并把新摘要回填清单：");
      console.error("        node scripts/check-desktop-bundle-drift.mjs --print");
      console.error("      本闸与构建路径/ncc 版本无关，故本地即可判定——本地红就是真漂移。");
      process.exit(1);
    }
    console.log(
      `✔ desktop bundle 源码摘要一致（${files.length} 个输入文件，digest=${actual.slice(0, 12)}…，与 ncc 版本/构建路径无关）`,
    );
  }
}
