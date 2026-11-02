#!/usr/bin/env node
// check-brand-drift.mjs 的有齿自检。
//
// 原则与仓内其它守卫一致：**每条用例都必须能失败**。正例用最小夹具仓库（能通过），
// 每条负例只破坏一个维度（必须红），并断言报错文本里能看出「是哪条判据、哪个文件」。
//
// 运行：node scripts/check-brand-drift.selftest.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { checkBrandDrift, readPngSize } from "./check-brand-drift.mjs";

/** 造一张指定尺寸的 PNG（只需文件头合法即可，守卫不解码像素）。 */
function pngBytes(width, height) {
  const buf = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brand-drift-"));
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

add("readPngSize：非 PNG 返回 null（不误判）", () => {
  const r = makeRepo({ "x.png": Buffer.from("not a png at all") });
  try {
    assert.equal(readPngSize(path.join(r.dir, "x.png")), null);
  } finally {
    r.cleanup();
  }
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
