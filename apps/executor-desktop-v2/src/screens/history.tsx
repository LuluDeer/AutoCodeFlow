import * as React from 'react';
import { toast } from 'sonner';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
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
import { Segmented } from '@/components/ui/segmented';
import { LogPanel } from '@/components/log-panel';
import { bridge, type ExecutionRecord, type ExecutionStatus } from '@/lib/ipc';
import { formatAbsolute, formatDuration, formatRelative } from '@/lib/format';
import { t } from '@/lib/i18n';
import { EmptyState } from '@/components/empty-state';
import { cn } from '@/lib/utils';

const STATUS_META: Record<
  ExecutionStatus,
  {
    labelKey: Parameters<typeof t>[0];
    variant: 'success' | 'danger' | 'info';
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  success: { labelKey: 'history.tab.success', variant: 'success', icon: CheckCircle2 },
  failed: { labelKey: 'history.tab.failed', variant: 'danger', icon: XCircle },
  running: { labelKey: 'history.tab.running', variant: 'info', icon: Loader2 },
};

const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_92px_84px_96px_20px] items-center gap-3 px-4';

export function HistoryScreen({
  initialStatus = 'all',
  initialQuery = '',
}: {
  initialStatus?: 'all' | ExecutionStatus;
  initialQuery?: string;
} = {}) {
  const [records, setRecords] = React.useState<ExecutionRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [query, setQuery] = React.useState(initialQuery);
  const [status, setStatus] = React.useState<'all' | ExecutionStatus>(initialStatus);
  const [range, setRange] = React.useState<'all' | 'today' | '7d'>('all');
  const [selected, setSelected] = React.useState<ExecutionRecord | null>(null);
  const [clearOpen, setClearOpen] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);
  const rowRef = React.useRef<HTMLButtonElement | null>(null);
  const clearRef = React.useRef<HTMLButtonElement | null>(null);
  const [logExpanded, setLogExpanded] = React.useState(false);
  const [log, setLog] = React.useState<{ lines: string[]; loading: boolean }>({
    lines: [],
    loading: false,
  });

  const load = React.useCallback(async () => {
    const list = await bridge.getHistory();
    setRecords(list);
    setLoading(false);
  }, []);

  React.useEffect(() => {
    void load();
    return bridge.onHistoryChanged(() => void load());
  }, [load]);

  React.useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLog({ lines: [], loading: true });
    (async () => {
      const chunk = await bridge.readExecLog(selected.id);
      if (!cancelled) setLog({ lines: chunk.lines, loading: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const counts = React.useMemo(() => {
    const base: Record<'all' | ExecutionStatus, number> = {
      all: records.length,
      success: 0,
      failed: 0,
      running: 0,
    };
    for (const record of records) base[record.status] += 1;
    return base;
  }, [records]);

  const filtered = React.useMemo(() => {
    const now = Date.now();
    return records.filter((record) => {
      if (status !== 'all' && record.status !== status) return false;
      if (range !== 'all') {
        const age = now - new Date(record.startedAt).getTime();
        if (range === 'today' && age > 24 * 60 * 60 * 1000) return false;
        if (range === '7d' && age > 7 * 24 * 60 * 60 * 1000) return false;
      }
      if (query.trim()) {
        const needle = query.trim().toLowerCase();
        return (
          record.taskName.toLowerCase().includes(needle) ||
          record.id.toLowerCase().includes(needle)
        );
      }
      return true;
    });
  }, [records, status, range, query]);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 48,
    overscan: 14,
  });

  async function clearHistory() {
    setClearing(true);
    try {
      const res = await bridge.clearHistory();
      if (!res.ok) {
        toast.error(t('history.toast.clearFailed'), { description: res.message });
        return;
      }
      setRecords([]);
      setClearOpen(false);
      toast.success(t('history.toast.cleared'));
    } finally {
      setClearing(false);
    }
  }

  async function copyId(id: string) {
    await navigator.clipboard?.writeText(id);
    toast(t('history.toast.copiedId'));
  }

  return (
    <div className="mx-auto flex h-full min-h-[520px] w-full max-w-[1180px] flex-col gap-4 p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.02em]">{t('history.title')}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('history.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCw />
            {t('history.action.refresh')}
          </Button>
          <Button
            variant="outline"
            onClick={(event) => {
              clearRef.current = event.currentTarget;
              setClearOpen(true);
            }}
            disabled={records.length === 0}
          >
            <Trash2 />
            {t('history.action.clear')}
          </Button>
        </div>
      </div>

      <Card className="flex min-h-0 flex-1 flex-col gap-0 py-0">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('history.search')}
              className="h-8 w-64 pl-8"
            />
          </div>

          <Segmented
            label={t('history.col.status')}
            value={status}
            onValueChange={(value) => setStatus(value)}
            className="order-3 w-full md:order-none md:w-auto"
            options={[
              { value: 'all', label: `${t('history.tab.all')} ${counts.all}` },
              { value: 'success', label: `${t('history.tab.success')} ${counts.success}` },
              { value: 'failed', label: `${t('history.tab.failed')} ${counts.failed}` },
              { value: 'running', label: `${t('history.tab.running')} ${counts.running}` },
            ]}
          />

          <Select value={range} onValueChange={(v) => setRange(v as typeof range)}>
            <SelectTrigger className="h-8 w-32" aria-label={t('history.rangeLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('history.range.all')}</SelectItem>
              <SelectItem value="today">{t('history.range.24h')}</SelectItem>
              <SelectItem value="7d">{t('history.range.7d')}</SelectItem>
            </SelectContent>
          </Select>

          <span className="ml-auto text-[11px] text-muted-foreground">
            {t('history.count', { count: filtered.length })}
          </span>
        </div>

        <Separator />

        <div
          className={cn(
            ROW_GRID,
            'h-8 border-b border-border bg-secondary/40 text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase',
          )}
        >
          <span>{t('history.col.task')}</span>
          <span>{t('history.col.status')}</span>
          <span className="text-right">{t('history.col.duration')}</span>
          <span className="text-right">{t('history.col.startedAt')}</span>
          <span />
        </div>

        {loading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={Search}
              title={t('history.empty.title')}
              description={t('history.empty.desc')}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setQuery('');
                    setStatus('all');
                    setRange('all');
                  }}
                >
                  {t('history.empty.clear')}
                </Button>
              }
            />
          </div>
        ) : (
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const record = filtered[item.index];
              const meta = STATUS_META[record.status];
              const Icon = meta.icon;
              return (
                  <button
                    key={record.id}
                    type="button"
                    data-history-row={record.id}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: item.size,
                      transform: `translateY(${item.start}px)`,
                    }}
                    onClick={(event) => {
                      rowRef.current = event.currentTarget;
                      setSelected(record);
                    }}
                    className={cn(
                      ROW_GRID,
                      'h-12 w-full border-b border-border/70 text-left text-xs transition-colors last:border-b-0 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none focus-visible:ring-inset',
                    )}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[13px] text-foreground">
                        {record.taskName}
                      </span>
                      <span className="truncate font-mono text-[10px] text-muted-foreground">
                        {record.id}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Icon
                        className={cn(
                          'size-3.5',
                          record.status === 'success' && 'text-primary',
                          record.status === 'failed' && 'text-red-600',
                          record.status === 'running' && 'animate-spin text-blue-600',
                        )}
                      />
                      <span
                        className={cn(
                          'text-[11px]',
                          record.status === 'success' && 'text-primary',
                          record.status === 'failed' && 'text-red-700',
                          record.status === 'running' && 'text-blue-700',
                        )}
                      >
                        {t(meta.labelKey)}
                      </span>
                    </span>
                    <span className="text-right font-mono text-[11px] text-muted-foreground">
                      {formatDuration(record.durationMs)}
                    </span>
                    <span
                      className="text-right text-[11px] text-muted-foreground"
                      title={formatAbsolute(record.startedAt)}
                    >
                      {formatRelative(record.startedAt)}
                    </span>
                    <ChevronRight className="size-3.5 justify-self-end text-muted-foreground" />
                  </button>
              );
            })}
            </div>
          </div>
        )}
      </Card>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent
          className={cn('p-0', logExpanded ? 'max-w-none' : 'max-w-[min(1120px,calc(100vw-64px))]')}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            rowRef.current?.focus();
          }}
        >
          {selected ? (
            <>
              <div className="flex flex-col gap-1 border-b border-border px-5 py-4 pr-12">
                <SheetHeader>
                  <div className="flex items-center gap-2">
                    <SheetTitle>{selected.taskName}</SheetTitle>
                    <Badge variant={STATUS_META[selected.status].variant}>
                      {t(STATUS_META[selected.status].labelKey)}
                    </Badge>
                  </div>
                  <SheetDescription className="font-mono text-[11px]">
                    {selected.id} · {formatAbsolute(selected.startedAt)}
                  </SheetDescription>
                </SheetHeader>
              </div>

              <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-y-2 px-5 py-4 text-xs">
                <span className="text-muted-foreground">{t('history.sheet.executor')}</span>
                <span className="font-mono text-[11.5px]">{selected.executorName}</span>
                <span className="text-muted-foreground">{t('history.sheet.duration')}</span>
                <span className="tabular-nums">{formatDuration(selected.durationMs)}</span>
                <span className="text-muted-foreground">{t('history.sheet.exitCode')}</span>
                <span className="font-mono text-[11.5px]">
                  {selected.exitCode === null ? '—' : selected.exitCode}
                </span>
                <span className="text-muted-foreground">{t('history.sheet.logFile')}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground" title={selected.logPath}>
                  {selected.logPath || '—'}
                </span>
              </div>

              <Separator />

              <LogPanel
                lines={log.lines}
                loading={log.loading}
                ariaLabel={`${selected.taskName} ${t('history.sheet.log')}`}
                expanded={logExpanded}
                onToggleExpand={() => setLogExpanded((value) => !value)}
                onCopy={async (copiedLines) => {
                  await navigator.clipboard?.writeText(copiedLines.join('\n'));
                  toast(t('history.toast.copiedLog'));
                }}
                actions={
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      onClick={async () => {
                        const res = await bridge.exportExecLog(selected.id);
                        if (res.ok) toast.success(t('history.toast.exported'), { description: res.path });
                        else toast.error(t('history.toast.exportFailed'), { description: res.message });
                      }}
                    >
                      <Download className="size-3.5" />
                      {t('history.action.export')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => void bridge.openLogFolder()}
                    >
                      <FolderOpen className="size-3.5" />
                      {t('history.action.folder')}
                    </Button>
                  </>
                }
              />

              <SheetFooter>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void copyId(selected.id)}
                >
                  <Copy className="size-3.5" />
                  {t('history.action.copyId')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    const res = await bridge.revealExecLog(selected.id);
                    if (!res.ok) toast.error(t('history.toast.revealFailed'), { description: res.message });
                  }}
                >
                  <FolderOpen className="size-3.5" />
                  {t('history.action.reveal')}
                </Button>
                <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSelected(null)}>
                  {t('history.action.close')}
                </Button>
              </SheetFooter>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            clearRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('history.clear.title')}</DialogTitle>
            <DialogDescription>
              {t('history.clear.desc', { count: records.length })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">{t('history.clear.cancel')}</Button>
            </DialogClose>
            <Button variant="destructive" onClick={() => void clearHistory()} disabled={clearing}>
              {clearing ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {t('history.clear.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
