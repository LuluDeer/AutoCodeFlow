#!/usr/bin/env node
// N-06：agent-worker / 打包态 Playwright 的**跨文件配置一致性**守卫。
//
// 本任务把 Agent 托管拆成独立子进程并把 Chromium 随包分发，接线分散在
// 7 个文件（esbuild 脚本 / electron-builder.yml / 发布流水线 / 路径解析 /
// 漂移清单 / .gitignore / package.json 脚本链）。这类「同一条契约写在多处」
// 的接线，历史上最典型的失效形态就是改一处忘其余（desktop-v1.5.1 漏打 uv、
// v1.5.0 artifactName 错位都是同型事故）。本守卫把每处锚点钉死：任何一处被
// 静默拆除即红，失败信息直接指出该补哪。
//
// 分工（不重复别的闸的职责）：
//   · 语义/字节漂移 → check-desktop-bundle-drift.mjs（本守卫只检查清单存在）
//   · worker 运行时契约 → agent-worker-paths/protocol/process selftest（真 spawn）
//   · 本守卫：配置面锚点齐全性，纯静态读，秒级零依赖。
//
// 用法：
//   node scripts/check-desktop-agent-packaging.mjs            # 检查真实代码库
//   node scripts/check-desktop-agent-packaging.mjs --selftest # fixture 验证判据有齿
import { readFileSync, existsSync } from "node:fs";

export function read(p, exists = existsSync) {
  if (!exists(p)) return null;
  return readFileSync(p, "utf8");
}

/** 锚点表：每项 = [描述, 文件, 必须同时包含的片段]。片段全部出现才算过。 */
export function buildAnchors(files) {
  return [
    ["electron-builder.yml: agent-worker extraResources 条目（to: agent-worker/）",
      files.builderYml, ["from: resources/agent-worker/", "to: agent-worker/"]],
    ["electron-builder.yml: playwright extraResources 条目（to: playwright/）",
      files.builderYml, ["from: resources/playwright/", "to: playwright/"]],
    ["agent-worker-paths.ts: worker 落点解析（agent-worker/dist/index.js）",
      files.pathsTs, ["'agent-worker'", "'dist'", "'index.js'"]],
    ["agent-worker-paths.ts: 随包浏览器目录解析（resourcesPath/playwright）",
      files.pathsTs, ["'playwright'"]],
    ["agent-worker-paths.ts: ELECTRON_RUN_AS_NODE 注入",
      files.pathsTs, ["ELECTRON_RUN_AS_NODE"]],
    ["release-desktop.yml: ACF_BUNDLE_PLAYWRIGHT=1（发布必须带浏览器）",
      files.releaseYml, ["ACF_BUNDLE_PLAYWRIGHT: '1'"]],
    ["release-desktop.yml: ACF_PLAYWRIGHT_REQUIRED=1（缺浏览器即硬失败）",
      files.releaseYml, ["ACF_PLAYWRIGHT_REQUIRED: '1'"]],
    ["bundle-agent-worker.cjs: 只装 chromium-headless-shell（bundle 体积纪律）",
      files.bundleScript, ["chromium-headless-shell"]],
    ["bundle-agent-worker.cjs: electron 走 stub alias（防 223MB 资产入包）",
      files.bundleScript, ["--alias:electron=", "electron-stub"]],
    ["bundle-agent-worker.cjs: packageRoot 契约文件复制（browsers.json/package.json）",
      files.bundleScript, ["'browsers.json'", "'package.json'"]],
    [".gitignore: agent-worker 产物不入库（防 7MB bundle 被误 add）",
      files.gitignore, ["apps/executor-desktop/resources/agent-worker/"]],
    [".gitignore: playwright 浏览器不入库（防 266MB 被误 add）",
      files.gitignore, ["apps/executor-desktop/resources/playwright/"]],
    ["desktop package.json: build 链含 build:agent-worker",
      files.desktopPkg, ["build:agent-worker"]],
    ["desktop package.json: test:main 链含真 bundle 冒烟 selftest",
      files.desktopPkg, ["agent-worker-process.selftest.js"]],
    ["根 package.json: typecheck:desktop 覆盖 worker tsconfig",
      files.rootPkg, ["tsconfig.worker.json"]],
    ["tsconfig.worker.json 存在（worker 面独立 typecheck）",
      files.workerTsconfig, ["src/agent-worker"]],
    ["electron-stub 包存在（electron-stub/index.cjs + package.json）",
      files.stubIndex, ["commandLine"]],
    ["agent-worker-bundle.sha256 清单存在且含 source-digest 与字节行",
      files.workerManifest, ["source-digest:"]],
  ].map(([desc, content, needles]) => ({ desc, content, needles }));
}

export function check(files) {
  const errors = [];
  const anchors = buildAnchors(files);
  for (const { desc, content, needles } of anchors) {
    if (content === null) {
      errors.push(`${desc} —— 文件不存在`);
      continue;
    }
    for (const needle of needles) {
      if (!content.includes(needle)) {
        errors.push(`${desc} —— 缺片段 ${JSON.stringify(needle)}（改了一处忘其余？回看 N-06 的接线清单）`);
      }
    }
  }
  // 字节行存在性（source-digest 之外的末行）
  if (files.workerManifest !== null) {
    if (!/\n[0-9a-f]{64}\s+\S/.test(files.workerManifest)) {
      errors.push("agent-worker-bundle.sha256 缺末行字节哈希（应形如 '<64hex>  dist/index.js'）");
    }
  }
  return errors;
}

// ── 自检：fixture 驱动，逐项验证每条锚点都咬人（判据有齿）─────────────────
export function selftest() {
  const OK = {
    builderYml: "extraResources:\n  - from: resources/agent-worker/\n    to: agent-worker/\n  - from: resources/playwright/\n    to: playwright/\n",
    pathsTs: "const x = path.join(r, 'agent-worker', 'dist', 'index.js'); const b = path.join(r, 'playwright'); env.ELECTRON_RUN_AS_NODE = '1';",
    releaseYml: "env:\n  ACF_BUNDLE_PLAYWRIGHT: '1'\n  ACF_PLAYWRIGHT_REQUIRED: '1'",
    bundleScript: "const cli=1; '--alias:electron='+p+'/electron-stub'; install('chromium-headless-shell'); copy('browsers.json'); copy('package.json');",
    gitignore: "apps/executor-desktop/resources/agent-worker/\napps/executor-desktop/resources/playwright/\n",
    desktopPkg: '"build:agent-worker": "node scripts/bundle-agent-worker.cjs"\n"test:main": "node dist-selftest/agent-worker-process.selftest.js"',
    rootPkg: '"typecheck:desktop": "npx tsc -p tsconfig.worker.json --noEmit"',
    workerTsconfig: '{ "include": ["src/agent-worker/**/*"] }',
    stubIndex: "module.exports = { app: { commandLine: { appendSwitch() {} } } };",
    workerManifest: "# c\nsource-digest: aabb\n0011223344556677889900112233445566778899001122334455667788990011  dist/index.js\n",
  };
  const errors = check(OK);
  if (errors.length > 0) {
    console.error("selftest FAIL: 全齐 fixture 不应报错：\n  " + errors.join("\n  "));
    process.exit(1);
  }
  // 逐项拆锚点：每条锚点单独缺失都必须产生 ≥1 条错误（有齿证明）
  let teeth = 0;
  for (const key of Object.keys(OK)) {
    const broken = { ...OK, [key]: null };
    if (check(broken).length === 0) {
      console.error(`selftest FAIL: 删除 ${key} 未触发任何锚点 —— 判据无齿`);
      process.exit(1);
    }
    teeth += check(broken).length;
  }
  // 片段级抽样：抠掉 builderYml 的 to: agent-worker/ 一行
  const partial = { ...OK, builderYml: OK.builderYml.replace("    to: agent-worker/\n", "") };
  if (check(partial).length === 0) {
    console.error("selftest FAIL: 抠掉 to: agent-worker/ 未报红 —— 片段级判据无齿");
    process.exit(1);
  }
  // 字节行缺失必须单独报红
  const noByte = { ...OK, workerManifest: "# c\nsource-digest: aabb\n" };
  if (!check(noByte).some((e) => e.includes("末行字节哈希"))) {
    console.error("selftest FAIL: 缺字节行未单独报红");
    process.exit(1);
  }
  console.log(`selftest OK: ${teeth}+ 项锚点逐一咬人（文件缺失/片段缺失/字节行缺失三类全有齿）`);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const invoked = process.argv[1]?.replace(/\\/g, "/").split("/").pop();
if (invoked === "check-desktop-agent-packaging.mjs") {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const files = {
      builderYml: read("apps/executor-desktop/electron-builder.yml"),
      pathsTs: read("apps/executor-desktop/src/main/agent-worker-paths.ts"),
      releaseYml: read(".github/workflows/release-desktop.yml"),
      bundleScript: read("apps/executor-desktop/scripts/bundle-agent-worker.cjs"),
      gitignore: read(".gitignore"),
      desktopPkg: read("apps/executor-desktop/package.json"),
      rootPkg: read("package.json"),
      workerTsconfig: read("apps/executor-desktop/tsconfig.worker.json"),
      stubIndex: read("apps/executor-desktop/src/agent-worker/electron-stub/index.cjs"),
      workerManifest: read("apps/executor-desktop/agent-worker-bundle.sha256"),
    };
    const errors = check(files);
    if (errors.length > 0) {
      console.error(`agent packaging 配置面漂移（${errors.length} 项）：`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log(`✔ agent packaging 配置面一致（${buildAnchors(files).length} 条锚点全命中）`);
  }
}
