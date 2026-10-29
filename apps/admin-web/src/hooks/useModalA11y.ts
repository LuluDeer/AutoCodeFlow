import { useEffect, useRef } from 'react';

/**
 * A11Y-MODAL-01（WEB-6，2026-10-29 第三轮 UX 审计 P3）：antd `Modal` 打开时的
 * 焦点管理补齐。
 *
 * 为什么需要它（而不是「antd 都兜住了」）：rc-dialog 的焦点动作全部挂在
 * `onDialogVisibleChanged` 上——也就是 **CSSMotion 的开/关过渡结束**之后：
 *   - 打开：`focusDialogContent()` 把焦点放到 `.ant-modal` 容器（tabindex=-1），
 *     **不是**首个可交互控件 → 用户要先 Tab 一次才摸到第一个字段；
 *   - 关闭：`doClose()` 把焦点还给 `lastOutSideActiveElementRef`，而该 ref 只在
 *     真实鼠标/焦点事件里落值。
 * 过渡跑不完的场景（jsdom、`theme.token.motion: false`、部分降低动效环境）里
 * 这两步**都不会发生**，焦点停在 `<body>`。本 hook 用「open 变化」这一确定性
 * 信号做同一件事，与 `useDrawerA11y`（A11Y-DRAWER-01）同款机制、同款纪律。
 *
 * 用法：
 *   const modalA11y = useModalA11y(open);
 *   <Modal open={open} …><div ref={modalA11y.contentRef}>…</div></Modal>
 *
 * 不留残余副作用：关闭时只认 isConnected 的元素（触发按钮所在行可能已被刷新
 * 替换）；打开时用有限次重试等待 Portal 容器挂载（rc-dialog 先创建容器再渲染
 * 内容，同一 commit 内拿不到子树）。
 */

/** 弹窗内容内首个可交互元素的候选（文档序命中即聚焦） */
const FOCUSABLE_SELECTOR = [
  'input:not([disabled]):not([type="hidden"])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  'button:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** 容器挂载重试次数（16ms × 10 ≈ 一帧到 160ms，Portal 同步挂载时首轮即命中） */
const MAX_FOCUS_RETRIES = 10;

export function useModalA11y(open: boolean) {
  /** 弹窗内容根节点：把「首个可交互元素」的查询收窄到本弹窗，不误抓背景页控件 */
  const contentRef = useRef<HTMLDivElement | null>(null);
  /** open=true 时刻的 document.activeElement（= 触发按钮），关闭时归还 */
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      // 焦点归还（幂等：ref 取空即 no-op）
      const el = returnFocusRef.current;
      returnFocusRef.current = null;
      if (el && el.isConnected) el.focus();
      return;
    }

    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    let retries = 0;
    let timer: number | undefined;
    const focusFirst = () => {
      const first = contentRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? null;
      if (first) {
        first.focus();
        return;
      }
      if (retries < MAX_FOCUS_RETRIES) {
        retries += 1;
        timer = window.setTimeout(focusFirst, 16);
      }
    };
    focusFirst();

    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open]);

  return { contentRef };
}
