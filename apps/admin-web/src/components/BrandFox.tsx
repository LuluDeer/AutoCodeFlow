/**
 * 吉祥物「小狐」——中台里的品牌形象位。
 *
 * 为什么是一个组件而不是各处直接写 `<img src="/acf-fox.svg">`：
 *   · **形象分层**（`design-system/brand/README.md` §4）：狐狸 = 产品形象，只出现在
 *     人看得见的地方（侧边栏标志、登录页、404、空态）；六边形 + 箭头 = 状态语汇，
 *     留给托盘与状态指示。把位置收进一个组件，才不会下一次改版又在某个页面
 *     塞回一个闪电图标或六边形；
 *   · **尺寸下限**：狐狸在 32px 以上才立得住（16–24px 是一团糊，品牌文档实测），
 *     所以这里把默认尺寸钉在 32，并在 JSDoc 里写明不要再往小调；
 *   · **可访问性**：吉祥物在所有这些位置都是**装饰**——旁边总有产品名或可读标题，
 *     所以默认 `alt=""` + `aria-hidden`，读屏不会多念一个「AutoCodeFlow」。
 *     若将来真把它当**信息**用（例如空态的说明配图），显式传 `alt` 才会进无障碍树。
 *
 * 资源：`apps/admin-web/public/acf-fox.svg` 是 `scripts/brand/build-fox-assets.py`
 * 产出的 256 档内嵌位图（透明底、无底板），与文档站 logo、桌面图标同源；
 * 由 `scripts/check-brand-drift.mjs` 保证「源图改了没重新生成」会被 CI 抓住。
 */
import type { CSSProperties } from 'react';

/** 狐狸的可用尺寸档位：32 = 侧边栏标志；48/96/160 = 页面级形象位。 */
export type FoxSize = 32 | 48 | 96 | 160;

export interface BrandFoxProps {
  /** 边长（px）。低于 32 不要用——品牌文档实测那里只剩一团糊。 */
  size?: FoxSize;
  /**
   * 可访问名。默认 `''`（纯装饰）。传值即视为信息图，会进入无障碍树。
   * 注意：不要传中文——它会进 i18n 硬编码扫描的基线（本组件的默认用法不需要）。
   */
  alt?: string;
  /** 附加样式（对齐、动画等）。尺寸请走 `size`，不要在这里覆盖宽高。 */
  style?: CSSProperties;
  className?: string;
}

export default function BrandFox({ size = 32, alt = '', style, className }: BrandFoxProps) {
  const decorative = alt === '';
  /**
   * LHCI-LCP（2026-11-09）：**页面级形象位**（size >= 96）是本仓的首屏 LCP 元素
   * （登录页实测 LCP = 这张图，96×96）。给它 `fetchpriority="high"` 让浏览器在
   * 发现它时优先下载；配合 `index.html` 里对同一 URL 的 `<link rel="preload">`，
   * Lighthouse 的 `lcp-discovery-insight` 两项检查（`requestDiscoverable` /
   * `priorityHinted`）才真正成立。
   *
   * 侧边栏那种 32px 的装饰位**不加**：它不在首屏关键路径上，抢带宽只会拖慢文字。
   */
  const isHero = size >= 96;
  return (
    <img
      src="/acf-fox.svg"
      width={size}
      height={size}
      alt={alt}
      // 装饰图对读屏隐藏；有 alt 时保持可见性（两者互斥，antd/React 都接受）
      aria-hidden={decorative || undefined}
      // 显式宽高 = 预留布局空间，避免图片解码时把标题挤动（CLS）
      style={{ display: 'block', width: size, height: size, objectFit: 'contain', ...style }}
      className={className}
      // 首屏可见、且是同源小文件：不懒加载，避免标志位出现一帧空框
      loading="eager"
      decoding="async"
      draggable={false}
      fetchPriority={isHero ? 'high' : undefined}
    />
  );
}
