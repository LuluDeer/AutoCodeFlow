import { Tray, Menu, nativeImage, app } from 'electron';
import * as path from 'path';
import { existsSync } from 'fs';
import { ExecutorStatus } from './executor-process';
import { agentActivityLabel, agentOutcomeLabel, agentStatusSignature, type AgentStatusSnapshot } from './agent-status-view';
import { TRAY_TEXTS, resolveTrayLocale, traySupportsClick, type TrayLocale, type TrayTexts } from './tray-texts';
import { isTrayStopActive, trayStopGate } from './tray-stop-gate';
import log from './logger';

export class TrayManager {
  private tray: Tray | null = null;
  private currentStatus: ExecutorStatus = 'stopped';
  /** 运行中任务数（来自 meta 目录扫描，0 = 不展示活动行）。 */
  private runningCount = 0;
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
  /** P1-TRAY-STOP：active 时的原生二次确认，由 index.ts 与 stop 入口同处注入。 */
  confirmStop: (() => Promise<boolean>) | null = null;
  onOpenStatus: (() => void) | null = null;
  /** 阶段 A（ADR-044）：打开独立工作台窗口（由 index.ts 注入）。 */
  onOpenWorkbench: (() => void) | null = null;
  onOpenConfig: (() => void) | null = null;
  onOpenHistory: (() => void) | null = null;
  onOpenApps: (() => void) | null = null;
  // V4 审计 P2：托盘菜单拓展——「检查更新」（updater 用户主动检查链路）与
  // 「打开日志文件夹」（ipc-handlers openTaskLogFolder，与 history:open-log-folder
  // 同一实现）；逻辑在各自模块，这里只注入回调。
  onCheckForUpdate: (() => Promise<void> | void) | null = null;
  onOpenLogFolder: (() => Promise<void> | void) | null = null;
  onToggleAutoLaunch: ((enable: boolean) => Promise<void>) | null = null;
  getAutoLaunch: (() => boolean) | null = null;
  /**
   * i18n-DESK-01：已落盘的界面语言设置（uiLanguage）读取回调，由 index.ts 注入
   * （同 getAutoLaunch 的注入方式——tray.ts 不能 import index.ts 的 configStore
   * 单例，那是循环引用；也不该自己 new 一个 ConfigStore，那会读第二份存储句柄）。
   * 返回 undefined 时回落系统语言自动判定（同改动前行为）。
   */
  getUiLanguage: (() => string | undefined) | null = null;

  // V4 审计 P3：启停项在飞互斥——托盘菜单可快速连点，而 start/stop 是秒级
  // 异步动作（spawn/kill 子进程 + 40s 停机超时链），重复触发会叠加竞态
  // （快速双击 = 两次 start()）。在飞期间忽略新点击；菜单项 enabled 由
  // rebuildMenu 按 currentStatus 刷新，是另一道兜底。只在点击回调入口做
  // 互斥，不动 menu 重建路径（保守口径，见清单约束）。
  private startStopInFlight = false;

  /** B7 / P1-TRAY-STOP：启停点击在飞互斥 + 托盘 stop 的 active 二次确认。 */
  private runStartStop(kind: 'start' | 'stop'): void {
    if (this.startStopInFlight) return;
    const cb = kind === 'start' ? this.onStart : this.onStop;
    if (!cb) return;
    const gate = kind === 'stop'
      ? trayStopGate(this.currentStatus, { inFlight: this.startStopInFlight })
      : null;
    this.startStopInFlight = true;
    void (async () => {
      try {
        if (gate === 'confirm') {
          let confirmed = false;
          try {
            confirmed = (await this.confirmStop?.()) ?? false;
          } catch (err) {
            log.warn(`tray stop confirm failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          // 确认取消 / 确认通道故障一律不落 stop；inFlight 在 confirmed 分支
          // 之后判定，二次确认期间持有的互斥标志不会把确认结果误吞。
          if (trayStopGate(this.currentStatus, { inFlight: this.startStopInFlight, confirmed }) !== 'stop') return;
        }
        await cb();
      } catch (err) {
        log.warn(`tray ${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.startStopInFlight = false;
      }
    })();
  }

  /**
   * 当前 locale。i18n-DESK-01：**先看用户在设置页选的语言**（uiLanguage，
   * index.ts 注入的读取回调），'auto'/未设置时才回落 app.getLocale() 的
   * `en*` 判定。每次 rebuildMenu / updateTooltip 都重新判定——保存语言设置后
   * 菜单当场切换，托盘不需要重启应用。
   */
  private locale(): TrayLocale {
    return resolveTrayLocale(() => app.getLocale(), this.getUiLanguage?.());
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

  /**
   * 注入当前运行中任务数（① 托盘实时活动）。同源 meta 扫描驱动；
   * 计数未变化时不重建菜单 / 提示，避免 fs.watch 突发事件刷爆原生菜单。
   */
  setRunningCount(count: number): void {
    const next = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    if (this.runningCount === next) return;
    this.runningCount = next;
    this.updateTooltip();
    this.rebuildMenu();
  }

  /** Agent 只改菜单和提示；托盘图标仍专指执行器连接状态。 */
  setAgentStatus(status: AgentStatusSnapshot): void {
    // R5-T2：早退比较改成全字段签名——lastAssignmentId / lastEffectiveProfile
    // 变化也必须重绘，否则新指派/换档位后菜单一直停在上一单的展示。
    if (agentStatusSignature(this.agentStatus) === agentStatusSignature(status)) return;
    this.agentStatus = status;
    this.updateTooltip();
    this.rebuildMenu();
  }

  private updateTooltip(): void {
    // NETOPT-DEBT：locale 一次判定全行共用——Agent 活动标签与 tooltip 其余段
    // 必须同语言（双语收尾：agent-status-view 标签已入 tray-texts 双语表）。
    const locale = this.locale();
    const t = this.texts(locale);
    const activity = this.runningCount > 0 ? t.activitySuffix(this.runningCount) : '';
    this.tray?.setToolTip(
      `${t.tooltip[this.currentStatus]}${activity}${t.agentSuffix(agentActivityLabel(this.agentStatus, locale))}`,
    );
  }

  rebuildMenu(): void {
    const locale = this.locale();
    const t = this.texts(locale);
    const status = this.currentStatus;
    const isActive = isTrayStopActive(status);
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
      ...(this.runningCount > 0
        ? [{ label: t.activityLine(this.runningCount), enabled: false } as Electron.MenuItemConstructorOptions]
        : []),
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
        click: () => this.runStartStop('start'),
      },
      {
        label: t.stopExecutor,
        enabled: isActive,
        click: () => this.runStartStop('stop'),
      },
      { type: 'separator' },
      {
        label: t.viewStatus,
        click: () => this.onOpenStatus?.(),
      },
      {
        label: t.openWorkbench,
        click: () => {
          try {
            this.onOpenWorkbench?.();
          } catch (err) {
            log.warn(`open workbench from tray failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      },
      {
        label: t.openConfig,
        click: () => this.onOpenConfig?.(),
      },
      {
        label: t.openHistory,
        click: () => this.onOpenHistory?.(),
      },
      {
        label: t.openApps,
        click: () => this.onOpenApps?.(),
      },
      { type: 'separator' },
      {
        // V4 审计 P2：与设置页「检查更新」同一条用户主动检查链路（错误经
        // updater:error 广播显性化；dev 未打包时静默 no-op）。
        label: t.checkUpdate,
        click: () => this.onCheckForUpdate?.(),
      },
      {
        // V4 审计 P2：任务日志目录直达入口（托盘态不必先开窗再进历史页）。
        label: t.openLogFolder,
        click: () => this.onOpenLogFolder?.(),
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
    // i18n-DESK-01：语言设置变更后 finalizeConfigSave 只调 rebuildMenu——tooltip
    // 必须跟着一起换语言，否则会出现「菜单已是英文、悬停提示仍是中文」的混语
    // 界面（locale 是按当前设置实时判定的，两者必须同进同出）。
    this.updateTooltip();
  }

  private getIcon(status: ExecutorStatus): Electron.NativeImage {
    const iconMap: Record<ExecutorStatus, string> = {
      online:  'tray-online@2x.png',
      offline: 'tray-offline@2x.png',
      pending: 'tray-pending@2x.png',
      stopped: 'tray-offline@2x.png',
    };
    // 托盘图标目录双路径探测（对齐 window-manager QA-12 先例），三种形态：
    //   1) 打包：tray-*.png 经 electron-builder extraResources 落在
    //      <install>/resources/assets，用 process.resourcesPath 拼；
    //   2) 正常 dev（npm run dev / electron .）：getAppPath()=应用根，
    //      取 <appRoot>/assets；
    //   3) 裸 electron 直跑 dist/main/index.js（playwright _electron.launch /
    //      e2e）：getAppPath()===__dirname（dist/main），候选 1 会解析成
    //      dist/main/assets（不存在，QA-12 同源问题）——候选 2 用 __dirname
    //      上两级（=应用根；打包态则落在 resources/，同样正确）补位。
    // 按顺序取第一个「图标文件确实存在」的目录；都找不到时落回首选候选，
    // 交给下方 isEmpty 兜底（createEmpty + log.warn）。
    const iconFile = iconMap[status];
    const candidateDirs = [
      app.isPackaged
        ? path.join(process.resourcesPath, 'assets')
        : path.join(app.getAppPath(), 'assets'),
      path.join(__dirname, '../../assets'),
    ];
    const iconDir = candidateDirs.find((dir) => existsSync(path.join(dir, iconFile)))
      ?? candidateDirs[0];
    const iconPath = path.join(iconDir, iconFile);
    const img = nativeImage.createFromPath(iconPath);
    // 回退：所有候选目录都没有该图标文件时用空图标避免崩溃
    if (img.isEmpty()) {
      log.warn(`Tray icon not found: ${iconPath}`);
      return nativeImage.createEmpty();
    }
    return img;
  }
}
