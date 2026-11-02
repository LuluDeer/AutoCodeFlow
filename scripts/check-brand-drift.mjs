#!/usr/bin/env node
/**
 * BRAND-DRIFT：品牌资产的「事实源 → 产物」一致性守卫。
 *
 * 为什么需要它：品牌流水线有两段（矢量六边形 + 位图狐狸），两段都有「源」与「落地副本」。
 * 这类资产的腐烂方式**全是静默的**：
 *   · 改了源图忘了重出 PNG ⇒ 线上还是旧图（而且没人会发现，因为图「看着还行」）；
 *   · 手改了落地副本（favicon / logo.svg / icon.png）⇒ 下次出图被冲掉，
 *     而中间那段时间线上跑着一份**仓库里没有源**的图；
 *   · 两条流水线抢同一个落地文件（logo.svg）⇒ 谁最后跑谁赢，与「谁是源」无关。
 *
 * 判据（每条都给得出「改哪」）：
 *   ① 狐狸落地副本与生成物**逐字节一致**（admin-web favicon / docs-site logo）；
 *   ② 狐狸源图存在且尺寸符合约定（正方形、≥1024）；
 *   ③ 桌面图标三件套由**狐狸**生成（抽样比对像素），托盘三件套由**六边形**生成
 *      （形状恒定、颜色表状态）——「形象分工」被机械钉住，不靠人记；
 *   ④ `build-brand-assets.py` **不得**再写狐狸占用的落地文件
 *      （曾经真发生过：brand:svg 会把文档站 logo 静默冲回六边形）；
 *   ⑤ 两套形象都存在（狐狸在、六边形也在）——不是「替换」，是分层；
 *   ⑥ 狐狸必须占住**产品形象位**：README 首图内嵌它、中台侧边栏标志位与
 *      登录页 / 404 / 空态都用 `<BrandFox>`（2026-11-02 用户要求）。
 *      这类回退完全静默——图照样出、页面照样渲染，只是形象又变回一个通用几何；
 *   ⑦ **桌面执行器渲染层**的品牌位同样是狐狸（顶栏 / 向导品牌位 / 向导 hero），
 *      且该 PNG 由 `build-fox-assets.py` 产出、与安装包图标同源。托盘三态**刻意不换**
 *      —— 那是状态语汇（形状恒定、颜色表状态），不是产品形象。
 *
 * 零依赖：node:fs / node:path（读 PNG 尺寸只读文件头，不解码像素）。
 * 用法：node scripts/check-brand-drift.mjs [--json]
 * 自检：node scripts/check-brand-drift.selftest.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");

/** 狐狸的位图源（唯一事实源）。 */
export const FOX_BARE = "design-system/brand/source/acf-mark-bare.png";
/** 狐狸源图的约定：正方形、至少 1024（桌面图标要 1024 源）。 */
export const FOX_MIN_SIZE = 1024;
/** 狐狸生成物与落地副本。 */
export const FOX_GENERATED = "design-system/brand/generated/acf-fox-256.png";
/** 构建期写出的居中度量（含产出物 sha256，防过期）。 */
export const FOX_METRICS = "design-system/brand/generated/acf-fox-metrics.json";
/** 居中容差：bbox 中心与画布中心的偏差不得超过 1%。 */
export const CENTER_TOLERANCE = 0.01;
export const FOX_SVG = "design-system/brand/svg/acf-fox.svg";
export const FOX_COPIES = ["apps/admin-web/public/acf-fox.svg", "packages/docs-site/public/logo.svg"];
/**
 * 狐狸必须出现的**产品形象位**（2026-11-02，用户直接要求「中台页面加吉祥物、
 * 品牌宽图一起调」）。两处：
 *   ① README 首图（`build-brand-assets.py` 的 banner）——首图是产品形象位；
 *   ② 中台侧边栏标志位 + 登录页 / 404 / 空态（`<BrandFox>`）。
 * 为什么要钉：这类回退**完全静默**——把 `fox_inline()` 换回 `mark_inline()`、
 * 把 `<BrandFox>` 换回一个闪电 icon，图照样出、页面照样渲染，只是产品形象又变回
 * 一个通用几何标记。与判据④同源（那条抓的是「矢量脚本冲掉狐狸副本」），
 * 这条抓的是「页面/首图又不用狐狸了」。
 */
export const FOX_BANNER_SVGS = [
  "design-system/brand/svg/banner-en.svg",
  "design-system/brand/svg/banner-zh.svg",
];
export const FOX_SIDEBAR = "apps/admin-web/src/layouts/MainLayout.tsx";
/**
 * 桌面执行器渲染层的品牌位（2026-11-02，用户要求「客户端页面的图标也换狐狸」）。
 * 三处：顶栏 titlebar-mark、向导品牌位 wizard-brand-icon、向导 hero wizard-hero-glyph。
 * 资源由 build-fox-assets.py 产（`apps/executor-desktop/src/renderer/assets/acf-fox.png`），
 * 与安装包三件套（icon.png/ico/icns）、中台 favicon **同源同一次构建**。
 * 托盘三态（tray-*.png）**刻意不换**——那是状态语汇，不是产品形象。
 */
export const DESKTOP_FOX_PNG = "apps/executor-desktop/src/renderer/assets/acf-fox.png";
/**
 * README 标题旁的独立狐狸图标（2026-11-02，用户建议「项目大标题边上加独立狐狸」）。
 * 96 档 = 48px 显示的 2x；由 build-fox-assets.py 产，不手缩（手缩的图会在源图更新后
 * 悄悄变旧——这正是这条流水线存在的理由）。README 三语里共 4 处引用（英/中两个 H1 +
 * 各自的锚点区块），任一处的路径失效都会让标题旁出现破图。
 */
export const FOX_README_ICON = "docs/assets/acf-fox-96.png";
export const FOX_README_FILES = ["README.md", "README.en.md", "README.zh.md"];
export const DESKTOP_RENDERER = [
  "apps/executor-desktop/src/renderer/App.tsx",
  "apps/executor-desktop/src/renderer/pages/Wizard.tsx",
];
export const FOX_PAGES = [
  "apps/admin-web/src/pages/LoginPage.tsx",
  "apps/admin-web/src/pages/NotFoundPage.tsx",
  "apps/admin-web/src/components/dashboard/DashboardEmptyGuide.tsx",
];
/** 六边形（托盘语汇）必须在场。 */
export const HEX_SVG = "design-system/brand/svg/acf-mark.svg";
export const TRAY_FILES = [
  "apps/executor-desktop/assets/tray-online@2x.png",
  "apps/executor-desktop/assets/tray-offline@2x.png",
  "apps/executor-desktop/assets/tray-pending@2x.png",
];
export const APP_ICON_FILES = [
  "apps/executor-desktop/assets/icon.png",
  "apps/executor-desktop/assets/icon.ico",
  "apps/executor-desktop/assets/icon.icns",
];

const norm = (p) => p.replace(/\\/g, "/");

/** 只读 PNG 头拿尺寸（不解码像素——守卫不该在像素上花时间）。 */
export function readPngSize(absPath) {
  const buf = fs.readFileSync(absPath);
  // PNG 签名 8 字节 + IHDR：宽高在 16..24
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** 判据①③ 的核心：两个 PNG 文件是否「同图」（抽样像素比对，不逐字节）。 */
export function looksIdentical(aBuf, bBuf, samples = 64) {
  if (aBuf.length !== bBuf.length) return false;
  if (aBuf.equals(bBuf)) return true;
  // 抽样比对：把文件按固定间隔取若干片段比对（足以发现「换了另一张图」）
  const step = Math.max(1, Math.floor(aBuf.length / samples));
  for (let off = 0; off < aBuf.length; off += step) {
    if (aBuf[off] !== bBuf[off]) return false;
  }
  return true;
}

export function checkBrandDrift(root = REPO_ROOT) {
  const errors = [];
  const read = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs);
  };

  // ── 判据②：狐狸源图存在且尺寸合规 ────────────────────────────────────
  const foxSrc = read(FOX_BARE);
  if (!foxSrc) {
    errors.push(`缺少狐狸源图 ${FOX_BARE}——狐狸形象的事实源没了，其余产物无法复现`);
  } else {
    const size = readPngSize(path.join(root, FOX_BARE));
    if (!size) {
      errors.push(`${FOX_BARE} 不是 PNG（签名不对）——请确认它就是那张透明底的狐狸图`);
    } else if (size.width !== size.height) {
      errors.push(`${FOX_BARE} 不是正方形（${size.width}×${size.height}）——图标要求正方形（桌面图标与 favicon 都是方的）`);
    } else if (size.width < FOX_MIN_SIZE) {
      errors.push(`${FOX_BARE} 只有 ${size.width}px（约定 ≥ ${FOX_MIN_SIZE}）——桌面图标需要 1024 源`);
    }
  }

  // ── 判据①：落地副本与生成物逐字节一致 ────────────────────────────────
  const gen = read(FOX_GENERATED);
  if (!gen) {
    errors.push(`缺少狐狸生成物 ${FOX_GENERATED}——跑 python3 scripts/brand/build-fox-assets.py`);
  } else {
    const genSvg = read(FOX_SVG);
    if (!genSvg) {
      errors.push(`缺少 ${FOX_SVG}——狐狸的 SVG 载体（内嵌位图）不见了`);
    } else {
      for (const copy of FOX_COPIES) {
        const c = read(copy);
        if (!c) {
          errors.push(`缺少落地副本 ${copy}——中台 favicon / 文档站 logo 会 404`);
        } else if (!c.equals(genSvg)) {
          errors.push(
            `${copy} 与 ${FOX_SVG} 不一致——落地副本被手改过或没跟着重新生成` +
              "（跑 python3 scripts/brand/build-fox-assets.py）",
          );
        }
      }
    }
  }

  // ── 判据③：狐狸图标必须**居中**（2026-11-02，用户肉眼发现「偏右」）────
  // 为什么会偏右：源图整幅铺了一层 alpha=1 的近透明残影，用 `getbbox()` 裁剪时
  // 整块画布都被算成内容，裁出来左边多 203px 空白，居中后可见部分被推到右边 5.7%。
  // 修法在 build-fox-assets.py（按 alpha≥8 取 bbox + 构建期 assert_centered）。
  //
  // 这里怎么钉：构建期把实测的居中偏移与**产出物的 sha256** 一起写进 metrics.json；
  // 守卫重算产出物的 sha256 与 metrics 里的比对（防止 metrics 过期/手改），
  // 再断言偏移在容差内。⇒ 改坏裁剪逻辑 ⇒ 构建期直接失败；改坏 metrics ⇒ 哈希对不上。
  if (gen) {
    const genSize = readPngSize(path.join(root, FOX_GENERATED));
    if (!genSize) {
      errors.push(`${FOX_GENERATED} 不是合法 PNG——无法校验`);
    } else if (genSize.width !== genSize.height) {
      errors.push(`${FOX_GENERATED} 不是正方形（${genSize.width}×${genSize.height}）——图标必须是方的`);
    }
    const metrics = read(FOX_METRICS);
    if (!metrics) {
      errors.push(`缺少 ${FOX_METRICS}——没有居中度量，无法确认图标是否居中`);
    } else {
      let m = null;
      try {
        m = JSON.parse(metrics.toString("utf8"));
      } catch {
        errors.push(`${FOX_METRICS} 不是合法 JSON——无法确认图标是否居中`);
      }
      if (m) {
        const sha = createHash("sha256").update(gen).digest("hex");
        if (m.sha256 !== sha) {
          errors.push(
            `${FOX_METRICS} 记录的 sha256 与当前 ${FOX_GENERATED} 不一致——` +
              "度量已过期（改了源图或裁剪逻辑却没重新生成？）",
          );
        }
        const dx = Math.abs(m.centerOffsetX ?? 1);
        const dy = Math.abs(m.centerOffsetY ?? 1);
        if (dx > CENTER_TOLERANCE || dy > CENTER_TOLERANCE) {
          errors.push(
            `狐狸图标不居中：水平 ${(m.centerOffsetX ?? 0) * 100 >= 0 ? "+" : ""}` +
              `${((m.centerOffsetX ?? 0) * 100).toFixed(2)}%，垂直 ` +
              `${((m.centerOffsetY ?? 0) * 100).toFixed(2)}%（容差 ±${CENTER_TOLERANCE * 100}%）` +
              "——检查 build-fox-assets.py 的 content_bbox 阈值",
          );
        }
      }
    }
  }

  // ── 判据⑤：两套形象都在场 ────────────────────────────────────────────
  if (!read(HEX_SVG)) {
    errors.push(`缺少六边形标志 ${HEX_SVG}——托盘图标与产品语义依赖它（分层，不是替换）`);
  }
  for (const f of TRAY_FILES) {
    if (!read(f)) errors.push(`缺少托盘图标 ${f}——托盘是状态语汇，必须在场`);
  }

  // ── 判据④：矢量脚本不得再写狐狸占用的落地文件 ────────────────────────
  const buildPy = read("scripts/brand/build-brand-assets.py");
  if (buildPy) {
    const text = buildPy.toString("utf8");
    for (const copy of FOX_COPIES) {
      const base = path.basename(copy);
      if (text.includes(`"${copy}"`)) {
        errors.push(
          `scripts/brand/build-brand-assets.py 仍在写 ${copy}——` +
            "`npm run brand:svg` 会把狐狸静默冲回六边形（2026-11-02 已发生过一次）",
        );
      } else if (text.includes(base) && base !== "acf-mark.svg") {
        errors.push(
          `scripts/brand/build-brand-assets.py 疑似仍写 ${base}——` +
            "核对它有没有覆盖狐狸占用的落地文件",
        );
      }
    }
  }

  // ── 判据⑥：狐狸必须占住产品形象位（首图 + 中台标志位/登录页/404/空态）────
  // 为什么是「查字符串」而不是「查像素」：这里要守的是**决定**，不是渲染结果。
  // 首图的狐狸是 `<image href="data:image/png;base64,…">`，页面里是 `<BrandFox>`；
  // 把它们换回 mark_inline / 一个 icon，图与页面都不会报错——只有源码判据能抓住。
  // 报错文本必须给「改哪」：这条判据的修法永远是「把狐狸放回去」，不是改守卫。
  for (const svg of FOX_BANNER_SVGS) {
    const body = read(svg);
    if (!body) {
      errors.push(`缺少首图源 ${svg}——跑 python3 scripts/brand/build-brand-assets.py`);
    } else if (!body.toString("utf8").includes("data:image/png;base64,")) {
      errors.push(
        `${svg} 里没有内嵌狐狸（找不到 data:image/png;base64,）——` +
          "首图是产品形象位，狐狸必须在那儿（六边形只留给托盘/架构图）",
      );
    }
  }
  const sidebar = read(FOX_SIDEBAR);
  if (!sidebar) {
    errors.push(`缺少中台外壳 ${FOX_SIDEBAR}——无法确认侧边栏标志位是不是狐狸`);
  } else if (!sidebar.toString("utf8").includes("<BrandFox")) {
    errors.push(
      `${FOX_SIDEBAR} 的侧边栏标志位没有用 <BrandFox>——` +
        "狐狸是中台的产品形象（2026-11-02 决定），回退成通用图标会静默丢形象",
    );
  }
  for (const page of FOX_PAGES) {
    const body = read(page);
    if (!body) {
      errors.push(`缺少 ${page}——狐狸的中台形象位之一不见了`);
    } else if (!body.toString("utf8").includes("BrandFox")) {
      errors.push(
        `${page} 没有用 BrandFox——登录页 / 404 / 空态是狐狸的三个形象位` +
          "（改回 antd 默认插图或一个 icon 不会报错，只会静默丢品牌）",
      );
    }
  }

  // ── 判据⑦：桌面执行器渲染层的品牌位也是狐狸（托盘三态不动）──────────
  // 为什么和判据⑥分开：⑥ 守的是「网页/首图」，这条守的是「客户端窗口」——
  // 两处回退方式不同（那边是 <BrandFox> / data URI，这边是 <img src={foxImg}>），
  // 而且这里**必须**同时确认托盘没被顺手改掉：托盘是状态语汇，形状恒定才读得出状态。
  const desktopFox = read(DESKTOP_FOX_PNG);
  if (!desktopFox) {
    errors.push(
      `缺少桌面渲染层的狐狸 ${DESKTOP_FOX_PNG}——` +
        "跑 python3 scripts/brand/build-fox-assets.py（它与安装包图标同一次产出）",
    );
  } else if (!readPngSize(path.join(root, DESKTOP_FOX_PNG))) {
    errors.push(`${DESKTOP_FOX_PNG} 不是合法 PNG——渲染层的 <img> 会显示成破图`);
  }
  for (const file of DESKTOP_RENDERER) {
    const body = read(file);
    if (!body) {
      errors.push(`缺少 ${file}——桌面品牌位之一不见了`);
    } else if (!body.toString("utf8").includes("src={foxImg}")) {
      errors.push(
        `${file} 的品牌位没有渲染狐狸（找不到 src={foxImg}）——` +
          "改回 <Icon name=\"zap\" /> 不会报错，只会静默丢掉客户端品牌",
      );
    }
  }

  // ── 判据⑧：README 标题旁的独立狐狸图标 ──────────────────────────────
  // 三语 README 都用同一张（英文 2 处 H1 + 中文 2 处；英文产物是 README.md 的切片，
  // 所以只查源文件不够——切片产物也要查，否则 readme-sync 重生成后可能留旧路径）。
  const readmeIcon = read(FOX_README_ICON);
  if (!readmeIcon) {
    errors.push(
      `缺少 README 标题图标 ${FOX_README_ICON}——` +
        "跑 python3 scripts/brand/build-fox-assets.py（96 档 = 48px 显示的 2x）",
    );
  } else {
    const size = readPngSize(path.join(root, FOX_README_ICON));
    if (!size) errors.push(`${FOX_README_ICON} 不是合法 PNG——README 里会显示成破图`);
    else if (size.width !== size.height) {
      errors.push(`${FOX_README_ICON} 不是正方形（${size.width}×${size.height}）——标题图标必须方形`);
    }
  }
  for (const file of FOX_README_FILES) {
    const body = read(file);
    if (!body) {
      errors.push(`缺少 ${file}——读不到就无法确认标题图标还在`);
      continue;
    }
    const text = body.toString("utf8");
    if (!text.includes(FOX_README_ICON)) {
      errors.push(
        `${file} 的标题旁没有狐狸图标（找不到 ${FOX_README_ICON}）——` +
          "去掉它不会报错，只会让项目大标题退回纯文字",
      );
    }
  }

  return errors;
}

function main(argv) {
  const errors = checkBrandDrift();
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ errors }, null, 2));
  } else if (errors.length === 0) {
    console.log("✔ 品牌资产无漂移：狐狸源 → 生成物 → 落地副本逐字节一致，六边形与托盘在场");
  } else {
    console.error(`✘ 品牌资产漂移：${errors.length} 项`);
    errors.forEach((e) => console.error(`   · ${e}`));
  }
  return errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
