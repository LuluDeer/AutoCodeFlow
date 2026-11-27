/**
 * 阶段 A（ADR-044）：工作台专用 `workbench:*` channel 注册段。
 *
 * 刻意独立成文件而不是塞进 ipc-handlers.ts：后者在 source-size-baseline 里是
 * **只减不增的棘轮文件**（nonCommentLines 1238 / exports 6），新增注册段会把
 * size-caps 守卫变红。这里不触碰任何既有 handler，接线只在 index.ts 加一行调用。
 *
 * 两道隔离保险：
 *  1. createGuardedIpcMain 的 sender URL 闸——策略锚点是**配置的中台地址**
 *     （不是四页的 renderer file:/dev-server），因此四页 renderer 发来的
 *     workbench:* 一律被拒；
 *  2. handler 层的 isWorkbenchSender()——再按 webContents.id + 独立 partition
 *     收窄到本模块创建的那个窗口。
 *
 * 反方向同样成立：工作台窗口发执行器配置 / 子进程 / 卸载 / 更新 channel 时，
 * 既有 handler 的 sender 策略（renderer file:/dev-server）直接拒绝；而且工作台
 * 的独立 preload 根本没 expose 那些 channel。
 */
import { ipcMain as electronIpcMain } from 'electron';
import { createGuardedIpcMain } from './ipc-sender-guard';
import {
  getWorkbenchWindow,
  isWorkbenchSender,
  resolveWorkbenchNavigation,
  resolveWorkbenchUrl,
  WORKBENCH_CHANNELS,
  type WorkbenchLog,
} from './workbench-window';

export interface WorkbenchIpcDeps {
  /** 运行期读取配置里的中台地址（通常是 `() => configStore.get('adminApiUrl')`）。 */
  getAdminApiUrl: () => unknown;
  log: WorkbenchLog;
}

export function registerWorkbenchIpcHandlers(deps: WorkbenchIpcDeps): void {
  const workbenchIpc = createGuardedIpcMain(electronIpcMain, {
    // 每次调用重新读配置：未配置 / 非法地址时返回空策略 → fail-closed。
    policy: () => {
      try {
        return { devServerUrl: resolveWorkbenchUrl(deps.getAdminApiUrl()) };
      } catch {
        return {};
      }
    },
    log: deps.log,
  });

  workbenchIpc.handle(WORKBENCH_CHANNELS.getUrl, (event) => {
    if (!isWorkbenchSender(event.sender)) throw new Error('workbench:getUrl: sender not allowed');
    return resolveWorkbenchUrl(deps.getAdminApiUrl());
  });

  workbenchIpc.handle(WORKBENCH_CHANNELS.navigate, (event, target: unknown) => {
    if (!isWorkbenchSender(event.sender)) throw new Error('workbench:navigate: sender not allowed');
    const base = resolveWorkbenchUrl(deps.getAdminApiUrl());
    const nextUrl = resolveWorkbenchNavigation(target, base);
    const win = getWorkbenchWindow();
    if (!win || win.isDestroyed() || win.webContents.id !== event.sender.id) {
      throw new Error('workbench:navigate: sender is not the workbench window');
    }
    void win.loadURL(nextUrl);
    return { ok: true, url: nextUrl };
  });

  workbenchIpc.handle(WORKBENCH_CHANNELS.close, (event) => {
    if (!isWorkbenchSender(event.sender)) throw new Error('workbench:close: sender not allowed');
    getWorkbenchWindow()?.close();
    return { ok: true };
  });
}
