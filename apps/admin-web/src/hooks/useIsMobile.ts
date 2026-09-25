import { useEffect, useState } from 'react';

/**
 * MOBILE-CARD-01：移动端断点判定。
 *
 * 断点与 index.css 的 ui09 媒体查询（≤768px）保持同一数值——CSS 承载壳层
 * 适配（抽屉侧栏/隐藏时钟），本 hook 承载「表格 → 卡片列表」这类**结构级**
 * 降级（CSS 无法把 Table 变成卡片）。
 *
 * jsdom/SSR 安全：matchMedia 缺席时恒 false（桌面形态）——既有单测渲染
 * 的都是桌面 Table，不受影响。
 */
const QUERY = '(max-width: 768px)';

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(QUERY).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // 初值再同步一次（组件挂载晚于首帧时与 CSS 断点对齐）
    setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
