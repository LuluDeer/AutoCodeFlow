import {
  Activity,
  Boxes,
  History,
  Palette,
  RefreshCw,
  Settings2,
  Sparkles,
  Stethoscope,
} from 'lucide-react';
import { toast } from 'sonner';
import { bridge } from '@/lib/ipc';
import { t } from '@/lib/i18n';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import type { Screen } from '@/components/shell/sidebar';

export function CommandPalette({
  open,
  onOpenChange,
  onNavigate,
  onOpenWizard,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (s: Screen) => void;
  onOpenWizard: () => void;
}) {
  function go(screen: Screen) {
    onNavigate(screen);
    onOpenChange(false);
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="command.placeholder" />
      <CommandList>
        <CommandEmpty>command.empty</CommandEmpty>
        <CommandGroup heading={t('command.group.go')}>
          <CommandItem onSelect={() => go('status')}>
            <Activity />
            {t('nav.status')}
            <CommandShortcut>Ctrl 1</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go('history')}>
            <History />
            {t('nav.history')}
            <CommandShortcut>Ctrl 2</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go('apps')}>
            <Boxes />
            {t('nav.apps')}
            <CommandShortcut>Ctrl 3</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go('config')}>
            <Settings2 />
            {t('nav.config')}
            <CommandShortcut>Ctrl 4</CommandShortcut>
          </CommandItem>
          {import.meta.env.DEV ? (
            <CommandItem onSelect={() => go('gallery')}>
              <Palette />
              {t('nav.gallery')}
            </CommandItem>
          ) : null}
        </CommandGroup>
        <CommandGroup heading={t('command.group.actions')}>
          <CommandItem
            onSelect={() => {
              onOpenChange(false);
              onOpenWizard();
            }}
          >
            <Sparkles />
            {t('command.wizard')}
          </CommandItem>
          <CommandItem
            onSelect={async () => {
              onOpenChange(false);
              await bridge.stopExecutor();
              await bridge.startExecutor();
              toast.success(t('command.restarting'));
            }}
          >
            <RefreshCw />
            {t('command.restart')}
          </CommandItem>
          <CommandItem
            onSelect={async () => {
              onOpenChange(false);
              const res = await bridge.exportDiagnostics();
              if (res.ok) toast.success(t('command.exported'), { description: res.path });
              else toast.error(t('command.exportFailed'), { description: res.message });
            }}
          >
            <Stethoscope />
            {t('command.diagnostics')}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
