import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

/**
 * 筛选用的分段控件。
 *
 * 为什么不用 Radix Tabs：筛选没有对应的 content panel，Tabs 会生成
 * `aria-controls` 指向不存在的节点（axe: aria-valid-attr-value）。
 * 这里用 `role=group` + `aria-pressed`，语义与行为都更准确。
 */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  label,
  className,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: SegmentedOption<T>[];
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-card p-0.5 text-muted-foreground',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onValueChange(option.value)}
            className={cn(
              'inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors duration-150',
              'focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none',
              active
                ? 'bg-secondary text-foreground shadow-[0_1px_2px_rgba(16,24,40,0.05)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
