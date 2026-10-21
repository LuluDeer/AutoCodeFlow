import * as React from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Download, Loader2, RefreshCw, RotateCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  bridge,
  type UpdateAvailable,
  type UpdateProgress,
} from '@/lib/ipc';
import { formatBytes } from '@/lib/format';
import { t } from '@/lib/i18n';

type Phase = 'idle' | 'checking' | 'latest' | 'unavailable' | 'available' | 'downloading' | 'downloaded' | 'error';

/**
 * 自动更新状态机。
 *
 * `updater:check` 只返回 {ok}，真正的结果通过四个事件回推；这里把
 * 「检查 → 可下载 → 下载中 → 已下载 → 安装」串成一个面板。
 */
export function UpdatePanel() {
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [available, setAvailable] = React.useState<UpdateAvailable | null>(null);
  const [progress, setProgress] = React.useState<UpdateProgress | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const timerRef = React.useRef<number | null>(null);

  const clearTimer = React.useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    const offAvailable = bridge.onUpdateAvailable((payload) => {
      clearTimer();
      setAvailable(payload);
      setError(null);
      setPhase(payload.previouslyDownloaded ? 'downloaded' : 'available');
    });
    const offProgress = bridge.onUpdateProgress((payload) => {
      setProgress(payload);
      setPhase('downloading');
    });
    const offDownloaded = bridge.onUpdateDownloaded((payload) => {
      setAvailable((prev) => (prev ? { ...prev, version: payload.version } : prev));
      setPhase('downloaded');
    });
    const offError = bridge.onUpdateError((payload) => {
      clearTimer();
      setError(payload.message);
      setPhase('error');
    });
    return () => {
      clearTimer();
      offAvailable();
      offProgress();
      offDownloaded();
      offError();
    };
  }, [clearTimer]);

  async function check() {
    setPhase('checking');
    setError(null);
    setProgress(null);
    clearTimer();
    // 开发模式 / 未打包时主进程不会发任何事件：超时后退回「未启用」。
    timerRef.current = window.setTimeout(() => {
      setPhase((current) => (current === 'checking' ? 'unavailable' : current));
    }, 6000);
    try {
      const res = await bridge.checkForUpdate();
      if (!res.ok) {
        clearTimer();
        setError(res.message ?? t('config.updateFailed'));
        setPhase('error');
      }
    } catch (err) {
      clearTimer();
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  async function download() {
    setPhase('downloading');
    setError(null);
    try {
      await bridge.downloadUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  async function install() {
    try {
      const res = await bridge.installUpdate();
      if (!res.ok) toast.error(t('config.updateInstallFailed'), { description: res.message });
      else setPhase('idle');
    } catch (err) {
      toast.error(t('config.updateInstallFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const busy = phase === 'checking' || phase === 'downloading';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{t('config.about.version')}</span>
            {phase === 'downloaded' ? (
              <Badge variant="success">
                <CheckCircle2 className="size-3" />
                {t('config.updateDownloaded', { version: available?.version ?? '' })}
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t('config.about.versionDesc')}</p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {phase === 'available' ? (
            <Button size="sm" onClick={() => void download()}>
              <Download />
              {t('config.updateDownload')}
            </Button>
          ) : null}
          {phase === 'downloaded' ? (
            <Button size="sm" onClick={() => void install()}>
              <RotateCw />
              {t('config.updateInstall')}
            </Button>
          ) : null}
          {phase === 'downloading' ? (
            <Button size="sm" disabled>
              <Loader2 className="animate-spin" />
              {t('config.updateDownloading', { percent: Math.round(progress?.percent ?? 0) })}
            </Button>
          ) : null}
          {phase === 'idle' ||
          phase === 'latest' ||
          phase === 'unavailable' ||
          phase === 'error' ||
          phase === 'checking' ? (
            <Button size="sm" variant="outline" onClick={() => void check()} disabled={busy}>
              {phase === 'checking' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {phase === 'checking' ? t('config.updateChecking') : t('config.updateCheck')}
            </Button>
          ) : null}
        </div>
      </div>

      {phase === 'latest' ? (
        <p className="text-[11px] text-muted-foreground">{t('config.updateLatest')}</p>
      ) : null}
      {phase === 'unavailable' ? (
        <p className="text-[11px] text-muted-foreground">{t('config.updateUnavailable')}</p>
      ) : null}

      {phase === 'available' || phase === 'downloading' || phase === 'downloaded' ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/40 p-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium">
              {t('config.updateAvailable', { version: available?.version ?? '—' })}
            </span>
            <span className="text-[10px] text-muted-foreground">→ {available?.current ?? '—'}</span>
          </div>
          {available?.releaseNotes ? (
            <div>
              <div className="mb-1 text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                {t('config.updateNotes')}
              </div>
              <p className="max-h-24 overflow-y-auto text-[11px] leading-relaxed whitespace-pre-wrap text-secondary-foreground">
                {available.releaseNotes}
              </p>
            </div>
          ) : null}
          {phase === 'downloading' ? (
            <div>
              <Progress value={progress?.percent ?? 0} aria-label={t('config.updateNotes')} />
              <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                <span>
                  {Math.round(progress?.percent ?? 0)}% · {formatBytes(progress?.transferred ?? 0)} /{' '}
                  {formatBytes(progress?.total ?? 0)}
                </span>
                <span>{t('config.updateSpeed', { size: formatBytes(progress?.bytesPerSecond ?? 0) })}</span>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-md border border-red-600/20 bg-red-600/8 px-3 py-2 text-[11px] text-red-700"
        >
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button
            type="button"
            className="rounded border border-red-600/30 px-2 py-0.5 font-medium"
            onClick={() => void check()}
          >
            {t('config.updateRetry')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
