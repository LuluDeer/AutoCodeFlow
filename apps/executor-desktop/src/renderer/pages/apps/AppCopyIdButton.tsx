import React, { useEffect, useState } from 'react';
import Icon from '../../components/Icon';

type Translate = (key: string, ...args: (string | number | boolean)[]) => string;

/**
 * 应用详情抽屉内的「复制 ID」按钮：独立维护局部三态反馈与 aria-live 播报，
 * 避免依赖抽屉背后可能被遮挡的页面顶部 notice。
 */
export default function AppCopyIdButton({ appId, t }: { appId: string; t: Translate }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [tooLarge, setTooLarge] = useState(false);

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [state]);

  function handleCopy() {
    window.electronAPI
      .writeClipboardText(appId)
      .then((res) => {
        if (res?.ok === false) {
          setTooLarge(res.error === 'tooLarge');
          setState('error');
        } else {
          setTooLarge(false);
          setState('copied');
        }
      })
      .catch(() => {
        setTooLarge(false);
        setState('error');
      });
  }

  const errorText = tooLarge ? t('status.copyTooLarge') : t('status.copyFailed');
  const label = state === 'copied'
    ? t('status.copied')
    : state === 'error'
      ? errorText
      : t('appx.action.copyId');
  const liveText = state === 'copied'
    ? t('status.copied')
    : state === 'error'
      ? errorText
      : '';

  return (
    <>
      <button
        type="button"
        className={`btn btn-sm appx-copy${state === 'copied' ? ' is-copied' : state === 'error' ? ' is-error' : ''}`}
        onClick={handleCopy}
        title={state === 'error' ? errorText : `${t('appx.action.copyId')}: ${appId}`}
        aria-label={label}
      >
        <Icon name={state === 'copied' ? 'check' : state === 'error' ? 'warning' : 'copy'} /> {label}
      </button>
      <span className="appx-sr-only" role="status" aria-live="polite">{liveText}</span>
    </>
  );
}
