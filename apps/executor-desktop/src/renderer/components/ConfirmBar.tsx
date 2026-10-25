import React, { useEffect, useRef } from 'react';
import { createCfgTexts, resolveRendererLocale } from '../i18n';

/** V4 后续优化（6）：缺省取消钮文案入双语表。 */
const t = createCfgTexts(resolveRendererLocale(() => navigator.language));

/**
 * 页内二次确认条（V4-4 X-01 终结项，v3 遗留的组件化欠账）。
 *
 * 统一此前五处各自为政的确认形态（清历史/停机/卸载/删版本/保存影响）：
 *  - 结构：strong 标题 + 说明 + 右置按钮组，role="alertdialog" + aria-labelledby；
 *  - 键盘规范（此前停机确认 autoFocus 在危险主钮、卸载确认却在「取消」，
 *    同类对话框默认焦点相反）：**主钮（确认）统一 autoFocus**、Esc=取消、
 *    Enter=确认（焦点在主钮上浏览器默认行为）、关闭时焦点归还触发钮；
 *  - 变体：danger=红（破坏性：删除/卸载/停机/清除），impact=琥珀（高影响
 *    非破坏：运行中保存会重启执行器）。
 *
 * 页内条（非模态）：不做焦点圈闭（Tab 仍可离开），配合 autoFocus+Esc 已覆盖
 * 键盘动线；调用方保证 titleId 同页唯一。
 */
interface ConfirmBarProps {
  titleId: string;
  title: string;
  description?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** danger=红（破坏性，默认）；impact=琥珀（高影响非破坏） */
  variant?: 'danger' | 'impact';
  /** 默认 true：主钮统一默认焦点（X-01 规范收口） */
  autoFocusConfirm?: boolean;
  confirmDisabled?: boolean;
  cancelDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmBar({
  titleId,
  title,
  description,
  confirmLabel,
  cancelLabel = t('ui.cancel'),
  variant = 'danger',
  autoFocusConfirm = true,
  confirmDisabled = false,
  cancelDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmBarProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // 焦点管理：进入时按规范聚焦主钮；卸载（确认/取消/Esc 任一路径）时把焦点
  // 还给触发钮——避免焦点落回 body 后键盘用户从页首重新 Tab。
  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (autoFocusConfirm) confirmRef.current?.focus();
    return () => { returnFocusRef.current?.focus(); };
    // 仅挂载时执行（确认/取消回调不重挂）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc=取消：文档级监听（页内条不是模态，无需圈闭）。
  //
  // F-35（UIUX 审计）：stopPropagation 隔离不了**同一个 document** 上的其他
  // keydown 监听——stopPropagation 只阻止事件跨越节点边界，同节点（document）
  // 上的其余监听器照常执行；stopImmediatePropagation 才拦得住。且单纯把
  // stopPropagation 换成 stopImmediatePropagation 还不够：本 effect 依赖
  // [onCancel]（父组件每次渲染传新箭头函数），监听器会随父渲染反复
  // 「先卸后挂」挪到监听列表末尾——而全屏查看器（LogViewer）的 Esc 监听同样
  // 挂在 document、注册顺序因此不确定，bubble 阶段的先后不可依赖。
  // 故挂到**捕获阶段**（第三个参数 true）：document 捕获确定性地先于
  // document 冒泡执行，与注册顺序无关；stopImmediatePropagation 在捕获期
  // 拦截后，后续路径（含查看器的 document 冒泡监听）整段不再触发——确认条
  // 打开期间 Esc 只语义为「取消确认」，不再同时关掉全屏查看器。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onCancel();
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [onCancel]);

  return (
    <div className={`confirm-bar confirm-bar-${variant}`} role="alertdialog" aria-labelledby={titleId}>
      <div className="confirm-bar-text">
        <strong id={titleId}>{title}</strong>
        {description != null && <span>{description}</span>}
      </div>
      <div className="confirm-bar-actions">
        <button
          ref={confirmRef}
          type="button"
          className={`btn btn-sm ${variant === 'danger' ? 'btn-danger' : 'btn-primary'}`}
          disabled={confirmDisabled}
          onClick={onConfirm}
        >{confirmLabel}</button>
        <button type="button" className="btn btn-sm" disabled={cancelDisabled} onClick={onCancel}>{cancelLabel}</button>
      </div>
    </div>
  );
}
