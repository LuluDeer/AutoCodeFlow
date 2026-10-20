/**
 * R105（SEC-IPC-CONFIRM）：**破坏性 IPC 通道的主进程二次确认**。
 *
 * ## 为什么 UI 里的确认不够
 *
 * R86-A1 给 43 个 handler 加了 sender 白名单闸（只认我们自己页面的主 frame）。但 R102-A1 的结论是：
 * **渲染层内部的代码执行仍能过那道闸** —— 因为它就在主 frame 里。于是：
 *
 * > `apps:uninstall` / `apps:delete-release` / `updater:install` / `history:clear` 这些动作，
 * > 确认只做在 React 的 ConfirmBar 上；一段注入的脚本可以直接 `electronAPI.uninstallApp(id)`，**跳过确认**。
 *
 * **UI 的确认是给用户看的，不是给攻击者设的。** 主进程必须自己再问一次，而且要用渲染层碰不到的方式问 ——
 * 原生模态框（`dialog.showMessageBox`，modal 到发起窗口）。
 *
 * ## 设计纪律
 *
 * - 判定逻辑（哪些通道要确认、文案）放在**纯模块**里，不 import electron ⇒ selftest 可直接驱动；
 * - 「确认」由调用方注入（`ConfirmFn`），主进程传 `dialog.showMessageBox` 适配器，测试传假函数；
 * - **fail-closed**：确认函数抛错 / 返回非严格 true ⇒ 一律**不执行**（宁可用户多点一次，
 *   也不能让一次异常把删除动作放过去）；
 * - 取消时回 `{ ok: false, canceled: true }`（与既有 diagnostics:export 的取消形态一致，
 *   渲染层无需为「取消」写新分支）。
 */

/** 需要主进程二次确认的通道。**只放不可逆/外发型的动作**，可恢复的（executor:start/stop）不在此列。 */
export type DestructiveChannel =
  | 'apps:uninstall'
  | 'apps:delete-release'
  | 'updater:install'
  | 'history:clear';

export interface DestructivePolicy {
  /** 对话框标题里的一句话动作名（中文，与 UI 文案同源）。 */
  readonly label: string;
  /** 对话框正文里补充的后果说明。 */
  readonly detail: string;
}

export const DESTRUCTIVE_CHANNELS: Readonly<Record<DestructiveChannel, DestructivePolicy>> = {
  'apps:uninstall': {
    label: '卸载本地应用',
    detail: '会删除该应用的本地发布目录与运行配置，无法撤销。',
  },
  'apps:delete-release': {
    label: '删除发布版本',
    detail: '会从本地磁盘删除该版本的产物，无法撤销。',
  },
  'updater:install': {
    label: '立即安装更新',
    detail: '应用将退出并重启以完成安装，正在运行的任务会被中断。',
  },
  'history:clear': {
    label: '清空执行历史',
    detail: '会删除本机记录的历史执行条目，无法撤销。',
  },
};

/** 注入的确认函数：返回 true 才继续。 */
export type ConfirmFn = (policy: DestructivePolicy & { channel: DestructiveChannel }) => Promise<boolean>;

/**
 * 询问用户是否可以执行某个破坏性动作。**fail-closed**：
 * 未登记的通道、确认函数缺失/抛错、返回非严格 true —— 一律 false。
 */
export async function confirmDestructive(
  channel: DestructiveChannel,
  confirm?: ConfirmFn | null,
): Promise<boolean> {
  const policy = DESTRUCTIVE_CHANNELS[channel];
  if (!policy) return false;
  if (typeof confirm !== 'function') return false;
  try {
    const answer = await confirm({ channel, ...policy });
    return answer === true;
  } catch {
    return false;
  }
}

/** 确认被取消时统一的回执（与 diagnostics:export 的 canceled 形态一致）。 */
export const CONFIRM_CANCELED = Object.freeze({ ok: false as const, canceled: true as const });
