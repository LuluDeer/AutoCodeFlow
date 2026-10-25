import React, { useCallback, useEffect, useState } from 'react';
import Icon from './Icon';
// i18n 二期收尾：更新横幅全部文案入双语表（zh 值与原硬编码逐字一致）。
import { createCfgTexts, resolveRendererLocale } from '../i18n';

const t = createCfgTexts(resolveRendererLocale(() => navigator.language));

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
  installUpdate?: () => Promise<{ ok: boolean; error?: string; canceled?: boolean }>;
  // F-37（UIUX 审计）：取消在途下载（electron-updater 原生 CancellationToken）。
  cancelUpdateDownload?: () => Promise<{ ok: boolean; canceled: boolean }>;
  // payload 类型与 preload 契约（src/preload/index.ts onUpdateAvailable）一致：
  // previouslyDownloaded 已入契约（B-3②），releaseNotes 同理（4.2）。
  // 方法保持可选是「electronAPI 缺失时防御性降级」的既有口径。
  onUpdateAvailable?: (cb: (p: { version: string; current: string; previouslyDownloaded: boolean; releaseNotes: string }) => void) => () => void;
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
  // B-3②：主进程持久化标记命中（同一版本此前已下载完成、待装缓存仍有效）。
  const [previouslyDownloaded, setPreviouslyDownloaded] = useState(false);
  // 4.2：更新日志（主进程已归一化为纯文本并封顶）。空串 = 该版本没有日志，
  // 不渲染任何入口（不给用户点开一个空框）。
  const [releaseNotes, setReleaseNotes] = useState('');
  // 折叠态是**默认**：更新日志常有几十行，展开会把横幅撑成半屏，把「下载更新」
  // 按钮挤到视线外。用户想读再点开。
  const [notesOpen, setNotesOpen] = useState(false);

  // 订阅主进程更新事件。所有订阅走 onXxx 返回的取消函数，卸载时清理，
  // 避免开发模式热重载或窗口重建时监听器泄漏（重复注册会让一次事件多次 setState）。
  useEffect(() => {
    const a = api();
    const offs: Array<() => void> = [];

    if (typeof a.onUpdateAvailable === 'function') {
      offs.push(a.onUpdateAvailable((p) => {
        setVersion(p?.version || '');
        setPreviouslyDownloaded(p?.previouslyDownloaded === true);
        // 只收字符串：主进程恒发 string（normalizeReleaseNotes 保证），但旧版
        // 主进程可能发 undefined——两种情况都归一成空串，渲染层不必分支。
        setReleaseNotes(typeof p?.releaseNotes === 'string' ? p.releaseNotes : '');
        // 新版本到达即复位折叠态（上一版展开过不代表这一版也要展开）
        setNotesOpen(false);
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
        setError(p?.message || t('update.failed'));
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
      const res = await api().installUpdate?.();
      // F-37（UIUX 审计）：无可安装更新时主进程如实回传 ok:false（此前
      // quitAndInstall no-op 仍回 ok:true，渲染层无感、语义不实）。哨兵
      // UPDATER_NO_DOWNLOADED_UPDATE 映射双语提示；未知 error 原样展示。
      // R105 原生确认被取消（canceled:true）不是失败：静默返回（F-26 口径）。
      if (res && res.ok === false) {
        if (res.canceled) return;
        setError(
          res.error === 'UPDATER_NO_DOWNLOADED_UPDATE'
            ? t('update.noDownloadedUpdate')
            : (res.error || t('update.failed')),
        );
        setPhase('error');
      }
      // ok:true 时应用即将退出安装，无需任何状态处理
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }, []);

  // F-37：取消在途下载——主进程以 CancellationToken 原生中断（electron-updater
  // 6.x 调研结论：原生取消可行，无需「关闭弹窗 + 不自动安装」的降级方案），
  // 随后重发 update-available 让横幅回到 available 态；这里本地同步置回作双
  // 保险（事件到达时重复 setState 无害）。canceled:false = 无在途下载可取消
  // （竞态：下载刚完成，'downloaded' 事件已在路上），维持现状等事件。
  const handleCancelDownload = useCallback(async () => {
    try {
      const res = await api().cancelUpdateDownload?.();
      if (res?.ok && res.canceled) {
        setPhase('available');
        setError('');
      }
    } catch {
      // 取消请求失败：保持 downloading 态（下载可能仍在继续），不打断进度
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
        <span className="update-banner-icon" aria-hidden="true"><Icon name="warning" /></span>
        <div className="update-banner-text">
          <strong>{t('update.failed')}</strong>
          <span>{error}</span>
        </div>
        <div className="update-banner-actions">
          <button className="btn btn-sm" onClick={handleRetry} disabled={busy}>
            {busy ? t('update.checking') : t('ui.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'downloaded') {
    return (
      <div className="update-banner update-banner-ready" role="status" aria-live="polite">
        <span className="update-banner-icon" aria-hidden="true"><Icon name="spark" /></span>
        <div className="update-banner-text">
          <strong>{t('update.downloadedTitle', version || '')}</strong>
          {/* B-3：文案改实。autoInstallOnAppQuit=false 下，直接关闭应用/托盘退出
              **不会**自动安装，只有点「重启并安装」才真正升级——旧文案「重启应用
              即可完成安装」误导用户关窗，结果新版本永远装不上、下次又得重来。 */}
          <span>{t('update.downloadedHint')}</span>
        </div>
        <div className="update-banner-actions">
          <button className="btn btn-sm btn-success" onClick={handleInstall} disabled={busy}>
            {busy ? t('update.installing') : <><Icon name="refresh" /> {t('update.install')}</>}
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'downloading') {
    const pct = Math.max(0, Math.min(100, Math.round(percent)));
    return (
      <div className="update-banner update-banner-downloading" role="status" aria-live="polite">
        <span className="update-banner-icon" aria-hidden="true"><Icon name="arrow-down" /></span>
        <div className="update-banner-text">
          <strong>{t('update.downloadingTitle', version || '', pct)}</strong>
          {total > 0 && (
            <span>{formatBytes(transferred)} / {formatBytes(total)}</span>
          )}
        </div>
        <div className="update-banner-progress">
          <progress
            className="update-progress"
            value={pct}
            max={100}
            aria-label={t('update.progressAria', pct)}
          />
        </div>
        {/* F-37（UIUX 审计）：下载期给用户「取消」路径——大包弱网期间此前
            横幅常驻占版面且无从退出。取消后主进程重发 update-available，
            横幅回到 available 态（可再次下载或直接无视）。 */}
        <div className="update-banner-actions">
          <button className="btn btn-sm" onClick={() => void handleCancelDownload()}>
            {t('update.cancelDownload')}
          </button>
        </div>
      </div>
    );
  }

  // phase === 'available'
  return (
    <div className="update-banner update-banner-available" role="status" aria-live="polite">
      <span className="update-banner-icon" aria-hidden="true"><Icon name="arrow-up" /></span>
      <div className="update-banner-text">
        <strong>{t('update.availableTitle', version || '')}</strong>
        {/* B-3②：主进程标记命中 = 该版本此前已下载完成、待装缓存仍在。
            点「下载更新」时 electron-updater 会先校验并复用本地缓存（sha512
            一致则不重新下载），完成后自动进入「重启并安装」。 */}
        <span>
          {previouslyDownloaded
            ? t('update.availableCachedHint')
            : t('update.availableHint')}
        </span>
        {/* 4.2：更新日志——**默认折叠**，点开才展开。
            纯文本渲染（{releaseNotes}），不走 dangerouslySetInnerHTML：
            内容来自 GitHub Releases / 私有化 feed，是不可信外部输入，
            注入 HTML 就是 XSS 面。主进程已把标签剥掉（normalizeReleaseNotes），
            这里再保证一次"只当文本显示"——两道防线互不依赖。
            无日志时不渲染入口（空框比没有更糟）。 */}
        {releaseNotes !== '' && (
          <details
            className="update-notes"
            open={notesOpen}
            onToggle={(e) => setNotesOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>{notesOpen ? t('update.notesHide') : t('update.notesShow')}</summary>
            <pre className="update-notes-body">{releaseNotes}</pre>
          </details>
        )}
      </div>
      <div className="update-banner-actions">
        <button className="btn btn-sm btn-primary" onClick={handleDownload} disabled={busy}>
          {busy ? t('update.downloading') : t('update.download')}
        </button>
      </div>
    </div>
  );
}
