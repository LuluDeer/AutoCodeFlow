/**
 * 状态页 hero 区「打开工作台」按钮：独立子组件，避免把 StatusWindow.tsx
 * 这个棘轮文件的超长渲染函数继续推高。只依赖 i18n 与 electronAPI.openWorkbench。
 */
import React, { useState } from 'react';
import Icon from '../../components/Icon';
import { ipcErrorMessage } from '../../ipc-error';
import { createCfgTexts, resolveRendererLocale } from '../../i18n';

const t = createCfgTexts(resolveRendererLocale(() => navigator.language));

export default function WorkbenchOpenButton(): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  async function open(): Promise<void> {
    setError(null);
    try {
      const result = await window.electronAPI.openWorkbench();
      if (!result?.ok) setError(t('status.workbenchOpenFailed'));
    } catch (err) {
      setError(ipcErrorMessage(err) || t('status.workbenchOpenFailed'));
    }
  }
  return (
    <>
      <button type="button" className="btn btn-outline" onClick={() => void open()} title={t('status.openWorkbenchTitle')}>
        <Icon name="external" className="icon-xs" /> {t('status.openWorkbench')}
      </button>
      {error && <div className="hero-error" role="alert">{error}</div>}
    </>
  );
}
