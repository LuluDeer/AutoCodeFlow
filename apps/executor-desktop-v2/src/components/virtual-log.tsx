import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import { parseLogLine } from '@/lib/log-parse';

function LogLine({ text }: { text: string }) {
  const parsed = parseLogLine(text);
  const tone =
    parsed.level === 'ERROR'
      ? 'text-red-700'
      : parsed.level === 'WARN'
        ? 'text-amber-700'
        : 'text-muted-foreground';
  return (
    <div className="flex gap-2 px-2 py-[1px] hover:bg-secondary/60">
      <span className="w-[52px] shrink-0 tabular-nums text-muted-foreground">{parsed.time}</span>
      <span className={cn('w-[38px] shrink-0 text-[10px] font-semibold', tone)}>{parsed.level}</span>
      <span className="min-w-0 break-words text-secondary-foreground">{parsed.body}</span>
    </div>
  );
}

export function VirtualLog({
  lines,
  className,
  follow = false,
  ariaLabel = 'Log',
  showLineNumbers = false,
  scrollToEndSignal = 0,
  lineNumbers,
}: {
  lines: string[];
  className?: string;
  follow?: boolean;
  ariaLabel?: string;
  showLineNumbers?: boolean;
  /** 递增该值即可请求滚动到末尾（“跳到末尾”按钮）。 */
  scrollToEndSignal?: number;
  /** 与 lines 等长的原始行号（过滤后仍显示日志里的真实行号）。 */
  lineNumbers?: number[];
}) {
  const parentRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 21,
    overscan: 16,
    // 长行会换行：不能固定 21px 行高，否则文本互相覆盖。
    measureElement: (element) => element.getBoundingClientRect().height,
  });

  React.useEffect(() => {
    if (follow && lines.length > 0) {
      virtualizer.scrollToIndex(lines.length - 1, { align: 'end' });
    }
  }, [follow, lines.length, virtualizer]);

  React.useEffect(() => {
    if (scrollToEndSignal > 0 && lines.length > 0) {
      virtualizer.scrollToIndex(lines.length - 1, { align: 'end' });
    }
  }, [scrollToEndSignal, lines.length, virtualizer]);

  return (
    <div
      ref={parentRef}
      // 可滚动区域必须能获得焦点（axe: scrollable-region-focusable），
      // 键盘用户才能用方向键/PageUp 浏览日志。
      tabIndex={0}
      data-log-viewport=""
      role="region"
      aria-label={ariaLabel}
      className={cn(
        'relative h-full overflow-auto bg-[oklch(0.985_0.003_255)] font-mono text-[11.5px] leading-[21px] focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none',
        className,
      )}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${item.start}px)`,
            }}
          >
            <div className="flex items-start">
              {showLineNumbers ? (
                <span className="w-11 shrink-0 py-[1px] pr-2 pl-3 text-right text-[10px] text-muted-foreground select-none">
                  {lineNumbers?.[item.index] ?? item.index + 1}
                </span>
              ) : null}
              <div className="min-w-0 flex-1">
                <LogLine text={lines[item.index]} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
