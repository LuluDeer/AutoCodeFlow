import { CircleDot, Keyboard, Wifi } from 'lucide-react';
import type { ExecutorState, ExecutorStatus } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { Titlebar } from './titlebar';
import { Sidebar, type Screen } from './sidebar';

export function AppShell({
  screen,
  onNavigate,
  onOpenCommand,
  status,
  executor,
  children,
}: {
  screen: Screen;
  onNavigate: (s: Screen) => void;
  onOpenCommand: () => void;
  status: ExecutorStatus | null;
  executor: ExecutorState | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col bg-background">
      <Titlebar status={status} onOpenCommand={onOpenCommand} />
      <div className="flex min-h-0 flex-1">
        <Sidebar screen={screen} onNavigate={onNavigate} />
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      <Statusbar status={status} executor={executor} />
    </div>
  );
}

const HEARTBEAT_KEY = {
  online: 'heartbeat.online',
  pending: 'heartbeat.pending',
  stopped: 'heartbeat.stopped',
  offline: 'heartbeat.offline',
} as const satisfies Record<ExecutorStatus, Parameters<typeof t>[0]>;


function Statusbar({
  status,
  executor,
}: {
  status: ExecutorStatus | null;
  executor: ExecutorState | null;
}) {
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-border bg-card/60 px-3 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <Wifi className="size-3" />
        {executor ? `${executor.host}:${executor.port}` : t('heartbeat.none')}
      </span>
      <span className="flex items-center gap-1.5">
        <CircleDot
          className={cn(
            'size-3',
            status === 'online' && 'text-primary',
            status === 'pending' && 'text-amber-500',
            status === 'offline' && 'text-red-600',
          )}
        />
        {status ? t(HEARTBEAT_KEY[status]) : t('heartbeat.none')}
      </span>
      {executor ? (
        <span className="hidden md:inline">
          {executor.pid ? `PID ${executor.pid} · ` : ''}
          {t('statusbar.concurrency', {
            running: executor.concurrency.running,
            max: executor.concurrency.max,
          })}
        </span>
      ) : null}
      <span className="ml-auto hidden items-center gap-1 md:flex">
        <Keyboard className="size-3" />
        {t('statusbar.shortcut')}
      </span>
    </footer>
  );
}
