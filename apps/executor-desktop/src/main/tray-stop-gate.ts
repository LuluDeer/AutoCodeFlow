import type { ExecutorStatus } from './executor-process';

/**
 * P1-TRAY-STOP：托盘停止的纯闸门。
 *
 * 判据只认执行器 active（online/pending），刻意不读 running-count.ts 的
 * readdir 结果：扫描失败回落 0 会把「未知」谎报成「无任务」，与状态页
 * stopActionGate 的 unknown/running 先确认口径相反。active 即需二次确认；
 * inactive 直接停；confirmed 显式给出时按用户结果放行/撤回；inFlight 命中
 * 时整次点击忽略（在飞互斥，二次确认期间重复点击同样不落 stop）。
 *
 * 无 electron / fs 依赖，裸 Node selftest 可直接驱动。
 */
export type TrayStopGateDecision = 'ignore' | 'confirm' | 'stop' | 'cancel';

export interface TrayStopGateOptions {
  inFlight?: boolean;
  confirmed?: boolean;
}

/** 托盘菜单与闸门共用的 active 口径（与 rebuildMenu 的启用条件同源）。 */
export function isTrayStopActive(status: ExecutorStatus): boolean {
  return status === 'online' || status === 'pending';
}

export function trayStopGate(
  status: ExecutorStatus,
  options: TrayStopGateOptions = {},
): TrayStopGateDecision {
  if (typeof options.confirmed === 'boolean') {
    return options.confirmed ? 'stop' : 'cancel';
  }
  if (options.inFlight) return 'ignore';
  return isTrayStopActive(status) ? 'confirm' : 'stop';
}
