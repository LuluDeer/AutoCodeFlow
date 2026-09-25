import { Tray, Menu, nativeImage, app } from 'electron';
import * as path from 'path';
import { ExecutorStatus } from './executor-process';
import { agentActivityLabel, agentOutcomeLabel, type AgentStatusSnapshot } from './agent-status-view';
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

  init(): void {
    const icon = this.getIcon('stopped');
    this.tray = new Tray(icon);
    this.updateTooltip();
    this.rebuildMenu();

    // 左键单击打开状态窗口
    this.tray.on('click', () => this.onOpenStatus?.());
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
    const tooltips: Record<ExecutorStatus, string> = {
      online:  'AutoCodeFlow Executor — 在线 ●',
      offline: 'AutoCodeFlow Executor — 离线 ○',
      pending: 'AutoCodeFlow Executor — 启动中 ◐',
      stopped: 'AutoCodeFlow Executor — 已停止',
    };
    this.tray?.setToolTip(`${tooltips[this.currentStatus]}；Agent：${agentActivityLabel(this.agentStatus)}`);
  }

  rebuildMenu(): void {
    const status = this.currentStatus;
    const isActive = status === 'online' || status === 'pending';
    const autoLaunchEnabled = this.getAutoLaunch?.() ?? false;

    const statusLabel = {
      online:  '● 在线',
      offline: '○ 离线',
      pending: '◐ 启动中...',
      stopped: '— 已停止',
    }[status];

    const menu = Menu.buildFromTemplate([
      { label: `状态: ${statusLabel}`, enabled: false },
      { label: `Agent: ${agentActivityLabel(this.agentStatus)}`, enabled: false },
      { label: `Agent 已处理 ${this.agentStatus.processed} 个指派；最近结果：${agentOutcomeLabel(this.agentStatus.lastOutcome)}`, enabled: false },
      { type: 'separator' },
      {
        label: '启动执行器',
        enabled: !isActive,
        click: () => this.onStart?.(),
      },
      {
        label: '停止执行器',
        enabled: isActive,
        click: () => this.onStop?.(),
      },
      { type: 'separator' },
      {
        label: '查看状态...',
        click: () => this.onOpenStatus?.(),
      },
      {
        label: '打开配置...',
        click: () => this.onOpenConfig?.(),
      },
      {
        label: '历史日志...',
        click: () => this.onOpenHistory?.(),
      },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: autoLaunchEnabled,
        click: (item) => this.onToggleAutoLaunch?.(item.checked),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => app.quit(),
      },
    ]);

    this.tray?.setContextMenu(menu);
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
