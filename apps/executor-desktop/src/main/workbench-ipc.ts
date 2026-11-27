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
  isWorkbenchSender,
  resolveWorkbenchUrl,
  WORKBENCH_CHANNELS,
  type WorkbenchLog,
} from './workbench-window';
import type { WorkbenchPickedFile } from './workbench-window-helpers';
import type { AgentLiveEvent } from './agent/agent-events';

export interface WorkbenchIpcDeps {
  /** 运行期读取配置里的中台地址（通常是 `() => configStore.get('adminApiUrl')`）。 */
  getAdminApiUrl: () => unknown;
  log: WorkbenchLog;
  /** 只读的桌面上下文（不含凭据/令牌/workDir 绝对路径）。 */
  getDesktopContext?: () => Record<string, unknown>;
  /** 取消 Agent 当前指派；返回是否确实取消了运行中的单。 */
  cancelAgentAssignment?: (assignmentId?: string) => boolean;
  /** 打开系统文件选择器并投影成安全载荷（绝不返回路径）。 */
  pickLocalFiles?: () => Promise<WorkbenchPickedFile[]>;
  /** 最近一次 Agent 实时事件（工作台打开时补历史）。 */
  getRecentAgentEvents?: () => AgentLiveEvent[];
  /** 工作台初始主题（系统 / 显式设置）。 */
  getTheme?: () => import('./theme-bridge').ResolvedTheme;
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

  workbenchIpc.handle(WORKBENCH_CHANNELS.getDesktopContext, (event) => {
    if (!isWorkbenchSender(event.sender) || !isWorkbenchMainFrame(event)) {
      throw new Error('workbench:getDesktopContext: sender not allowed');
    }
    const get = requireDeps(deps.getDesktopContext, 'workbench:getDesktopContext');
    return get();
  });

  workbenchIpc.handle(WORKBENCH_CHANNELS.cancelAgentAssignment, (event, assignmentId: unknown) => {
    if (!isWorkbenchSender(event.sender) || !isWorkbenchMainFrame(event)) {
      throw new Error('workbench:cancelAgentAssignment: sender not allowed');
    }
    const cancel = requireDeps(deps.cancelAgentAssignment, 'workbench:cancelAgentAssignment');
    if (assignmentId !== undefined && (typeof assignmentId !== 'string' || assignmentId.length === 0)) {
      throw new Error('workbench:cancelAgentAssignment: invalid assignmentId');
    }
    return { ok: cancel(assignmentId as string | undefined) };
  });

  workbenchIpc.handle(WORKBENCH_CHANNELS.pickLocalFiles, async (event) => {
    if (!isWorkbenchSender(event.sender) || !isWorkbenchMainFrame(event)) {
      throw new Error('workbench:pickLocalFiles: sender not allowed');
    }
    const pick = requireDeps(deps.pickLocalFiles, 'workbench:pickLocalFiles');
    return pick();
  });

  workbenchIpc.handle(WORKBENCH_CHANNELS.getRecentAgentEvents, (event) => {
    if (!isWorkbenchSender(event.sender) || !isWorkbenchMainFrame(event)) {
      throw new Error('workbench:getRecentAgentEvents: sender not allowed');
    }
    const get = requireDeps(deps.getRecentAgentEvents, 'workbench:getRecentAgentEvents');
    return get();
  });
}

/**
 * 依赖缺失/未注入的 handler 一律 fail-closed（抛错），绝不用空值伪造成功。
 */
function requireDeps<T>(value: T | undefined, channel: string): T {
  if (value === undefined) throw new Error(`${channel}: unavailable`);
  return value;
}

/** 快速路径：工作台页面确为本窗口主 frame（子 frame 无 IPC 权限）。 */
function isWorkbenchMainFrame(event: { senderFrame?: { parent?: unknown } | null }): boolean {
  return !event.senderFrame?.parent;
}
