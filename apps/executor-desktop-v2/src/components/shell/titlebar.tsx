import { Minus, Search, Square, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { bridge, type ExecutorStatus } from '@/lib/ipc';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * 自定义标题栏。
 * 壳无关：Electron 用 CSS app-region，Tauri 用 data-tauri-drag-region，
 * 两者同时保留，迁移时无需改结构。所有可交互元素必须显式 no-drag，
 * 否则真实鼠标点击会被窗口拖拽吞掉（这是 V1 已经踩过的坑）。
 */
const STATUS_LABEL_KEY = {
  online: 'status.online',
  pending: 'status.pending',
  stopped: 'status.stopped',
  offline: 'status.offline',
} as const satisfies Record<ExecutorStatus, Parameters<typeof t>[0]>;


const STATUS_VARIANT: Record<ExecutorStatus, 'success' | 'warning' | 'muted' | 'danger'> = {
  online: 'success',
  pending: 'warning',
  stopped: 'muted',
  offline: 'danger',
};

export function Titlebar({
  status,
  onOpenCommand,
}: {
  status: ExecutorStatus | null;
  onOpenCommand: () => void;
}) {
  return (
    <header
      className="app-drag flex h-11 shrink-0 items-center gap-3 border-b border-border bg-card/80 pl-3.5 pr-2"
      data-tauri-drag-region
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('button, input, a')) return;
        void bridge.toggleMaximize();
      }}
    >
      <div className="flex items-center gap-2">
        <div className="grid size-5 place-items-center rounded-[6px] bg-primary">
          <span className="text-[10px] font-bold text-primary-foreground">A</span>
        </div>
        <span className="text-sm font-semibold tracking-[-0.01em]">AutoCodeFlow</span>
        <span className="text-xs text-muted-foreground">{t('app.executor')}</span>
      </div>

      <Badge
        variant={status ? STATUS_VARIANT[status] : 'danger'}
        className="ml-1 gap-1.5"
      >
        <span
          className={cn(
            'size-1.5 rounded-full',
            status === 'online' && 'animate-pulse bg-primary',
            status === 'pending' && 'bg-amber-500',
            status === 'stopped' && 'bg-muted-foreground',
            (!status || status === 'offline') && 'bg-red-600',
          )}
        />
        {status ? t(STATUS_LABEL_KEY[status]) : t('status.unknown')}
      </Badge>

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={onOpenCommand}
          className="app-no-drag mr-1 hidden h-7 items-center gap-2 rounded-md border border-border bg-secondary/60 px-2 text-2xs text-muted-foreground transition-colors hover:bg-accent md:flex"
        >
          <Search className="size-3" />
          {t('titlebar.search')}
          <kbd className="ml-2 inline-flex items-center gap-0.5 rounded border border-border bg-card px-1 py-px font-mono text-[10px]">
            Ctrl K
          </kbd>
        </button>

        <div className="app-no-drag flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('titlebar.minimize')} onClick={() => void bridge.minimizeWindow()}>
                <Minus />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('titlebar.minimize')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('titlebar.maximize')} onClick={() => void bridge.toggleMaximize()}>
                <Square />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('titlebar.maximize')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('titlebar.close')}
                className="hover:bg-destructive hover:text-white"
                onClick={() => void bridge.closeWindow()}
              >
                <X />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('titlebar.close')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </header>
  );
}
