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
 *   ⑤ 两套形象都存在（狐狸在、六边形也在）——不是「替换」，是分层。
 *
 * 零依赖：node:fs / node:path（读 PNG 尺寸只读文件头，不解码像素）。
 * 用法：node scripts/check-brand-drift.mjs [--json]
 * 自检：node scripts/check-brand-drift.selftest.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");

/** 狐狸的位图源（唯一事实源）。 */
export const FOX_BARE = "design-system/brand/source/acf-mark-bare.png";
/** 狐狸源图的约定：正方形、至少 1024（桌面图标要 1024 源）。 */
export const FOX_MIN_SIZE = 1024;
/** 狐狸生成物与落地副本。 */
export const FOX_GENERATED = "design-system/brand/generated/acf-fox-256.png";
export const FOX_SVG = "design-system/brand/svg/acf-fox.svg";
export const FOX_COPIES = ["apps/admin-web/public/acf-fox.svg", "packages/docs-site/public/logo.svg"];
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
