import * as React from 'react';
import type { ReactNode } from 'react';
import { ArrowDownToLine, Copy, Maximize2, Minimize2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { VirtualLog } from '@/components/virtual-log';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * 日志排查面板：搜索、行号、跳到末尾、复制、放大。
 * 应用日志与执行日志共用，保证两处操作习惯一致。
 */
export function LogPanel({
  lines,
  loading,
  ariaLabel,
  actions,
  expanded = false,
  onToggleExpand,
  onCopy,
  toolbarStart,
  toolbarEnd,
  follow = false,
  showLineNumbers = true,
  allowExpand = true,
}: {
  lines: string[];
  loading: boolean;
  ariaLabel: string;
  /** 额外操作（导出、打开文件夹等） */
  actions?: ReactNode;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onCopy: (lines: string[]) => void | Promise<void>;
  /** 工具条左侧插槽（例如状态页的级别筛选）。 */
  toolbarStart?: ReactNode;
  /** 工具条右侧插槽（例如暂停/清空）。 */
  toolbarEnd?: ReactNode;
  follow?: boolean;
  showLineNumbers?: boolean;
  allowExpand?: boolean;
}) {
  const [query, setQuery] = React.useState('');
  const [scrollSignal, setScrollSignal] = React.useState(0);
  const [showAll, setShowAll] = React.useState(false);
  const deferredQuery = React.useDeferredValue(query);
  const MAX_PREVIEW = 5000;

  // 大日志只先渲染尾部 5000 行（含原始行号偏移）；点「显示全部」再放开。
  // 搜索走 useDeferredValue，避免在几十万行上每敲一个字都同步阻塞输入。
  const preview = React.useMemo(() => {
    if (showAll || lines.length <= MAX_PREVIEW) {
      return lines.map((text, index) => ({ text, index }));
    }
    const start = lines.length - MAX_PREVIEW;
    return lines.slice(start).map((text, index) => ({ text, index: start + index }));
  }, [lines, showAll, MAX_PREVIEW]);

  const filtered = React.useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    return preview.filter((entry) => !needle || entry.text.toLowerCase().includes(needle));
  }, [preview, deferredQuery]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-5 py-2">
        {toolbarStart}
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('log.search')}
            className="h-7 w-52 pl-8 text-xs"
            aria-label={t('log.search')}
          />
        </div>
        <span className="text-[11px] text-muted-foreground">
          {query.trim()
            ? t('log.matches', { matched: filtered.length, total: preview.length })
            : t('log.lineCount', { count: preview.length })}
        </span>

        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => setScrollSignal((value) => value + 1)}
          >
            <ArrowDownToLine className="size-3.5" />
            {t('log.jumpEnd')}
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => onCopy(filtered.map((entry) => entry.text))}>
            <Copy className="size-3.5" />
            {t('log.copy')}
          </Button>
          {actions}
          {toolbarEnd}
          {allowExpand ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={expanded ? t('log.collapse') : t('log.expand')}
              title={expanded ? t('log.collapse') : t('log.expand')}
              onClick={onToggleExpand}
            >
              {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </Button>
          ) : null}
        </div>
      </div>

      {lines.length > MAX_PREVIEW && !showAll ? (
        <div className="flex items-center gap-2 px-5 pb-1 text-[11px] text-muted-foreground">
          {t('log.preview', { shown: MAX_PREVIEW, total: lines.length })}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => setShowAll(true)}
          >
            {t('log.showAll')}
          </button>
        </div>
      ) : null}

      <div className={cn('min-h-0 flex-1 border-y border-border')}>
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 bg-[oklch(0.985_0.003_255)] text-xs text-muted-foreground">
            {t('log.reading')}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center bg-[oklch(0.985_0.003_255)] text-xs text-muted-foreground">
            {query.trim() ? t('log.noMatch') : t('log.empty')}
          </div>
        ) : (
          <VirtualLog
            lines={filtered.map((entry) => entry.text)}
            lineNumbers={filtered.map((entry) => entry.index + 1)}
            ariaLabel={ariaLabel}
            showLineNumbers={showLineNumbers}
            follow={follow}
            scrollToEndSignal={scrollSignal}
          />
        )}
      </div>
    </>
  );
}
