import type { ComponentType, ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-input px-6 py-14 text-center',
        className,
      )}
    >
      <div className="grid size-10 place-items-center rounded-full bg-secondary">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="mt-1 text-sm font-medium">{title}</div>
      {description ? (
        <p className="max-w-[34ch] text-xs leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
