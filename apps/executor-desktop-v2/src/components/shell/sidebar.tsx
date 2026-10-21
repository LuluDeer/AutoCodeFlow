import { Activity, Boxes, History, Palette, Settings2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t, type I18nKey } from '@/lib/i18n';

export type Screen = 'status' | 'history' | 'apps' | 'config' | 'gallery';

type NavItem = {
  key: Screen;
  labelKey: I18nKey;
  icon: typeof Activity;
  /** 只在本机 dev 构建里出现的入口（组件画廊）。 */
  devOnly?: boolean;
};

const NAV: { titleKey: I18nKey; items: NavItem[] }[] = [
  {
    titleKey: 'nav.run',
    items: [
      { key: 'status', labelKey: 'nav.status', icon: Activity },
      { key: 'history', labelKey: 'nav.history', icon: History },
    ],
  },
  {
    titleKey: 'nav.resources',
    items: [{ key: 'apps', labelKey: 'nav.apps', icon: Boxes }],
  },
  {
    titleKey: 'nav.system',
    items: [{ key: 'config', labelKey: 'nav.config', icon: Settings2 }],
  },
  {
    titleKey: 'nav.design',
    items: [{ key: 'gallery', labelKey: 'nav.gallery', icon: Palette, devOnly: true }],
  },
];

export function Sidebar({
  screen,
  onNavigate,
}: {
  screen: Screen;
  onNavigate: (s: Screen) => void;
}) {
  return (
    <aside className="flex w-[52px] shrink-0 flex-col border-r border-border bg-sidebar md:w-[188px]">
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {NAV.map((group) => {
          const items = group.items.filter((item) => !item.devOnly || import.meta.env.DEV);
          if (items.length === 0) return null;
          return (
            <div key={group.titleKey} className="mb-1.5 last:mb-0 md:mb-4">
              <div className="hidden px-2 pb-1.5 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase md:block">
                {t(group.titleKey)}
              </div>
              <ul className="flex flex-col gap-0.5">
                {items.map((item) => {
                  const active = screen === item.key;
                  const Icon = item.icon;
                  const label = t(item.labelKey);
                  return (
                    <li key={item.key}>
                      <button
                        type="button"
                        onClick={() => onNavigate(item.key)}
                        title={label}
                        aria-current={active ? 'page' : undefined}
                        aria-label={label}
                        className={cn(
                          'group flex h-8 w-full items-center justify-center gap-0 rounded-md px-0 text-sm transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none md:h-[30px] md:justify-start md:gap-2.5 md:px-2',
                          active
                            ? 'bg-sidebar-accent font-medium text-foreground'
                            : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                        )}
                      >
                        <Icon
                          className={cn(
                            'size-4 shrink-0',
                            active ? 'text-primary' : 'text-muted-foreground',
                          )}
                        />
                        <span className="hidden truncate md:inline">{label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border p-2">
        <div className="flex w-full items-center gap-2 rounded-md px-0 py-1.5 md:px-2">
          <span className="mx-auto size-1.5 rounded-full bg-primary md:mx-0" aria-hidden />
          <span className="hidden truncate text-xs font-medium md:inline">v2.0.0</span>
          <span className="ml-auto hidden shrink-0 text-[10px] text-muted-foreground md:inline">
            {t('nav.latest')}
          </span>
        </div>
      </div>
    </aside>
  );
}
