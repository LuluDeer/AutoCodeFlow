import * as React from 'react';
import { AppShell } from '@/components/shell/app-shell';
import type { Screen } from '@/components/shell/sidebar';
import { CommandPalette } from '@/components/command-palette';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { ErrorBoundary } from '@/components/error-boundary';
import { Skeleton } from '@/components/ui/skeleton';
import { Wizard } from '@/screens/wizard';
import { bridge, type ExecutionStatus, type ExecutorState } from '@/lib/ipc';
import { t } from '@/lib/i18n';

/**
 * 按屏懒加载：首屏只带 壳层 + 状态页，历史/应用/配置/画廊各自成 chunk。
 * 桌面客户端冷启动时 bundle 解析时间直接体现在窗口出现速度上。
 */
const StatusScreen = React.lazy(() =>
  import('@/screens/status').then((m) => ({ default: m.StatusScreen })),
);
const HistoryScreen = React.lazy(() =>
  import('@/screens/history').then((m) => ({ default: m.HistoryScreen })),
);
const AppsScreen = React.lazy(() =>
  import('@/screens/apps').then((m) => ({ default: m.AppsScreen })),
);
const ConfigScreen = React.lazy(() =>
  import('@/screens/config').then((m) => ({ default: m.ConfigScreen })),
);
const GalleryScreen = React.lazy(() =>
  import('@/screens/gallery').then((m) => ({ default: m.GalleryScreen })),
);

/** V1 主进程用 URL hash 指定窗口/页面：`#wizard` 是独立向导窗口，其余是主窗 Tab。 */
function screenFromHash(): Screen {
  const value = window.location.hash.replace(/^#/, '');
  return value === 'history' || value === 'apps' || value === 'config' ? value : 'status';
}

/**
 * 崩溃探针：只在显式设置 localStorage 时抛错，用于验收错误边界。
 * 正常用户永远不会设置这个键。
 */
function CrashProbe(): null {
  if (window.localStorage.getItem('acf-v2-test-crash') === '1') {
    throw new Error('ACF test crash probe');
  }
  return null;
}

function ScreenFallback() {
  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 p-4 md:p-5">
      <Skeleton className="h-7 w-28" />
      <Skeleton className="h-4 w-72" />
      <Skeleton className="mt-1 h-[360px] w-full" />
    </div>
  );
}

export default function App() {
  const standaloneWizard = window.location.hash === '#wizard';
  const [screen, setScreen] = React.useState<Screen>(() => screenFromHash());
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [wizardOpen, setWizardOpen] = React.useState(false);
  const [historyIntent, setHistoryIntent] = React.useState<{
    status: 'all' | ExecutionStatus;
    query: string;
    nonce: number;
  }>({ status: 'all', query: '', nonce: 0 });
  const [executor, setExecutor] = React.useState<ExecutorState | null>(null);
  const status = executor?.status ?? null;

  React.useEffect(() => {
    let mounted = true;
    bridge
      .getExecutorStatus()
      .then((state) => {
        if (mounted) setExecutor(state);
      })
      .catch(() => {
        /* 桥不可用时保持离线态 */
      });
    const off = bridge.onExecutorStatusChange((status) =>
      setExecutor((prev) => (prev ? { ...prev, status } : prev)),
    );
    return () => {
      mounted = false;
      off();
    };
  }, []);

  /** 普通导航到历史时清掉“带筛选跳转”的意图，避免上次筛选粘住。 */
  function navigate(next: Screen) {
    if (next === 'history') {
      setHistoryIntent((prev) => ({ status: 'all', query: '', nonce: prev.nonce + 1 }));
    }
    setScreen(next);
  }

  function openHistory(intent?: { status?: 'all' | ExecutionStatus; query?: string }) {
    setHistoryIntent((prev) => ({
      status: intent?.status ?? 'all',
      query: intent?.query ?? '',
      nonce: prev.nonce + 1,
    }));
    setScreen('history');
  }

  React.useEffect(() => {
    // 托盘菜单通过主进程 `switch-tab` 请求切页。
    const off = bridge.onSwitchTab((tab) => {
      if (tab === 'status' || tab === 'history' || tab === 'apps' || tab === 'config') {
        navigate(tab);
      }
    });
    return off;
  }, []);

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (mod && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        const order: Screen[] = ['status', 'history', 'apps', 'config'];
        navigate(order[Number(e.key) - 1]);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (standaloneWizard) {
    return (
      <TooltipProvider>
        <div className="relative h-full bg-background">
          <div
            className="app-drag absolute inset-x-0 top-0 flex h-11 items-center gap-2 px-4"
            data-tauri-drag-region
          >
            <div className="grid size-5 place-items-center rounded-[6px] bg-primary">
              <span className="text-[10px] font-bold text-primary-foreground">A</span>
            </div>
            <span className="text-sm font-semibold tracking-[-0.01em]">AutoCodeFlow</span>
            <span className="text-xs text-muted-foreground">{t('app.executor')}</span>
          </div>
          <Wizard
            open
            standalone
            onOpenChange={(open) => {
              if (!open) void bridge.closeWindow();
            }}
          />
        </div>
        <Toaster />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <AppShell
        screen={screen}
        onNavigate={navigate}
        onOpenCommand={() => setPaletteOpen(true)}
        status={status}
        executor={executor}
      >
        <ErrorBoundary variant="screen" resetKey={screen}>
          <React.Suspense fallback={<ScreenFallback />}>
            <CrashProbe />
            {screen === 'status' ? (
              <StatusScreen
                onOpenHistory={openHistory}
                onOpenConfig={() => setScreen('config')}
              />
            ) : null}
          {screen === 'gallery' ? <GalleryScreen /> : null}
          {screen === 'config' ? (
            <ConfigScreen onOpenWizard={() => setWizardOpen(true)} />
          ) : null}
          {screen === 'history' ? (
              <HistoryScreen
                key={historyIntent.nonce}
                initialStatus={historyIntent.status}
                initialQuery={historyIntent.query}
              />
            ) : null}
            {screen === 'apps' ? <AppsScreen /> : null}
          </React.Suspense>
        </ErrorBoundary>
      </AppShell>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNavigate={navigate}
        onOpenWizard={() => setWizardOpen(true)}
      />
      <Wizard open={wizardOpen} onOpenChange={setWizardOpen} />
      <Toaster />
    </TooltipProvider>
  );
}
