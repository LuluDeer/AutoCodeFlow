import * as React from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Loader2,
  Pause,
  Play,
  RotateCw,
  Square,
  SquareTerminal,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Segmented } from '@/components/ui/segmented';
import { LogPanel } from '@/components/log-panel';
import { parseLogLine } from '@/lib/log-parse';
import {
  bridge,
  type ExecutionRecord,
  type ExecutionStatus,
  type ExecutorState,
  type ExecutorStatus,
} from '@/lib/ipc';
import { formatDuration, formatRelative, formatUptime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type Level = 'INFO' | 'WARN' | 'ERROR';

const STATUS_KEY = {
  online: 'status.online',
  pending: 'status.pending',
  offline: 'status.offline',
  stopped: 'status.stopped',
} as const satisfies Record<ExecutorStatus, Parameters<typeof t>[0]>;

export function StatusScreen({
  onOpenHistory,
  onOpenConfig,
}: {
  onOpenHistory?: (intent?: { status?: 'all' | ExecutionStatus; query?: string }) => void;
  onOpenConfig?: () => void;
} = {}) {
  const [state, setState] = React.useState<ExecutorState | null>(null);
  const [history, setHistory] = React.useState<ExecutionRecord[]>([]);
  const [lines, setLines] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [level, setLevel] = React.useState<'all' | Level>('all');
  const [paused, setPaused] = React.useState(false);
  const [busy, setBusy] = React.useState<'start' | 'stop' | 'restart' | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [lastAction, setLastAction] = React.useState<'start' | 'stop' | 'restart' | null>(null);
  const pausedRef = React.useRef(paused);
  pausedRef.current = paused;

  React.useEffect(() => {
    let mounted = true;
    (async () => {
      const [exec, logs, hist] = await Promise.all([
        bridge.getExecutorStatus(),
        bridge.getTodayLogs(),
        bridge.getHistory(),
      ]);
      if (!mounted) return;
      setState(exec);
      setLines(logs.filter((line) => line.trim() !== ''));
      setHistory(hist);
      setLoading(false);
    })();

    const offStatus = bridge.onExecutorStatusChange((status) => {
      // 先立刻反映状态，再补一次完整快照（pid / startedAt / 心跳要等子进程起来才有）。
      setState((prev) => (prev ? { ...prev, status } : prev));
      void bridge.getExecutorStatus().then((next) => {
        if (mounted) setState(next);
      });
    });
    const offLog = bridge.onLogLine((line) => {
      if (pausedRef.current || line.trim() === '') return;
      setLines((prev) => [...prev.slice(-499), line]);
    });
    // 运行时长/心跳会随时间变化，低频刷新一次即可（不做每秒 tick）。
    const timer = window.setInterval(() => {
      void bridge.getExecutorStatus().then((next) => {
        if (mounted) setState(next);
      });
    }, 30_000);

    return () => {
      mounted = false;
      offStatus();
      offLog();
      window.clearInterval(timer);
    };
  }, []);

  const windowRecords = React.useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return history.filter((record) => new Date(record.startedAt).getTime() >= cutoff);
  }, [history]);

  const stats = React.useMemo(() => {
    const finished = windowRecords.filter((record) => record.status !== 'running');
    const success = finished.filter((record) => record.status === 'success').length;
    const failed = finished.filter((record) => record.status === 'failed').length;
    const durations = finished
      .map((record) => record.durationMs)
      .filter((value) => value > 0)
      .sort((a, b) => a - b);
    const p95 = durations.length
      ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]
      : 0;
    return {
      total: windowRecords.length,
      success,
      failed,
      rate: finished.length ? (success / finished.length) * 100 : 0,
      p95,
    };
  }, [windowRecords]);

  const visibleLines =
    level === 'all'
      ? lines
      : lines.filter((line) => parseLogLine(line).level === level);

  async function restart() {
    setBusy('restart');
    setLastAction('restart');
    setActionError(null);
    try {
      await bridge.stopExecutor();
      await new Promise((resolve) => window.setTimeout(resolve, 400));
      await bridge.startExecutor();
      toast.success(t('status.toast.restarting'));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function toggleRun() {
    if (!state) return;
    const starting = state.status !== 'online' && state.status !== 'pending';
    setBusy(starting ? 'start' : 'stop');
    setLastAction(starting ? 'start' : 'stop');
    setActionError(null);
    try {
      const res = starting ? await bridge.startExecutor() : await bridge.stopExecutor();
      if (!res.ok) {
        setActionError(res.message ?? (starting ? t('status.toast.startFailed') : t('status.toast.stopFailed')));
        toast.error(starting ? t('status.toast.startFailed') : t('status.toast.stopFailed'), {
          description: res.message,
        });
        return;
      }
      toast(starting ? t('status.toast.starting') : t('status.toast.stopped'));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  if (loading || !state) {
    return (
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 p-4 md:p-5">
        <Skeleton className="h-7 w-24" />
        {actionError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-red-600/20 bg-red-600/8 px-4 py-2.5 text-xs"
        >
          <AlertTriangle className="size-4 shrink-0 text-red-700" />
          <span className="font-medium">{t('status.action.failed')}</span>
          <span
            className="min-w-0 flex-1 truncate text-muted-foreground"
            title={actionError}
          >
            {actionError}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (lastAction === 'restart') void restart();
              else void toggleRun();
            }}
          >
            {t('status.action.retry')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setActionError(null)}>
            {t('status.action.dismiss')}
          </Button>
        </div>
      ) : null}

      <div className="grid shrink-0 grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[76px]" />
          ))}
        </div>
        <Skeleton className="h-[380px]" />
      </div>
    );
  }

  const running = state.status === 'online' || state.status === 'pending';
  const recent = history.slice(0, 3);
  const failedRecords = windowRecords
    .filter((record) => record.status === 'failed')
    .slice(0, 4);
  const concurrencyPct = state.concurrency.max
    ? (state.concurrency.running / state.concurrency.max) * 100
    : 0;

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 p-4 md:p-5 xl:h-full">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-[-0.02em]">{t('status.title')}</h1>
            <Badge
              variant={
                state.status === 'online'
                  ? 'success'
                  : state.status === 'pending'
                    ? 'warning'
                    : 'muted'
              }
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  state.status === 'online' && 'animate-pulse bg-primary',
                  state.status === 'pending' && 'bg-amber-500',
                  state.status !== 'online' && state.status !== 'pending' && 'bg-muted-foreground',
                )}
              />
              {t(STATUS_KEY[state.status])}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {state.status === 'online'
              ? state.lastHeartbeatAt
                ? t('status.subtitleOnline', {
                    uptime: formatUptime(state.uptimeSec),
                    heartbeat: formatRelative(state.lastHeartbeatAt),
                  })
                : t('status.subtitleOnlineNoHeartbeat', { uptime: formatUptime(state.uptimeSec) })
              : state.status === 'pending'
                ? t('status.subtitlePending')
                : t('status.subtitleStopped')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={restart} disabled={busy !== null}>
            {busy === 'restart' ? <Loader2 className="animate-spin" /> : <RotateCw />}
            {t('status.action.restart')}
          </Button>
          <Button variant={running ? 'outline' : 'default'} onClick={toggleRun} disabled={busy !== null}>
            {busy === 'start' || busy === 'stop' ? (
              <Loader2 className="animate-spin" />
            ) : running ? (
              <Square />
            ) : (
              <Play />
            )}
            {running ? t('status.action.stop') : t('status.action.start')}
          </Button>
        </div>
      </div>

      {actionError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-red-600/20 bg-red-600/8 px-4 py-2.5 text-xs"
        >
          <AlertTriangle className="size-4 shrink-0 text-red-700" />
          <span className="font-medium">{t('status.action.failed')}</span>
          <span
            className="min-w-0 flex-1 truncate text-muted-foreground"
            title={actionError}
          >
            {actionError}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (lastAction === 'restart') void restart();
              else void toggleRun();
            }}
          >
            {t('status.action.retry')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setActionError(null)}>
            {t('status.action.dismiss')}
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: t('status.kpi.exec24h'), value: String(stats.total), hint: t('status.kpi.exec24hHint') },
          {
            label: t('status.kpi.rate'),
            value: `${stats.rate.toFixed(1)}%`,
            hint: t('status.kpi.failedCount', { count: stats.failed }),
            tone:
              stats.rate >= 90
                ? 'text-primary'
                : stats.rate >= 75
                  ? 'text-amber-700'
                  : 'text-red-700',
          },
          {
            label: t('status.kpi.p95'),
            value: stats.p95 ? formatDuration(stats.p95) : '—',
            hint: t('status.kpi.p95Hint'),
          },
          {
            label: t('status.kpi.queue'),
            value: String(state.concurrency.queue),
            hint: state.concurrency.queue === 0 ? t('status.kpi.idle') : t('status.kpi.waiting'),
            tone: state.concurrency.queue === 0 ? 'text-muted-foreground' : 'text-amber-700',
          },
        ].map((item) => (
          <Card key={item.label} className="justify-center px-4 py-3">
            <div className="text-xs text-muted-foreground">{item.label}</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-semibold tracking-[-0.02em] tabular-nums">
                {item.value}
              </span>
              <span className={cn('truncate text-[11px]', item.tone ?? 'text-muted-foreground')}>
                {item.hint}
              </span>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid min-h-0 grid-cols-1 gap-3 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="flex h-[min(60vh,560px)] min-h-[320px] flex-col gap-0 py-0 xl:h-auto xl:min-h-0">
          <CardHeader className="items-center px-4 py-3">
            <div className="flex items-center gap-2">
              <SquareTerminal className="size-3.5 text-muted-foreground" />
              <CardTitle className="text-xs font-semibold">{t('status.log.title')}</CardTitle>
              <Badge variant={paused ? 'muted' : 'success'} className="ml-1">
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    paused ? 'bg-muted-foreground' : 'animate-pulse bg-primary',
                  )}
                />
                {paused ? t('status.log.paused') : t('status.log.following')}
              </Badge>
            </div>
          </CardHeader>
          <LogPanel
            lines={visibleLines}
            loading={false}
            ariaLabel={t('status.log.title')}
            follow={!paused}
            showLineNumbers={false}
            allowExpand={false}
            toolbarStart={
              <Segmented
                label={t('status.log.title')}
                value={level}
                onValueChange={(value) => setLevel(value)}
                className="h-7"
                options={[
                  { value: 'all', label: t('status.log.all') },
                  { value: 'INFO', label: t('status.log.tabInfo') },
                  { value: 'WARN', label: t('status.log.tabWarn') },
                  { value: 'ERROR', label: t('status.log.tabError') },
                ]}
              />
            }
            toolbarEnd={
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={paused ? t('status.log.resume') : t('status.log.pause')}
                  title={paused ? t('status.log.resume') : t('status.log.pause')}
                  onClick={() => setPaused((value) => !value)}
                >
                  {paused ? <Play /> : <Pause />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('status.log.clear')}
                  title={t('status.log.clear')}
                  onClick={() => setLines([])}
                >
                  <Trash2 />
                </Button>
              </>
            }
            onCopy={async (copiedLines) => {
              await navigator.clipboard?.writeText(copiedLines.join('\n'));
              toast(t('status.log.copied'));
            }}
          />
        </Card>

        <div className="flex flex-col gap-3 xl:min-h-0 xl:overflow-y-auto xl:pr-1">
          <Card className="shrink-0 gap-0 py-0">
            <CardHeader className="px-4 py-3">
              <CardTitle className="text-xs font-semibold">{t('status.executor.title')}</CardTitle>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-2xs"
                onClick={onOpenConfig}
              >
                {t('status.executor.details')}
                <ArrowUpRight />
              </Button>
            </CardHeader>
            <Separator />
            <dl className="grid grid-cols-[76px_1fr] gap-y-2 px-4 py-3 text-xs">
              {[
                [t('status.executor.version'), state.version],
                [t('status.executor.pid'), state.pid ? `PID ${state.pid}` : '—'],
                [t('status.executor.listen'), `${state.host}:${state.port}`],
                [t('status.executor.concurrency'), `${state.concurrency.running} / ${state.concurrency.max}`],
                [t('status.executor.uptime'), formatUptime(state.uptimeSec)],
              ].map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="truncate font-mono text-[11.5px] text-secondary-foreground">{v}</dd>
                </React.Fragment>
              ))}
            </dl>
            <div className="px-4 pb-3.5">
              <div className="mb-1.5 flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">并发占用</span>
                <span className="tabular-nums">{Math.round(concurrencyPct)}%</span>
              </div>
              <Progress value={concurrencyPct} aria-label={t('status.executor.usage')} />
            </div>
          </Card>

          <Card className="shrink-0 gap-0 py-0">
            <CardHeader className="px-4 py-3">
              <CardTitle className="text-xs font-semibold">{t('status.recent.title')}</CardTitle>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-2xs"
                onClick={() => onOpenHistory?.({ status: 'all' })}
              >
                {t('status.recent.all')}
                <ArrowUpRight />
              </Button>
            </CardHeader>
            <Separator />
            {recent.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                {t('status.recent.empty')}
              </div>
            ) : (
              <ul className="flex flex-col">
                {recent.map((task, i) => (
                  <li
                    key={task.id}
                    className={cn(
                      'flex items-center gap-2.5 px-4 py-2.5 text-xs',
                      i !== recent.length - 1 && 'border-b border-border/70',
                    )}
                  >
                    {task.status === 'success' ? (
                      <CheckCircle2 className="size-3.5 shrink-0 text-primary" />
                    ) : task.status === 'failed' ? (
                      <XCircle className="size-3.5 shrink-0 text-red-600" />
                    ) : (
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-blue-600" />
                    )}
                    <span className="truncate">{task.taskName}</span>
                    <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                      {formatDuration(task.durationMs)}
                    </span>
                    <span className="w-14 shrink-0 text-right text-[11px] text-muted-foreground">
                      {formatRelative(task.startedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Separator />
            <div className="flex items-center gap-2 px-4 py-2.5">
              <CardDescription className="text-[11px]">
                {stats.failed > 0
                  ? t('status.recent.failed', { count: stats.failed })
                  : t('status.recent.noFailures')}
              </CardDescription>
            </div>
          </Card>

          <Card className="shrink-0 gap-0 py-0">
            <CardHeader className="px-4 py-3">
              <CardTitle className="text-xs font-semibold">{t('status.attention.title')}</CardTitle>
              {failedRecords.length > 0 ? (
                <Badge variant="danger">{failedRecords.length}</Badge>
              ) : null}
            </CardHeader>
            <Separator />
            {failedRecords.length === 0 ? (
              <div className="px-4 py-6 text-center text-[11px] text-muted-foreground">
                {t('status.attention.none')}
              </div>
            ) : (
              <ul className="flex flex-col">
                {failedRecords.map((record, index) => (
                  <li
                    key={record.id}
                    className={cn(index !== failedRecords.length - 1 && 'border-b border-border/70')}
                  >
                    <button
                      type="button"
                      data-attention-row={record.id}
                      onClick={() =>
                        onOpenHistory?.({ status: 'failed', query: record.taskName })
                      }
                      className="flex w-full items-center gap-2 px-4 py-2 text-left text-[11px] transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none focus-visible:ring-inset"
                    >
                      <XCircle className="size-3.5 shrink-0 text-red-700" />
                      <span className="truncate">{record.taskName}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground">
                        {formatRelative(record.startedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
