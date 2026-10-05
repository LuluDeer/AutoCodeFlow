import React from 'react';
// i18n 二期收尾：兜底 UI 文案入双语表（zh 值与原硬编码逐字一致）。
// i18n.ts 为纯常量模块，静态 import 不会引入新的失败面（若它求值失败，
// 本模块同样未定义，边界本就无从兜底——不改变既有语义）。
import { createCfgTexts, resolveRendererLocale } from '../i18n';

const t = createCfgTexts(resolveRendererLocale(() => navigator.language));

/**
 * NETOPT-6⑥：渲染层唯一的全局错误边界。
 *
 * 背景：main.tsx 此前直接 render(<App />)，整棵渲染树没有任何边界——任一
 * 组件渲染期抛错（preload 桥缺失、IPC 返回意外形状触发的 TypeError 等，
 * EXP-09 记录过完全相同的事故形态）都会被 React 逐层上抛并卸载整棵树，
 * 窗口只剩背景色（白屏），用户唯一出路是盲杀进程。EXP-09 那类逐调用点
 * typeof/.catch 守卫永远追不完渲染树的意外分支——这里在树外层兜底。
 *
 * 取舍（极简边界，刻意不做的事）：
 *   * 不做错误上报——桌面端没有收集渠道，electron-log 渲染通道若缺桥，
 *     在边界里再打日志只会二次爆炸，故仅 console.error；
 *   * 不提供「继续运行」恢复按钮——渲染崩溃后的组件状态一致性不可信，
 *     整树重载是唯一安全动作。
 *
 * 无障碍：role="alert"（打断式错误），样式走 app.css 设计 token。
 */
interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: unknown): void {
    console.error('[ErrorBoundary] render tree crashed:', error, info);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div className="error-boundary" role="alert">
          <h1 className="error-boundary-title">{t('errorBoundary.title')}</h1>
          <p className="error-boundary-summary">{error.message || String(error)}</p>
          <p className="error-boundary-hint">
            {t('errorBoundary.hint')}
          </p>
          <button className="btn btn-primary" onClick={this.handleReload}>
            {t('errorBoundary.reload')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
