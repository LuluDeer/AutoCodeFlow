import { app, Menu, dialog, powerMonitor } from 'electron';
import { ConfigStore } from './config-store';
import { ExecutorProcess } from './executor-process';
import { AgentHost } from './agent/agent-host';
import { CollabClient } from './agent/collab-client';
import type { AgentStatusSnapshot } from './agent-status-view';
import { agentHostIdentity as buildAgentHostIdentity, agentHostTransition } from './agent-host-lifecycle';
import { HeartbeatMonitor } from './heartbeat';
import { TrayManager } from './tray';
import { WindowManager } from './window-manager';
import { registerIpcHandlers, startHeartbeat, sweepReleasesWithCurrentConfig } from './ipc-handlers';
import { getAutoLaunchEnabled, setAutoLaunchEnabled } from './autolaunch';
import { initUpdater } from './updater';
import { Notifier } from './notifier';
import { createCrashGuard } from './crash-guard';
import { resolveTrayLocale } from './tray-texts';
import * as path from 'path';
import log, { applyLogLevel, initLogCleanup } from './logger';

// WIN-DISPLAY-HWACCEL (1.4.5 hotfix / N48)：部分 Windows 机器/显卡驱动上，
// Chromium 硬件加速合成失败会表现为「窗口有背景色但内容黑屏」——与 v1.4.4
// 修复透明后用户实测吻合。该故障不影响托盘/主进程，日志也往往无报错。
// 对小体量托盘应用而言，强制关闭硬件加速（软件合成，SwiftShader/Windows
// D2D/Skia 兜底）是彻底消除此类黑屏的标准、稳妥方案。
// 必须在 app ready / 任何窗口创建前调用才生效。
app.disableHardwareAcceleration();

// QA-12：e2e 隔离通道——冒烟用例经 env 覆盖 userData 指向临时目录，
// 绝不触碰开发者真实配置；未设置时行为与旧版逐字节一致。
if (process.env.ELECTRON_USER_DATA_DIR) {
  app.setPath('userData', process.env.ELECTRON_USER_DATA_DIR);
}

// B-7：单实例锁必须**先于** ConfigStore 构造。旧实现先 new ConfigStore()
// （内含 token 就地加密迁移等**写盘副作用**，且读的是即将被覆盖的 userData）
// 再抢锁——第二实例会先跑一遍这些副作用、与第一实例竞争同一配置文件，然后
// 才默默退出；锁抢不到的瞬间越早退出，竞态窗口越小。
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// before-quit 是同步事件，Electron 不等 async 回调。
// 用 preventDefault 阻止退出，待 executor-node 子进程真正结束后再 quit。
let isQuitting = false;

// B-1①：主进程全局崩溃兜底。必须先于一切业务初始化注册，覆盖整个生命周期
// （含 ConfigStore 构造）。决策语义见 crash-guard.ts 头注：记录（每次）+
// dialog（一次，文案随 tray-texts 同款 locale 判定）+ 经既有 before-quit
// 停机序优雅停掉 executor-node 后退出；已在退出流程中时交还给既有链，
// 停机链挂死有 40s 硬超时兜底。全仓无 app.relaunch 先例，不做自动重启
// （避免把一次性故障放大成重启风暴）。
const crashGuard = createCrashGuard({
  logError: (message) => log.error(message),
  showErrorBox: (title, body) => dialog.showErrorBox(title, body),
  locale: () => resolveTrayLocale(() => app.getLocale()),
  isQuitting: () => isQuitting,
  quitApp: () => app.quit(),
  forceExit: (code) => process.exit(code),
});
process.on('uncaughtException', (err) => crashGuard.handle('uncaughtException', err));
process.on('unhandledRejection', (reason) => crashGuard.handle('unhandledRejection', reason));

export const configStore = new ConfigStore();
// P3-1：logLevel 不再是死字段——启动即按已保存配置设置桌面端文件日志级别。
applyLogLevel(configStore.get('logLevel'));
export const executorProcess = new ExecutorProcess();
export const heartbeat = new HeartbeatMonitor();
export const trayManager = new TrayManager();
export const windowManager = new WindowManager();
// DSK-04：系统通知（任务终态 / 执行器离线）
export const notifier = new Notifier();

app.on('second-instance', () => {
  windowManager.focusOrOpenStatus();
});

// 托盘应用不随最后一个窗口关闭而退出
app.on('window-all-closed', () => undefined);

// before-quit 是同步事件，Electron 不等 async 回调。
// 用 preventDefault 阻止退出，待 executor-node 子进程真正结束后再 quit。
// （isQuitting 声明已上移到崩溃兜底之前——兜底的 isQuitting 判定要覆盖
// before-quit 链本身，见文件顶部 B-1① 注释。）
app.on('before-quit', (e) => {
  if (isQuitting) return; // 第二次进来直接放行
  e.preventDefault();
  isQuitting = true;
  log.info('App quitting, stopping executor and heartbeat...');
  heartbeat.stop();
  executorProcess.stop().finally(() => {
    app.quit(); // 子进程已退出，真正退出
  });
});

app.whenReady().then(async () => {
  // 移除默认菜单栏（File/Edit/View 等），Linux/Windows 上会显示原生菜单
  Menu.setApplicationMenu(null);
  log.info(`App ready. userData: ${app.getPath('userData')}`);

  // 初始化日志清理（自动删除旧日志）
  initLogCleanup();

  // 注入托盘回调
  trayManager.onStart = async () => {
    // B-1：start() 现在会因「端口被非本执行器占用」等启动期故障抛错——托盘
    // 是无人值守的路径，绝不能把 rejection 漏给全局兜底（那会退出整个应用）。
    // start() 已把状态置为 offline，这里只落日志并保住心跳不误启。
    try {
      await executorProcess.start(configStore.getAll());
    } catch (err) {
      log.error(`Executor start failed (tray): ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // F-3: 传入 adminApiUrl——HeartbeatMonitor 增加直达中台的 /api/health 探针，
    // 与本地 /health/live 做 AND 逻辑（executor-node 子进程活着但中台链路断开时
    // 桌面也能感知离线）。
    // EXP-03：这条原本是**唯一**传对了参数、却是最少被走到的路径。现与其余
    // 四条统一收敛到 startHeartbeat()（同源读取端口 + adminApiUrl），
    // 避免"五处调用点各自传参、漏一个就静默退化"。
    startHeartbeat();
  };
  trayManager.onStop = async () => {
    heartbeat.stop();
    await executorProcess.stop();
  };
  trayManager.onOpenStatus = () => windowManager.focusOrOpenStatus();
  // B-14：未完成向导时，「打开配置」此前会拉起主窗口的状态页——页面上只有
  // 空状态与「未配置」的执行器，配置入口和用户意图错位。改为打开/聚焦向导，
  // 与首次启动行为一致；已完成配置时保持原语义。
  trayManager.onOpenConfig = () => {
    if (!configStore.get('configured')) {
      windowManager.openWizard();
      return;
    }
    windowManager.openConfig();
  };
  trayManager.onOpenHistory = () => windowManager.openHistory();
  trayManager.onToggleAutoLaunch = async (enable) => {
    // DEV-AUTOLAUNCH：setAutoLaunchEnabled 返回是否真正生效——开发模式拒绝
    // 写入且返回 false，此时**不能**把 autoStart 存成 true，否则托盘/设置页
    // 会误显示「已开启」而系统层其实没有自启项（且历史残留已被清理）。
    const applied = await setAutoLaunchEnabled(enable);
    if (applied) configStore.save({ autoStart: enable });
    trayManager.rebuildMenu();
  };
  trayManager.getAutoLaunch = () => configStore.get('autoStart');

  // 执行器状态变化 → 同步托盘图标 + 系统通知（DSK-04：仅 offline 转移报）
  executorProcess.setStatusCallback((status) => {
    trayManager.setStatus(status);
    notifier.onExecutorStatus(status);
  });

  // 心跳结果 → 同步托盘图标 + 系统通知
  heartbeat.setCallback((status) => {
    trayManager.setStatus(status);
    notifier.onExecutorStatus(status);
  });

  // 初始化托盘
  trayManager.init();

  // DSK-04：系统通知初始化——开关读配置；点击通知聚焦状态窗口；
  // 轮询 workDir/meta 捕获任务终态（executor-node writeExecMeta 落盘）。
  notifier.onOpenStatusCallback = () => windowManager.focusOrOpenStatus();
  notifier.setEnabled(configStore.get('notifyEnabled'));
  const workDir = configStore.get('workDir');
  notifier.startMetaPolling(workDir ? path.join(workDir, 'meta') : null);

  // 注册所有 IPC handlers
  registerIpcHandlers();

  // DSK-03：自动更新仅生产包启用（dev 下 electron-updater 无 app-update.yml
  // 会报错；且开发期不应触发升级流程）。initUpdater 内部延迟 30s 检查、
  // 失败静默，见 src/main/updater.ts。
  if (app.isPackaged) {
    initUpdater();
  } else {
    log.info('updater: skipped in unpackaged dev run');
  }

  // B-2：休眠唤醒——心跳迟滞的「距上次成功 >90s」判据锚在 lastSuccessAt 上，
  // 跨休眠陈旧后，唤醒首轮探针失败即弹「执行器离线」（全仓此前无任何
  // powerMonitor resume 处理）。唤醒时把 HeartbeatMonitor 双通道与
  // ExecutorProcess 双通道（admin 状态 / liveness）的迟滞锚点全部重置为
  // 「未判定」态并立即补探一轮——重置后首轮失败只推进计数，不再判死。
  powerMonitor.on('resume', () => {
    log.info('powerMonitor: resume — resetting offline hysteresis anchors (B-2)');
    try {
      heartbeat.resetForResume();
      executorProcess.resetHysteresisForResume();
    } catch (err) {
      // 重置失败绝不能变成第二个崩溃源（兜底链上不叠新险）
      log.warn(`resume reset failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // B-13：启动后触发一次 releases 保留期清扫（另一次触发在部署成功的日志
  // 钩子上，见下方 onDeploySwitch 接线）。清扫内部对执行器不可达/状态未知
  // 一律保守跳过，且失败只落日志——绝不影响启动主链。
  executorProcess.onDeploySwitch = () => {
    void sweepReleasesWithCurrentConfig();
  };
  void sweepReleasesWithCurrentConfig();

  const cfg = configStore.getAll();
  if (!cfg.configured) {
    // 首次运行，打开配置向导
    windowManager.openWizard();
  } else if (cfg.autoStartExecutor) {
    // 已配置且设置了自动启动
    // B-1：同托盘路径——启动期故障（端口被占等）必须在此接住，不能把
    // rejection 漏给全局兜底（那会在开机自启场景直接退出应用）。
    try {
      await executorProcess.start(cfg);
    } catch (err) {
      log.error(`Executor auto-start failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // EXP-03（本轮体验审查）：此前写 `heartbeat.start(cfg.executorPort)`
    // ——漏了 adminApiUrl，于是**开机自启这条最常见的路径上**中台直达探针
    // 静默失效（VPN 断裂时托盘仍显示"在线"）。改走 ipc-handlers 的
    // startHeartbeat()，它是全仓唯一的心跳启动入口，端口与 adminApiUrl
    // 同源读取，不会再出现"某个调用点少传一个参数"。
    // B-1：即便 start 失败也照常启动心跳探针——它对未监听端口只会累计
    // 失败计数（迟滞口径下不会误报），等用户修好配置/端口后能自动恢复。
    startHeartbeat();
  }

  // P7b：Agent 托管（agentEnabled=true 且配置齐全时开始轮询 agent-collab）
  syncAgentHostWithConfig();
  // P7c：Agent 处理一单可能持续数分钟，托盘需要在工作态变化时及时更新。
  // 状态快照是本地内存读取；未变化时 TrayManager 不重建菜单。
  const agentStatusTimer = setInterval(refreshTrayAgentStatus, 2_000);
  agentStatusTimer.unref?.();
});

// DSK-04：配置保存后热同步通知开关与 meta 轮询目录（workDir 可能被改）。
// 由 ipc-handlers 的 config:save 面调用，避免 ipc-handlers 反向 import index
// 之外的模块知识。
export function syncNotifierWithConfig(): void {
  notifier.setEnabled(configStore.get('notifyEnabled'));
  const workDir = configStore.get('workDir');
  notifier.startMetaPolling(workDir ? path.join(workDir, 'meta') : null);
}

// ── P7b：Agent 托管接线（agent-collab 轮询循环）────────────────────────

const AGENT_POLL_INTERVAL_MS = 30_000;
let agentHost: AgentHost | null = null;
let agentHostIdentity: string | null = null;
let agentHostReady: Promise<void> = Promise.resolve();
let agentTickPromise: Promise<unknown> | null = null;
let agentTimer: NodeJS.Timeout | null = null;
let lastAgentStatusRefreshError: string | null = null;

function configuredAgentIdentity(cfg: ReturnType<typeof configStore.getAll>): string {
  return buildAgentHostIdentity({
    baseUrl: cfg.adminApiUrl,
    token: configStore.getDecryptedToken(),
    address: cfg.executorAddressPublic || `${cfg.executorHost}:${cfg.executorPort}`,
    workDir: cfg.workDir,
  });
}

function queueAgentWithdrawal(host: AgentHost): void {
  agentHostReady = agentHostReady.then(() => host.withdrawCapabilities()).catch((err) => {
    log.warn(`[agent-host] capability withdrawal failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** 按当前配置重建/启停 agent-host（config:save 后与启动时各调一次）。 */
export function syncAgentHostWithConfig(): void {
  try {
    const cfg = configStore.getAll();
    if (cfg.agentEnabled && cfg.adminApiUrl && cfg.workDir) {
      const identity = configuredAgentIdentity(cfg);
      const transition = agentHostTransition(agentHostIdentity, identity, agentTickPromise !== null);
      if (transition === 'defer') return;
      if (transition === 'replace' && agentHost) {
        // 当前 tick 可能正在使用旧 Client/工作目录；等它结束再切换。
        queueAgentWithdrawal(agentHost);
        agentHost = null;
        agentHostIdentity = null;
      }
      if (!agentHost) {
        const boundIdentity = identity;
        agentHost = new AgentHost({
          address: cfg.executorAddressPublic || `${cfg.executorHost}:${cfg.executorPort}`,
          workDir: cfg.workDir,
          getConfig: () => {
            const c = configStore.getAll();
            return {
              agentEnabled: c.agentEnabled === true && configuredAgentIdentity(c) === boundIdentity,
              adminApiUrl: c.adminApiUrl,
              executorToken: c.executorToken,
              agent: {
                preset: c.agentPermissionProfile,
                codeExecution: c.agentCodeExecution,
                sandboxBackend: c.agentSandboxBackend,
                hostAccess: c.agentHostAccess,
                taskExecution: c.agentTaskExecution,
                allowedApps: c.agentAllowedApps,
                allowedDomains: c.agentAllowedDomains,
              },
            };
          },
          client: new CollabClient({
            baseUrl: cfg.adminApiUrl,
            // token 经 getDecryptedToken 现取——ADR-012 的加密信封不落明文
            token: configStore.getDecryptedToken(),
          }),
        });
        agentHostIdentity = identity;
        log.info('[agent-host] created (agentEnabled=true)');
      }
      if (!agentTimer) {
        // host.tick 内部恒 0 等待：轮询节奏由本定时器驱动；处理指派是
        // 分钟级动作（LLM 循环），host 单飞行保证不并发
        agentTimer = setInterval(() => {
          syncAgentHostWithConfig();
          const host = agentHost;
          if (!agentTimer || !host || agentTickPromise) return;
          const ready = agentHostReady;
          agentTickPromise = ready.then(async () => {
            if (host === agentHost) await host.tick();
          }).catch((err) => {
            log.warn(`[agent-host] tick failed: ${err instanceof Error ? err.message : String(err)}`);
          }).finally(() => {
            agentTickPromise = null;
            syncAgentHostWithConfig();
          });
        }, AGENT_POLL_INTERVAL_MS);
        agentTimer.unref?.();
      }
    } else {
      // 关闭开关 / 配置不全：停轮询。host 可在配置补全后按 identity 复用。
      if (agentTimer) {
        clearInterval(agentTimer);
        agentTimer = null;
      }
      // 当前指派仍在处理时由 host 延后到 finally 撤销；新指派立即停收。
      if (agentHost) queueAgentWithdrawal(agentHost);
    }
  } catch (err) {
    // Agent 托管绝不影响桌面主链（执行器子进程/心跳/托盘）——失败仅记日志
    log.warn(`[agent-host] sync failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // 配置保存后立即反映在托盘，不等下一次状态轮询。
    refreshTrayAgentStatus();
  }
}

function refreshTrayAgentStatus(): void {
  try {
    trayManager.setAgentStatus(getAgentHostStatus());
    lastAgentStatusRefreshError = null;
  } catch (err) {
    // 配置损坏等异常不能影响执行器心跳或托盘主链；2 秒轮询也不能
    // 把同一错误反复刷进日志。
    const message = err instanceof Error ? err.message : String(err);
    if (message !== lastAgentStatusRefreshError) {
      log.warn(`[agent-host] status refresh failed: ${message}`);
      lastAgentStatusRefreshError = message;
    }
  }
}

/** IPC 面：Agent 托管的当前状态（设置页 Agent 组的状态行读它）。 */
export function getAgentHostStatus(): AgentStatusSnapshot {
  const cfg = configStore.getAll();
  return {
    enabled: cfg.agentEnabled === true,
    polling: agentTimer !== null,
    ...(agentHost?.stats ?? { working: false, lastAssignmentId: null, lastOutcome: null, processed: 0, lastEffectiveProfile: null }),
  };
}
