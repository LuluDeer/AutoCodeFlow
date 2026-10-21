import { Toaster as SonnerToaster } from 'sonner';

export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      offset={16}
      gap={8}
      toastOptions={{
        classNames: {
          toast:
            'rounded-lg border border-border bg-popover text-popover-foreground shadow-lg text-sm',
          description: 'text-muted-foreground text-xs',
          actionButton: 'bg-primary text-primary-foreground text-xs',
          cancelButton: 'bg-secondary text-secondary-foreground text-xs',
        },
      }}
    />
  );
}
