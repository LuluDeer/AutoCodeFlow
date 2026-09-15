import React, { useCallback, useEffect, useState } from 'react';

/**
 * DSK-05：桌面自动更新的渲染层出口。
 *
 * 背景：主进程 updater.ts（DSK-03）与 preload 通道自始就完整实现，但渲染层
 * 无任何组件订阅——`autoDownload=false` 且无人调用 check/download/install，
 * 导致「检测到新版本」永远无法到达用户，客户端装完即锁死在当前版本。
 * 本组件补上这条断链的最后一环。
 *
 * 状态机（与主进程事件一一对应）：
 *   idle      初始；未检测或尚未发现新版本
 *   available 收到 updater:available → 展示版本号 + 「下载」按钮
 *   downloading 收到 updater:progress → 进度条（首次进度事件后进入）
 *   downloaded  收到 updater:downloaded → 展示「重启并安装」按钮
 *   error       收到 updater:error 或 IPC reject → 展示可重试的错误条
 *
 * 无障碍：整块是 role="status" + aria-live="polite"（进度类信息不该打断
 * 屏幕阅读器当前朗读）；错误态升级为 role="alert"。进度条用原生
 * <progress> 并带 aria-valuenow 语义（<progress> 自带 role="progressbar"）。
 */

type Phase = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';

interface UpdateApi {
  checkForUpdate?: () => Promise<{ ok: boolean }>;
  downloadUpdate?: () => Promise<{ ok: boolean }>;
  installUpdate?: () => Promise<{ ok: boolean }>;
  onUpdateAvailable?: (cb: (p: { version: string; current: string }) => void) => () => void;
  onUpdateProgress?: (cb: (p: { percent: number; transferred: number; total: number }) => void) => () => void;
  onUpdateDownloaded?: (cb: (p: { version: string }) => void) => () => void;
  onUpdateError?: (cb: (p: { message: string }) => void) => () => void;
}

function api(): UpdateApi {
  return ((window as any).electronAPI ?? {}) as UpdateApi;
}

function formatBytes(n: number): string {
  if (!n || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function UpdateBanner() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [version, setVersion] = useState('');
  const [percent, setPercent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [transferred, setTransferred] = useState(0);
  const [total, setTotal] = useState(0);

  // 订阅主进程更新事件。所有订阅走 onXxx 返回的取消函数，卸载时清理，
  // 避免开发模式热重载或窗口重建时监听器泄漏（重复注册会让一次事件多次 setState）。
  useEffect(() => {
    const a = api();
    const offs: Array<() => void> = [];

    if (typeof a.onUpdateAvailable === 'function') {
      offs.push(a.onUpdateAvailable((p) => {
        setVersion(p?.version || '');
        setPhase('available');
        setError('');
      }));
    }
    if (typeof a.onUpdateProgress === 'function') {
      offs.push(a.onUpdateProgress((p) => {
        setPercent(Number.isFinite(p?.percent) ? p.percent : 0);
        setTransferred(Number(p?.transferred) || 0);
        setTotal(Number(p?.total) || 0);
        setPhase('downloading');
      }));
    }
    if (typeof a.onUpdateDownloaded === 'function') {
      offs.push(a.onUpdateDownloaded((p) => {
        if (p?.version) setVersion(p.version);
        setPercent(100);
        setPhase('downloaded');
      }));
    }
    if (typeof a.onUpdateError === 'function') {
      // 主进程对离线/404 是静默的（只落日志）；这里仅当用户已主动发起
      // 下载/安装时才把错误显性化，避免后台检查失败打扰用户。
      offs.push(a.onUpdateError((p) => {
        setError(p?.message || '更新失败');
        setPhase('error');
      }));
    }

    return () => { for (const off of offs) off(); };
  }, []);

  const handleDownload = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await api().downloadUpdate?.();
      // 进度事件会推到 downloading；若 provider 未回推进度则不卡死，保持 available
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }, []);

  const handleInstall = useCallback(async () => {
    setBusy(true);
    try {
      await api().installUpdate?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }, []);

  const handleRetry = useCallback(async () => {
    setBusy(true);
    setError('');
    setPhase('idle');
    try {
      await api().checkForUpdate?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }, []);

  // idle 态不占版面（绝大多数时间用户无需看到更新条）
  if (phase === 'idle') return null;

  if (phase === 'error') {
    return (
      <div className="update-banner update-banner-error" role="alert">
        <span className="update-banner-icon" aria-hidden="true">⚠</span>
        <div className="update-banner-text">
          <strong>更新失败</strong>
          <span>{error}</span>
        </div>
        <div className="update-banner-actions">
          <button className="btn btn-sm" onClick={handleRetry} disabled={busy}>
            {busy ? '检查中…' : '重试'}
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'downloaded') {
    return (
      <div className="update-banner update-banner-ready" role="status" aria-live="polite">
        <span className="update-banner-icon" aria-hidden="true">✦</span>
        <div className="update-banner-text">
          <strong>新版本 {version || ''} 已下载完成</strong>
          <span>重启应用即可完成安装</span>
        </div>
        <div className="update-banner-actions">
          <button className="btn btn-sm btn-success" onClick={handleInstall} disabled={busy}>
            {busy ? '安装中…' : '↻ 重启并安装'}
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'downloading') {
    const pct = Math.max(0, Math.min(100, Math.round(percent)));
    return (
      <div className="update-banner update-banner-downloading" role="status" aria-live="polite">
        <span className="update-banner-icon" aria-hidden="true">↓</span>
        <div className="update-banner-text">
          <strong>正在下载新版本 {version || ''}（{pct}%）</strong>
          {total > 0 && (
            <span>{formatBytes(transferred)} / {formatBytes(total)}</span>
          )}
        </div>
        <div className="update-banner-progress">
          <progress
            className="update-progress"
            value={pct}
            max={100}
            aria-label={`更新下载进度 ${pct}%`}
          />
        </div>
      </div>
    );
  }

  // phase === 'available'
  return (
    <div className="update-banner update-banner-available" role="status" aria-live="polite">
      <span className="update-banner-icon" aria-hidden="true">↑</span>
      <div className="update-banner-text">
        <strong>发现新版本 {version || ''}</strong>
        <span>当前版本已可升级</span>
      </div>
      <div className="update-banner-actions">
        <button className="btn btn-sm btn-primary" onClick={handleDownload} disabled={busy}>
          {busy ? '下载中…' : '下载更新'}
        </button>
      </div>
    </div>
  );
}
