import * as React from 'react';
import { AlertTriangle, Copy, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface Props {
  children: React.ReactNode;
  /** root：整窗兜底（壳层也挂了）；screen：只替换内容区，保留侧栏/标题栏。 */
  variant?: 'root' | 'screen';
  /** 切换页面时传 key，可让边界随页面重置。 */
  resetKey?: string;
}

interface State {
  error: Error | null;
  copied: boolean;
}

/**
 * 渲染层错误边界。
 *
 * 桌面客户端没有浏览器地址栏，白屏等于"应用坏了"——这里至少给出
 * 可恢复动作（重试 / 重载）与可复制的错误信息。
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 主进程日志拿不到渲染层异常，先落到 console；打包态的 devtools 可查。
    console.error('[acf-renderer] uncaught render error', error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, copied: false });
    }
  }

  private reset = (): void => this.setState({ error: null, copied: false });

  private reload = (): void => window.location.reload();

  private copy = async (): Promise<void> => {
    const error = this.state.error;
    if (!error) return;
    await navigator.clipboard?.writeText(`${error.name}: ${error.message}\n${error.stack ?? ''}`);
    this.setState({ copied: true });
    window.setTimeout(() => this.setState({ copied: false }), 1500);
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const isRoot = (this.props.variant ?? 'root') === 'root';
    return (
      <div
        className={cn(
          'flex w-full items-center justify-center p-6',
          isRoot ? 'h-full bg-background' : 'min-h-[360px]',
        )}
      >
        <div
          role="alert"
          className="flex w-full max-w-[520px] flex-col items-center gap-2 rounded-xl border border-border bg-card px-6 py-8 text-center shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
        >
          <div className="grid size-10 place-items-center rounded-full bg-red-600/10">
            <AlertTriangle className="size-4 text-red-700" />
          </div>
          <h2 className="mt-1 text-sm font-semibold">{t('error.title')}</h2>
          <p className="max-w-[42ch] text-xs leading-relaxed text-muted-foreground">
            {t('error.desc')}
          </p>
          <pre className="mt-1 max-h-24 w-full overflow-auto rounded-md bg-secondary/60 px-3 py-2 text-left font-mono text-[10.5px] whitespace-pre-wrap text-secondary-foreground">
            {error.name}: {error.message}
          </pre>
          <div className="mt-2 flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={this.copy}>
              <Copy />
              {this.state.copied ? t('error.copied') : t('error.copy')}
            </Button>
            <Button variant="outline" size="sm" onClick={this.reload}>
              <RotateCw />
              {t('error.reload')}
            </Button>
            <Button size="sm" onClick={this.reset}>
              {t('error.retry')}
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
