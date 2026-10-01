import { Tray, Menu, nativeImage, app } from 'electron';
import * as path from 'path';
import { ExecutorStatus } from './executor-process';
import { agentActivityLabel, agentOutcomeLabel, type AgentStatusSnapshot } from './agent-status-view';
import { TRAY_TEXTS, resolveTrayLocale, traySupportsClick, type TrayLocale, type TrayTexts } from './tray-texts';
import log from './logger';

export class TrayManager {
  private tray: Tray | null = null;
  private currentStatus: ExecutorStatus = 'stopped';
  private agentStatus: AgentStatusSnapshot = {
    enabled: false,
    polling: false,
    working: false,
    lastAssignmentId: null,
    lastOutcome: null,
    processed: 0,
    lastEffectiveProfile: null,
  };

  // 这些回调由 index.ts 注入，避免循环引用
  onStart: (() => Promise<void>) | null = null;
  onStop: (() => Promise<void>) | null = null;
  onOpenStatus: (() => void) | null = null;
  onOpenConfig: (() => void) | null = null;
  onOpenHistory: (() => void) | null = null;
  onToggleAutoLaunch: ((enable: boolean) => Promise<void>) | null = null;
  getAutoLaunch: (() => boolean) | null = null;

  /** 当前 locale（B-7②：en* 英文，其余中文；重建菜单时实时取）。 */
  private locale(): TrayLocale {
    return resolveTrayLocale(() => app.getLocale());
  }

  /** 当前 locale 对应的文案表（同一轮渲染共用一个 locale，杜绝混语）。 */
  private texts(locale: TrayLocale = this.locale()): TrayTexts {
    return TRAY_TEXTS[locale];
  }

  init(): void {
    const icon = this.getIcon('stopped');
    this.tray = new Tray(icon);
    this.updateTooltip();
    this.rebuildMenu();

    // B-7②：Linux 的 AppIndicator 不派发托盘 click 事件——「左键打开状态
    // 窗口」只在支持 click 的平台接线；Linux 依赖菜单（rebuildMenu 把
    // 「查看状态」固定在菜单顶部承接该职责）。
    if (traySupportsClick(process.platform)) {
      this.tray.on('click', () => this.onOpenStatus?.());
    }
    log.info('Tray initialized');
  }

  setStatus(status: ExecutorStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.tray?.setImage(this.getIcon(status));

    this.updateTooltip();
    this.rebuildMenu();
  }

  /** Agent 只改菜单和提示；托盘图标仍专指执行器连接状态。 */
  setAgentStatus(status: AgentStatusSnapshot): void {
    if (
      this.agentStatus.enabled === status.enabled &&
      this.agentStatus.polling === status.polling &&
      this.agentStatus.working === status.working &&
      this.agentStatus.processed === status.processed &&
      this.agentStatus.lastOutcome === status.lastOutcome
    ) return;
    this.agentStatus = status;
    this.updateTooltip();
    this.rebuildMenu();
  }

  private updateTooltip(): void {
    // NETOPT-DEBT：locale 一次判定全行共用——Agent 活动标签与 tooltip 其余段
    // 必须同语言（双语收尾：agent-status-view 标签已入 tray-texts 双语表）。
    const locale = this.locale();
    const t = this.texts(locale);
    this.tray?.setToolTip(
      `${t.tooltip[this.currentStatus]}${t.agentSuffix(agentActivityLabel(this.agentStatus, locale))}`,
    );
  }

  rebuildMenu(): void {
    const locale = this.locale();
    const t = this.texts(locale);
    const status = this.currentStatus;
    const isActive = status === 'online' || status === 'pending';
    const autoLaunchEnabled = this.getAutoLaunch?.() ?? false;
    const separator: Electron.MenuItemConstructorOptions = { type: 'separator' };

    const template: Electron.MenuItemConstructorOptions[] = [
      // B-7②：Linux AppIndicator 无 click 事件——菜单顶部固定「查看状态」，
      // 承接其他平台左键单击打开状态窗口的职责。
      ...(traySupportsClick(process.platform)
        ? []
        : [
            { label: t.viewStatus, click: () => this.onOpenStatus?.() },
            separator,
          ]),
      { label: `${t.statusPrefix}: ${t.statusLabel[status]}`, enabled: false },
      { label: t.agentLine(agentActivityLabel(this.agentStatus, locale)), enabled: false },
      {
        label: t.agentProcessedLine(
          this.agentStatus.processed,
          agentOutcomeLabel(this.agentStatus.lastOutcome, locale),
        ),
        enabled: false,
      },
      { type: 'separator' },
      {
        label: t.startExecutor,
        enabled: !isActive,
        click: () => this.onStart?.(),
      },
      {
        label: t.stopExecutor,
        enabled: isActive,
        click: () => this.onStop?.(),
      },
      { type: 'separator' },
      {
        label: t.viewStatus,
        click: () => this.onOpenStatus?.(),
      },
      {
        label: t.openConfig,
        click: () => this.onOpenConfig?.(),
      },
      {
        label: t.openHistory,
        click: () => this.onOpenHistory?.(),
      },
      { type: 'separator' },
      {
        label: t.autoLaunch,
        type: 'checkbox',
        checked: autoLaunchEnabled,
        click: (item) => this.onToggleAutoLaunch?.(item.checked),
      },
      { type: 'separator' },
      {
        label: t.quit,
        click: () => app.quit(),
      },
    ];

    this.tray?.setContextMenu(Menu.buildFromTemplate(template));
  }

  private getIcon(status: ExecutorStatus): Electron.NativeImage {
    const iconMap: Record<ExecutorStatus, string> = {
      online:  'tray-online@2x.png',
      offline: 'tray-offline@2x.png',
      pending: 'tray-pending@2x.png',
      stopped: 'tray-offline@2x.png',
    };
    const iconDir = app.isPackaged
      ? path.join(process.resourcesPath, 'assets')
      : path.join(app.getAppPath(), 'assets');
    const iconPath = path.join(iconDir, iconMap[status]);
    const img = nativeImage.createFromPath(iconPath);
    // 回退：图标文件不存在时用空图标避免崩溃
    if (img.isEmpty()) {
      log.warn(`Tray icon not found: ${iconPath}`);
      return nativeImage.createEmpty();
    }
    return img;
  }
}
