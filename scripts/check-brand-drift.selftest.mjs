#!/usr/bin/env node
// check-brand-drift.mjs 的有齿自检。
//
// 原则与仓内其它守卫一致：**每条用例都必须能失败**。正例用最小夹具仓库（能通过），
// 每条负例只破坏一个维度（必须红），并断言报错文本里能看出「是哪条判据、哪个文件」。
//
// ## 根从哪来（`--root`）—— 与主脚本**必须同一个根**
//
// 本自检**不碰真仓库**：20 条判据用例全部 `checkBrandDrift(<夹具目录>)`（无一处
// 回落默认根）。为了让「自检给主脚本传夹具根」这件事被机械钉住，末尾三条**黑盒
// CLI** 用例会 spawn 主脚本 `scripts/check-brand-drift.mjs`，并通过
// `--root=<夹具目录>` 把**同一个根**交给它：
//
//   · `--root=<合规夹具>` ⇒ exit 0（若主脚本悄悄跑真仓库，这里仍会 0 —— 所以
//     配合下一条：破坏后的夹具必须是 1，真仓库是 0，两者不可能同码）；
//   · `--root=<破坏后的夹具>` ⇒ exit 1（且报错点名夹具里的相对路径）；
//   · `--root=<不存在的目录>` ⇒ exit 2（用法错误，不静默回落到真仓库）。
//
// 自检自己的 `--root <dir>` / `--root=<dir>` 是**夹具父目录**（默认 `os.tmpdir()`）：
// 夹具建在它下面，清理后不留痕；指向不存在的目录 ⇒ exit 2。
//
// 运行：node scripts/check-brand-drift.selftest.mjs [--root <dir>]
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { checkBrandDrift, readPngSize } from "./check-brand-drift.mjs";
import { expectExit, runGuard } from "./lib/guard-selftest.mjs";

/** 主脚本（黑盒 CLI 用例 spawn 的就是它，不是本文件）。 */
const GUARD = fileURLToPath(new URL("./check-brand-drift.mjs", import.meta.url));

/** 用法错误退出码（与「判据红 = 1」分开）。 */
const EXIT_USAGE = 2;

/**
 * 夹具父目录。默认 `os.tmpdir()`；`--root` 可改（例如把夹具放到某次运行的
 * artifacts 目录下做取证）。**不存在的目录直接 exit 2** —— 否则 mkdtemp 会在
 * 一个意想不到的位置造树，「以为在跑夹具」就变成了「在别处乱写」。
 */
function parseFixtureBase(argv = process.argv.slice(2)) {
  let base = os.tmpdir();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root" || a.startsWith("--root=")) {
      const v = a === "--root" ? argv[++i] : a.slice("--root=".length);
      if (!v || v.startsWith("--")) {
        console.error("✘ 用法错误：`--root` 需要一个目录参数（`--root <dir>` 或 `--root=<dir>`）");
        process.exit(EXIT_USAGE);
      }
      base = path.resolve(v);
    }
  }
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    console.error(`✘ 用法错误：\`--root\` 指向的目录不存在：${base}`);
    process.exit(EXIT_USAGE);
  }
  return base;
}

const FIXTURE_BASE = parseFixtureBase();

/** 造一张指定尺寸的 PNG（只需文件头合法即可，守卫不解码像素）。 */
function pngBytes(width, height) {
  const buf = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(FIXTURE_BASE, "brand-drift-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 一份「全都合规」的仓库。 */
function goodRepo(overrides = {}) {
  const svg = "<svg>fox</svg>";
  const fox256 = pngBytes(256, 256);
  const metrics = JSON.stringify({
    sha256: createHash("sha256").update(fox256).digest("hex"),
    centerOffsetX: 0,
    centerOffsetY: 0,
    tolerance: 0.01,
  });
  const base = {
    "design-system/brand/source/acf-mark-bare.png": pngBytes(1024, 1024),
    "design-system/brand/generated/acf-fox-256.png": fox256,
    "design-system/brand/generated/acf-fox-metrics.json": metrics,
    "design-system/brand/svg/acf-fox.svg": svg,
    "apps/admin-web/public/acf-fox.svg": svg,
    "packages/docs-site/public/logo.svg": svg,
    "design-system/brand/svg/acf-mark.svg": "<svg>hex</svg>",
    // 判据⑥：首图内嵌狐狸（data URI）+ 中台的四个形象位都用 <BrandFox>。
    "design-system/brand/svg/banner-en.svg": '<svg><image href="data:image/png;base64,AAAA"/></svg>',
    "design-system/brand/svg/banner-zh.svg": '<svg><image href="data:image/png;base64,AAAA"/></svg>',
    "apps/admin-web/src/layouts/MainLayout.tsx": "<BrandFox size={32} />\n",
    "apps/admin-web/src/pages/LoginPage.tsx": "import BrandFox from '../components/BrandFox';\n",
    "apps/admin-web/src/pages/NotFoundPage.tsx": "<BrandFox size={160} />\n",
    "apps/admin-web/src/components/dashboard/DashboardEmptyGuide.tsx": "<BrandFox size={96} />\n",
    // 判据⑦：桌面渲染层品牌位（顶栏 / 向导两处）都渲染狐狸图片
    "apps/executor-desktop/src/renderer/assets/acf-fox.png": pngBytes(128, 128),
    "apps/executor-desktop/src/renderer/App.tsx": 'import foxImg from "./assets/acf-fox.png";\n<img src={foxImg} />\n',
    "apps/executor-desktop/src/renderer/pages/Wizard.tsx": '<img className="wizard-brand-icon" src={foxImg} />\n',
    // 判据⑧：README 标题旁的独立狐狸图标（三语都引用同一张）
    "docs/assets/acf-fox-96.png": pngBytes(96, 96),
    "README.md": '<h1><img src="docs/assets/acf-fox-96.png" width="48"> AutoCodeFlow</h1>\n',
    "README.en.md": '# <img src="docs/assets/acf-fox-96.png" width="48"> AutoCodeFlow\n',
    "README.zh.md": '# <img src="docs/assets/acf-fox-96.png" width="48"> AutoCodeFlow\n',
    "apps/executor-desktop/assets/tray-online@2x.png": pngBytes(32, 32),
    "apps/executor-desktop/assets/tray-offline@2x.png": pngBytes(32, 32),
    "apps/executor-desktop/assets/tray-pending@2x.png": pngBytes(32, 32),
    "scripts/brand/build-brand-assets.py": "# 只写六边形\n",
    ...overrides,
  };
  return makeRepo(base);
}

const cases = [];
const add = (name, fn) => cases.push({ name, fn });

add("正例：全部合规 → 0 报错", () => {
  const r = goodRepo();
  try {
    assert.deepEqual(checkBrandDrift(r.dir), []);
  } finally {
    r.cleanup();
  }
});

add("判据①：落地副本被手改 → 红（点名是哪个副本）", () => {
  const r = goodRepo({ "apps/admin-web/public/acf-fox.svg": "<svg>手改的</svg>" });
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("apps/admin-web/public/acf-fox.svg")), errors.join("\n"));
    assert.ok(errors.some((e) => e.includes("不一致")));
  } finally {
    r.cleanup();
  }
});

add("判据①：文档站 logo 与生成物不一致 → 红", () => {
  const r = goodRepo({ "packages/docs-site/public/logo.svg": "<svg>另一份</svg>" });
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("packages/docs-site/public/logo.svg")));
  } finally {
    r.cleanup();
  }
});

add("判据②：源图缺失 → 红", () => {
  const r = goodRepo();
  fs.unlinkSync(path.join(r.dir, "design-system/brand/source/acf-mark-bare.png"));
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("缺少狐狸源图")));
  } finally {
    r.cleanup();
  }
});

add("判据②：源图不是正方形 → 红", () => {
  const r = goodRepo({ "design-system/brand/source/acf-mark-bare.png": pngBytes(1024, 512) });
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("不是正方形")));
  } finally {
    r.cleanup();
  }
});

add("判据②：源图尺寸不足 1024 → 红（桌面图标需要 1024 源）", () => {
  const r = goodRepo({ "design-system/brand/source/acf-mark-bare.png": pngBytes(256, 256) });
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("1024")));
  } finally {
    r.cleanup();
  }
});

add("判据④：矢量脚本又写回狐狸占用的 logo.svg → 红（点明后果）", () => {
  const r = goodRepo({
    "scripts/brand/build-brand-assets.py": '"packages/docs-site/public/logo.svg": mark_svg(64),\n',
  });
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("logo.svg")), errors.join("\n"));
    assert.ok(errors.some((e) => e.includes("冲回六边形")));
  } finally {
    r.cleanup();
  }
});

add("判据⑤：六边形不见了 → 红（分层，不是替换）", () => {
  const r = goodRepo();
  fs.unlinkSync(path.join(r.dir, "design-system/brand/svg/acf-mark.svg"));
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("acf-mark.svg")));
    assert.ok(errors.some((e) => e.includes("分层，不是替换")));
  } finally {
    r.cleanup();
  }
});

add("判据⑤：托盘图标少一个 → 红", () => {
  const r = goodRepo();
  fs.unlinkSync(path.join(r.dir, "apps/executor-desktop/assets/tray-pending@2x.png"));
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("tray-pending")));
  } finally {
    r.cleanup();
  }
});

add("判据③：居中度量缺失 → 红（无法确认居中）", () => {
  const r = goodRepo();
  fs.unlinkSync(path.join(r.dir, "design-system/brand/generated/acf-fox-metrics.json"));
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("acf-fox-metrics.json")), errors.join("\n"));
  } finally {
    r.cleanup();
  }
});

add("判据③：居中偏移超容差 → 红（点名水平/垂直）", () => {
  const fox = pngBytes(256, 256);
  const r = goodRepo({
    "design-system/brand/generated/acf-fox-256.png": fox,
    "design-system/brand/generated/acf-fox-metrics.json": JSON.stringify({
      sha256: createHash("sha256").update(fox).digest("hex"),
      centerOffsetX: 0.057, // 曾经的真实值：源图残影导致偏右 5.7%
      centerOffsetY: 0,
      tolerance: 0.01,
    }),
  });
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("不居中")), errors.join("\n"));
    assert.ok(errors.some((e) => e.includes("5.70%")));
  } finally {
    r.cleanup();
  }
});

add("判据③：度量与产出物哈希对不上（度量过期/手改）→ 红", () => {
  const r = goodRepo({
    "design-system/brand/generated/acf-fox-metrics.json": JSON.stringify({
      sha256: "deadbeef".repeat(8),
      centerOffsetX: 0,
      centerOffsetY: 0,
      tolerance: 0.01,
    }),
  });
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("度量已过期")), errors.join("\n"));
  } finally {
    r.cleanup();
  }
});

add("判据⑥：首图退化回六边形（SVG 里没有内嵌狐狸）→ 红", () => {
  const r = goodRepo({
    "design-system/brand/svg/banner-en.svg": '<svg><path d="M0 0h64v64z"/></svg>',
  });
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("banner-en.svg")), errors.join("\n"));
    assert.ok(errors.some((e) => e.includes("产品形象位")));
  } finally {
    r.cleanup();
  }
});

add("判据⑥：中台侧边栏标志位换回通用图标 → 红", () => {
  const r = goodRepo({ "apps/admin-web/src/layouts/MainLayout.tsx": "<ThunderboltOutlined />\n" });
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("MainLayout.tsx")), errors.join("\n"));
    assert.ok(errors.some((e) => e.includes("没有用 <BrandFox>")));
  } finally {
    r.cleanup();
  }
});

add("判据⑥：404 页改回 antd 默认插图 → 红（点名是哪个形象位）", () => {
  const r = goodRepo({ "apps/admin-web/src/pages/NotFoundPage.tsx": "<Result status=\"404\" />\n" });
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("NotFoundPage.tsx")), errors.join("\n"));
    assert.ok(errors.some((e) => e.includes("登录页 / 404 / 空态")));
  } finally {
    r.cleanup();
  }
});

add("判据⑦：桌面顶栏换回闪电图标 → 红（点名是哪个文件）", () => {
  const r = goodRepo({
    "apps/executor-desktop/src/renderer/App.tsx": '<span className="titlebar-mark"><Icon name="zap" /></span>\n',
  });
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("renderer/App.tsx")), errors.join("\n"));
    assert.ok(errors.some((e) => e.includes("src={foxImg}")));
  } finally {
    r.cleanup();
  }
});

add("判据⑦：桌面渲染层狐狸图缺失 → 红（指向 build-fox-assets.py）", () => {
  const r = goodRepo();
  fs.unlinkSync(path.join(r.dir, "apps/executor-desktop/src/renderer/assets/acf-fox.png"));
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("acf-fox.png")), errors.join("\n"));
    assert.ok(errors.some((e) => e.includes("build-fox-assets.py")));
  } finally {
    r.cleanup();
  }
});

add("判据⑧：README 标题图标缺失 → 红（指向 build-fox-assets.py）", () => {
  const r = goodRepo();
  fs.unlinkSync(path.join(r.dir, "docs/assets/acf-fox-96.png"));
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("acf-fox-96.png")), errors.join("\n"));
    assert.ok(errors.some((e) => e.includes("build-fox-assets.py")));
  } finally {
    r.cleanup();
  }
});

add("判据⑧：中文 README 的标题图标被去掉 → 红（点名文件）", () => {
  const r = goodRepo({ "README.zh.md": "# AutoCodeFlow\n" });
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("README.zh.md")), errors.join("\n"));
    assert.ok(errors.some((e) => e.includes("标题旁没有狐狸图标")));
  } finally {
    r.cleanup();
  }
});

add("判据⑧：标题图标不是正方形 → 红", () => {
  const r = goodRepo({ "docs/assets/acf-fox-96.png": pngBytes(96, 64) });
  try {
    const errors = checkBrandDrift(r.dir);
    assert.ok(errors.some((e) => e.includes("不是正方形")), errors.join("\n"));
  } finally {
    r.cleanup();
  }
});

add("readPngSize：非 PNG 返回 null（不误判）", () => {
  const r = makeRepo({ "x.png": Buffer.from("not a png at all") });
  try {
    assert.equal(readPngSize(path.join(r.dir, "x.png")), null);
  } finally {
    r.cleanup();
  }
});

// ── 黑盒 CLI：主脚本必须被喂**夹具根**，且与直接调用判据结论一致 ──────────────
// 这三条是「自检给主脚本传 `--root=<夹具目录>`」的机械钉：它们 spawn 真脚本，
// 所以能抓到「判据算对了但 CLI 入口丢了根」这类只在入口犯的错（例如 `--root`
// 被吃掉 ⇒ 扫真仓库 ⇒ 合规夹具也 exit 0、破坏夹具也 exit 0 —— 第二条会红）。
add("CLI `--root=<合规夹具>` ⇒ exit 0（夹具根，不是真仓库）", () => {
  const r = goodRepo();
  try {
    expectExit(runGuard(GUARD, { args: [`--root=${r.dir}`] }), {
      code: 0,
      contains: ["品牌资产无漂移"],
      label: "CLI --root=<合规夹具>",
    });
  } finally {
    r.cleanup();
  }
});

add("CLI `--root=<破坏后的夹具>` ⇒ exit 1（报错点名夹具内相对路径）", () => {
  const r = goodRepo({ "design-system/brand/svg/acf-fox.svg": "<svg>被手改</svg>" });
  try {
    expectExit(runGuard(GUARD, { args: ["--root", r.dir] }), {
      code: 1,
      contains: ["品牌资产漂移", "acf-fox.svg"],
      absent: ["品牌资产无漂移"],
      label: "CLI --root=<破坏后的夹具>",
    });
  } finally {
    r.cleanup();
  }
});

add("CLI `--root=<不存在的目录>` ⇒ exit 2（不静默回落到真仓库）", () => {
  expectExit(
    runGuard(GUARD, { args: [`--root=${path.join(FIXTURE_BASE, "品牌-不存在-" + process.pid)}`] }),
    { code: 2, contains: ["用法错误", "--root"], label: "CLI --root=<不存在>" },
  );
});

const failed = [];
for (const c of cases) {
  try {
    c.fn();
    console.log(`  ✔ ${c.name}`);
  } catch (err) {
    failed.push(c.name);
    console.error(`  ✘ ${c.name}`);
    console.error(`      ${err.message}`);
  }
}
if (failed.length) {
  console.error(`\n✘ check-brand-drift 自检 失败：${failed.length}/${cases.length} 条用例未按预期`);
  process.exit(1);
}
console.log(`\n✔ check-brand-drift 自检 通过：${cases.length}/${cases.length} 条用例`);
