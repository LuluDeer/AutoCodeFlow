import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Boxes,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Loader2,
  RefreshCw,
  ScrollText,
  Search,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Segmented } from '@/components/ui/segmented';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { LogPanel } from '@/components/log-panel';
import { bridge, type AppRelease, type AppStatus, type InstalledApp } from '@/lib/ipc';
import { formatBytes, formatRelative } from '@/lib/format';
import { EmptyState } from '@/components/empty-state';
import { getLocale, t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const STATUS_META: Record<
  AppStatus,
  { labelKey: Parameters<typeof t>[0]; variant: 'outline' | 'info' | 'danger' }
> = {
  running: { labelKey: 'apps.status.running', variant: 'info' },
  idle: { labelKey: 'apps.status.idle', variant: 'outline' },
  error: { labelKey: 'apps.status.error', variant: 'danger' },
};

type SortKey = 'name' | 'recent' | 'installed';

const ROW_HEIGHT = 52;
const ROW_GRID =
  'grid grid-cols-[24px_minmax(0,1fr)_88px_150px] items-center gap-3 px-4 md:grid-cols-[24px_minmax(0,1fr)_96px_92px_112px_168px]';

export function AppsScreen() {
  const [apps, setApps] = React.useState<InstalledApp[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [query, setQuery] = React.useState('');
  const [status, setStatus] = React.useState<'all' | AppStatus>('all');
  const [sort, setSort] = React.useState<SortKey>('name');
  const [logApp, setLogApp] = React.useState<InstalledApp | null>(null);
  const [log, setLog] = React.useState<{ lines: string[]; loading: boolean }>({
    lines: [],
    loading: false,
  });
  const [uninstallTarget, setUninstallTarget] = React.useState<InstalledApp | null>(null);
  const [uninstalling, setUninstalling] = React.useState(false);
  const [logExpanded, setLogExpanded] = React.useState(false);
  const [activeReleaseKey, setActiveReleaseKey] = React.useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = React.useState(false);
  const selectAllRef = React.useRef<HTMLInputElement>(null);
  const uninstallRef = React.useRef<HTMLButtonElement | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const load = React.useCallback(async () => {
    const list = await bridge.listApps();
    setApps(list);
    setSelected((prev) => new Set([...prev].filter((id) => list.some((app) => app.id === id))));
    setLoading(false);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const activeRelease =
    logApp?.releases.find((release) => release.releaseKey === activeReleaseKey) ?? null;
  const activeLogPath = activeRelease?.logPath || logApp?.logPath || '';

  React.useEffect(() => {
    if (!logApp) return;
    let cancelled = false;
    if (!activeLogPath) {
      setLog({ lines: [], loading: false });
      return;
    }
    setLog({ lines: [], loading: true });
    (async () => {
      const chunk = await bridge.readAppLog(activeLogPath);
      if (!cancelled) setLog({ lines: chunk.lines, loading: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [logApp, activeLogPath]);

  const counts = React.useMemo(() => {
    const base: Record<'all' | AppStatus, number> = {
      all: apps.length,
      running: 0,
      idle: 0,
      error: 0,
    };
    for (const app of apps) base[app.status] += 1;
    return base;
  }, [apps]);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = apps.filter((app) => {
      if (status !== 'all' && app.status !== status) return false;
      if (!needle) return true;
      return (
        app.name.toLowerCase().includes(needle) ||
        app.id.toLowerCase().includes(needle) ||
        app.version.includes(needle)
      );
    });
    return [...list].sort((a, b) => {
      if (sort === 'name') {
        return a.name.localeCompare(b.name, getLocale() === 'zh' ? 'zh-Hans-CN' : 'en');
      }
      if (sort === 'installed') {
        return new Date(b.installedAt).getTime() - new Date(a.installedAt).getTime();
      }
      return (
        (b.lastRunAt ? new Date(b.lastRunAt).getTime() : 0) -
        (a.lastRunAt ? new Date(a.lastRunAt).getTime() : 0)
      );
    });
  }, [apps, query, status, sort]);

  const visibleIds = React.useMemo(() => filtered.map((app) => app.id), [filtered]);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someSelected = visibleIds.some((id) => selected.has(id));

  // 搜索/筛选变化时清空选择，避免批量操作命中看不见的行。
  React.useEffect(() => {
    setSelected(new Set());
  }, [query, status]);

  React.useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected && !allSelected;
    }
  }, [someSelected, allSelected]);

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function deleteRelease(release: AppRelease) {
    if (!logApp) return;
    const res = await bridge.deleteAppRelease(logApp.id, release.releaseKey, release.deploymentId);
    if (res.canceled) return;
    if (!res.ok) {
      toast.error(t('apps.releaseDeleteFailed'), {
        description: res.error ?? res.message,
      });
      return;
    }
    toast.success(t('apps.releaseDeleted'));
    setLogApp((prev) =>
      prev
        ? { ...prev, releases: prev.releases.filter((item) => item.releaseKey !== release.releaseKey) }
        : prev,
    );
    await load();
  }

  async function batchUninstall() {
    if (selected.size === 0) return;
    setBatchBusy(true);
    try {
      const res = await bridge.uninstallApps([...selected]);
      if (res.canceled) return;
      if (res.ok) {
        toast.success(t('apps.batchDone', { count: selected.size }));
        setSelected(new Set());
        await load();
        return;
      }
      const failed = (res.results ?? []).filter((item) => !item.ok);
      toast.error(t('apps.batchFailed'), {
        description: failed[0]?.error ?? res.error,
      });
    } finally {
      setBatchBusy(false);
    }
  }

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const totalSize = apps.reduce((sum, app) => sum + app.sizeBytes, 0);

  async function confirmUninstall() {
    if (!uninstallTarget) return;
    setUninstalling(true);
    try {
      const res = await bridge.uninstallApp(uninstallTarget.id);
      if (!res.ok) {
        toast.error(t('apps.toast.uninstallFailed'), { description: res.message });
        return;
      }
      setUninstallTarget(null);
      await load();
      toast.success(t('apps.toast.uninstalled'));
    } finally {
      setUninstalling(false);
    }
  }

  return (
    <div className="mx-auto flex h-full min-h-[520px] w-full max-w-[1180px] flex-col gap-4 p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.02em]">{t('apps.title')}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('apps.subtitle')}</p>
        </div>
        <Button variant="outline" onClick={() => void load()}>
          <RefreshCw />
          {t('apps.action.refresh')}
        </Button>
      </div>

      <Card className="flex min-h-0 flex-1 flex-col gap-0 py-0">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('apps.search')}
              className="h-8 w-64 pl-8"
            />
          </div>

          <Segmented
            label={t('apps.col.status')}
            value={status}
            onValueChange={setStatus}
            options={[
              { value: 'all', label: `${t('apps.filter.all')} ${counts.all}` },
              { value: 'running', label: `${t('apps.status.running')} ${counts.running}` },
              { value: 'idle', label: `${t('apps.status.idle')} ${counts.idle}` },
              { value: 'error', label: `${t('apps.status.error')} ${counts.error}` },
            ]}
          />

          <Select value={sort} onValueChange={(value) => setSort(value as SortKey)}>
            <SelectTrigger className="h-8 w-36" aria-label={t('apps.sort')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">{t('apps.sort.name')}</SelectItem>
              <SelectItem value="recent">{t('apps.sort.recent')}</SelectItem>
              <SelectItem value="installed">{t('apps.sort.installed')}</SelectItem>
            </SelectContent>
          </Select>

          <span className="ml-auto text-[11px] text-muted-foreground">
            {totalSize > 0
              ? t('apps.summary', {
                  count: apps.length,
                  running: counts.running,
                  size: formatBytes(totalSize),
                })
              : t('apps.summaryNoSize', { count: apps.length, running: counts.running })}
          </span>
        </div>

        <Separator />

        {selected.size > 0 ? (
          <div className="flex flex-wrap items-center gap-3 border-b border-border bg-secondary/50 px-4 py-2 text-xs">
            <span className="font-medium">{t('apps.selectedCount', { count: selected.size })}</span>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void batchUninstall()}
              disabled={batchBusy}
            >
              {batchBusy ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {t('apps.batchUninstall')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              {t('apps.clearSelection')}
            </Button>
          </div>
        ) : null}

        <div
          role="table"
          aria-label={t('apps.title')}
          aria-rowcount={filtered.length + 1}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div role="rowgroup">
            <div
              role="row"
              className={cn(
                ROW_GRID,
                'h-8 shrink-0 border-b border-border bg-secondary/40 text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase',
              )}
            >
              <span role="columnheader">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label={t('apps.selectAll')}
                  className="size-3.5 cursor-pointer accent-primary"
                />
              </span>
              <span role="columnheader">{t('apps.col.app')}</span>
              <span role="columnheader">{t('apps.col.version')}</span>
              <span role="columnheader" className="hidden md:inline">
                {t('apps.col.status')}
              </span>
              <span role="columnheader" className="hidden text-right md:inline">
                {t('apps.col.lastRun')}
              </span>
              <span role="columnheader" className="text-right">
                {t('apps.col.actions')}
              </span>
            </div>
          </div>

          {loading ? (
            <div role="rowgroup">
              <div role="row">
                <div role="cell" aria-colspan={6} className="flex flex-col gap-2 p-4">
                  {Array.from({ length: 8 }).map((_, index) => (
                    <Skeleton key={index} className="h-10 w-full" />
                  ))}
                </div>
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div role="rowgroup">
              <div role="row">
                <div role="cell" aria-colspan={6} className="p-4">
                  <EmptyState
                    icon={Boxes}
                    title={apps.length === 0 ? t('apps.empty.none') : t('apps.empty.noMatch')}
                    description={
                      apps.length === 0 ? t('apps.empty.noneDesc') : t('apps.empty.noMatchDesc')
                    }
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setQuery('');
                          setStatus('all');
                        }}
                        disabled={apps.length === 0}
                      >
                        {t('apps.empty.clear')}
                      </Button>
                    }
                  />
                </div>
              </div>
            </div>
          ) : (
            <div role="rowgroup" ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const app = filtered[item.index];
                  const meta = STATUS_META[app.status];
                  return (
                    <div
                      key={app.id}
                      role="row"
                      aria-rowindex={item.index + 2}
                      data-app-row={app.id}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: item.size,
                        transform: `translateY(${item.start}px)`,
                      }}
                      className={cn(
                        ROW_GRID,
                        'border-b border-border/70 text-xs transition-colors hover:bg-accent/50',
                      )}
                    >
                      <div role="cell" className="flex items-center justify-center">
                        <input
                          type="checkbox"
                          checked={selected.has(app.id)}
                          onChange={() => toggleOne(app.id)}
                          aria-label={t('apps.selectApp', { name: app.name })}
                          className="size-3.5 cursor-pointer accent-primary"
                        />
                      </div>
                      <div role="cell" className="min-w-0">
                        <button
                          type="button"
                          onClick={() => {
                          setActiveReleaseKey(null);
                          setVersionsOpen(app.releases.length <= 3);
                          setLogApp(app);
                        }}
                          className="flex min-w-0 items-center gap-2.5 rounded-sm text-left focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
                          aria-label={`${app.name} ${t('apps.action.logs')}`}
                        >
                          <span
                            className={cn(
                              'grid size-7 shrink-0 place-items-center rounded-md border',
                              app.status === 'error'
                                ? 'border-red-600/15 bg-red-600/8'
                                : 'border-border bg-secondary',
                            )}
                          >
                            {app.status === 'error' ? (
                              <AlertTriangle className="size-3.5 text-red-700" />
                            ) : (
                              <Boxes className="size-3.5 text-muted-foreground" />
                            )}
                          </span>
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-[13px] text-foreground">{app.name}</span>
                            <span className="truncate font-mono text-[10px] text-muted-foreground">
                              {app.id}
                            </span>
                          </span>
                        </button>
                      </div>

                      <div role="cell" className="flex items-center gap-1">
                        <Badge variant="muted" className="font-mono">
                          v{app.version}
                        </Badge>
                        {app.releaseCount > 1 ? (
                          <Badge variant="outline" className="px-1">
                            +{app.releaseCount - 1}
                          </Badge>
                        ) : null}
                      </div>

                      <div role="cell" className="hidden md:flex">
                        {app.deploymentState === 'incomplete' ? (
                          <Badge variant="warning" title={t('apps.incompleteHint')}>
                            {t('apps.incomplete')}
                          </Badge>
                        ) : !app.isCurrent ? (
                          <Badge variant="warning" title={t('apps.notCurrentHint')}>
                            {t('apps.notCurrent')}
                          </Badge>
                        ) : (
                          <Badge variant={meta.variant} className="gap-1">
                            {app.status === 'running' ? (
                              <span className="size-1.5 animate-pulse rounded-full bg-blue-600" />
                            ) : null}
                            {t(meta.labelKey)}
                          </Badge>
                        )}
                      </div>

                      <div
                        role="cell"
                        className="hidden text-right text-[11px] text-muted-foreground md:block"
                      >
                        {formatRelative(app.lastRunAt)}
                      </div>

                      <div role="cell" className="flex items-center justify-end gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('apps.action.logs')}
                          title={t('apps.action.logs')}
                          onClick={() => {
                          setActiveReleaseKey(null);
                          setVersionsOpen(app.releases.length <= 3);
                          setLogApp(app);
                        }}
                        >
                          <ScrollText className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('apps.action.folder')}
                          title={t('apps.action.folder')}
                          onClick={() => void bridge.openAppFolder(app.id)}
                        >
                          <FolderOpen className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('apps.action.uninstall')}
                          title={t('apps.action.uninstall')}
                          className="text-muted-foreground hover:bg-red-600/8 hover:text-red-700"
                          onClick={(event) => {
                            uninstallRef.current = event.currentTarget;
                            setUninstallTarget(app);
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </Card>

      <Sheet open={!!logApp} onOpenChange={(open) => !open && setLogApp(null)}>
        <SheetContent
          className={cn(
            'p-0',
            logExpanded ? 'max-w-none' : 'max-w-[min(1120px,calc(100vw-64px))]',
          )}
        >
          {logApp ? (
            <>
              <div className="border-b border-border px-5 py-4 pr-12">
                <SheetHeader>
                  <div className="flex items-center gap-2">
                    <SheetTitle>{logApp.name}</SheetTitle>
                    <Badge variant="muted" className="font-mono">
                      v{logApp.version}
                    </Badge>
                  </div>
                  <SheetDescription className="truncate font-mono text-[11px]">
                    {activeLogPath || logApp.path}
                  </SheetDescription>
                  {activeRelease ? (
                    <div className="mt-1 flex items-center gap-2">
                      <Badge variant="info">
                        {t('apps.viewingRelease', {
                          version: activeRelease.version ?? activeRelease.releaseKey,
                        })}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[11px]"
                        onClick={() => setActiveReleaseKey(null)}
                      >
                        {t('apps.backToCurrent')}
                      </Button>
                    </div>
                  ) : null}
                  {!logApp.hasLog ? (
                    <p className="text-[11px] leading-relaxed text-amber-700">
                      {logApp.runMode === 'scheduled' ? t('apps.noLogScheduled') : t('apps.noLogHint')}
                    </p>
                  ) : null}
                </SheetHeader>
              </div>

              <div className="border-b border-border">
                <button
                  type="button"
                  aria-expanded={versionsOpen}
                  onClick={() => setVersionsOpen((open) => !open)}
                  className="flex w-full items-center gap-2 px-5 py-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent/40"
                >
                  {versionsOpen ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                  <span>
                    {t('apps.versions')} · {logApp.releases.length}
                  </span>
                  {logApp.releases.find((release) => release.isCurrent) ? (
                    <Badge variant="outline" className="ml-auto">
                      v{logApp.releases.find((release) => release.isCurrent)?.version ?? '—'}
                    </Badge>
                  ) : null}
                </button>
                <ul className={cn('max-h-56 overflow-auto', !versionsOpen && 'hidden')}>
                  {logApp.releases.map((release) => (
                    <li
                      key={release.releaseKey}
                      data-release-row={release.releaseKey}
                      className={cn(
                        'flex items-center gap-2 border-t border-border/60 px-5 py-1.5 text-[11px]',
                        activeReleaseKey === release.releaseKey && 'bg-secondary/50',
                      )}
                    >
                      <Badge variant={release.isCurrent ? 'success' : 'muted'} className="font-mono">
                        {release.version ?? '—'}
                      </Badge>
                      <span className="min-w-0 truncate font-mono text-muted-foreground">
                        {release.releaseKey}
                      </span>
                      <span className="ml-auto shrink-0 text-muted-foreground">
                        {release.deployedAt ? formatRelative(release.deployedAt) : '—'}
                      </span>
                      {release.hasLog ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('apps.viewReleaseLog')}
                          title={t('apps.viewReleaseLog')}
                          onClick={() => setActiveReleaseKey(release.releaseKey)}
                        >
                          <ScrollText className="size-3.5" />
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('apps.openReleaseFolder')}
                        title={t('apps.openReleaseFolder')}
                        onClick={() => void bridge.openReleaseFolder(logApp.id, release.releaseKey)}
                      >
                        <FolderOpen className="size-3.5" />
                      </Button>
                      {release.isCurrent ? (
                        <Badge variant="outline">{t('apps.current')}</Badge>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('apps.deleteRelease')}
                          title={t('apps.deleteRelease')}
                          className="text-muted-foreground hover:bg-red-600/8 hover:text-red-700"
                          onClick={() => void deleteRelease(release)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              <LogPanel
                lines={log.lines}
                loading={log.loading}
                ariaLabel={`${logApp.name} ${t('apps.action.logs')}`}
                expanded={logExpanded}
                onToggleExpand={() => setLogExpanded((value) => !value)}
                onCopy={async (copiedLines) => {
                  await navigator.clipboard?.writeText(copiedLines.join('\n'));
                  toast(t('apps.log.copied'));
                }}
              />

              <SheetFooter>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void bridge.openAppFolder(logApp.id)}
                >
                  <FolderOpen className="size-3.5" />
                  {t('apps.log.openFolder')}
                </Button>
                <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setLogApp(null)}>
                  {t('apps.log.close')}
                </Button>
              </SheetFooter>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog open={!!uninstallTarget} onOpenChange={(open) => !open && setUninstallTarget(null)}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            uninstallRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('apps.uninstall.title', { name: uninstallTarget?.name ?? '' })}</DialogTitle>
            <DialogDescription>
              {t('apps.uninstall.desc')}
              {uninstallTarget && uninstallTarget.runningCount > 0 ? (
                <span className="mt-2 block text-amber-700">
                  {t('apps.uninstall.running', { count: uninstallTarget.runningCount })}
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">{t('apps.uninstall.cancel')}</Button>
            </DialogClose>
            <Button variant="destructive" onClick={() => void confirmUninstall()} disabled={uninstalling}>
              {uninstalling ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {t('apps.uninstall.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
