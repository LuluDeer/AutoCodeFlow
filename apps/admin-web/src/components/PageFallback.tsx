import { Skeleton } from 'antd';

/**
 * Lazy-route Suspense fallback（router.tsx 页面级代码分包加载占位）。
 * UI-08：由纯文字「加载中...」升级为骨架屏（段落形态近似任意页面的首屏结构）。
 */
export default function PageFallback() {
  return (
    <div style={{ padding: 24 }}>
      <Skeleton active title paragraph={{ rows: 4 }} />
    </div>
  );
}
