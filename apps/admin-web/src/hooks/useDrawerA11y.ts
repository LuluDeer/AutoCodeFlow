import { useCallback, useRef } from 'react';

/**
 * A11Y-DRAWER-01（P2 审计）：AntD Drawer 打开后的焦点管理。
 *
 * 问题：Drawer 打开后焦点仍留在触发按钮上（rc-drawer 不做焦点管理），
 * 键盘/读屏用户要么「看不见」抽屉内容，要么必须 Tab 穿过整个背景页才能
 * 摸到抽屉里的控件；关闭后焦点也不归还触发入口，键盘位置凭空丢失。
 *
 * 用法（2 行接入，四页同款——AgentSessions/Projects/Sops/TaskDetail）：
 *   const drawerA11y = useDrawerA11y();
 *   <Drawer afterOpenChange={drawerA11y.afterOpenChange} onClose={close} …>
 *     <div ref={drawerA11y.contentRef}>…</div>
 *   </Drawer>
 *
 * 机制：
 *  - open=true：此刻焦点仍在触发按钮（表格场景即当前行的入口按钮），
 *    先记住 document.activeElement，再把焦点移入抽屉内容首个可交互元素
 *    （表单控件 / Tab / 按钮）；
 *  - open=false：焦点归还触发元素。Esc / 遮罩 / 关闭钮任何关闭路径都汇入
 *    afterOpenChange(false)——AntD Drawer 的 keyboard（Esc 关闭）默认开启，
 *    四页均未禁用，故无需像 MainLayout UI-12 那样自挂 keydown 监听。
 *
 * 为什么用 ref 定位而不是 querySelector('.ant-drawer-open')：一页可能同时
 * 存在多个浮层，按类名全局查询会命中错层；contentRef 天然作用域收窄。
 * 焦点归还以 isConnected 判活——触发按钮所在行可能已因刷新被替换。
 */

/** 抽屉内容内首个可交互元素的候选（文档序命中即聚焦） */
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useDrawerA11y() {
  /** 挂在 Drawer children 根节点（内容包一层 div），把查询收窄到本抽屉 */
  const contentRef = useRef<HTMLDivElement | null>(null);
  /** open=true 时刻的 document.activeElement（= 触发按钮），关闭时归还 */
  const returnFocusRef = useRef<HTMLElement | null>(null);

  /** 焦点归还（幂等：ref 取空即 no-op；onClose 与 afterOpenChange 双路都可达） */
  const restoreFocus = useCallback(() => {
    const el = returnFocusRef.current;
    returnFocusRef.current = null;
    if (el && el.isConnected && typeof el.focus === 'function') el.focus();
  }, []);

  const afterOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        returnFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const panel = contentRef.current;
        if (!panel) return;
        const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
        // offsetParent 为 null 的元素（display:none 子树 / jsdom 无布局）跳过：
        // 真实浏览器里抽屉面板是 position:fixed，可见控件的 offsetParent 恒非空；
        // jsdom 下恒为 null → 不聚焦，测试环境零副作用。
        if (first && first.offsetParent !== null) first.focus();
      } else {
        restoreFocus();
      }
    },
    [restoreFocus],
  );

  return { contentRef, afterOpenChange, restoreFocus };
}
