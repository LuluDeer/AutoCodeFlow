/**
 * 与 admin-api 共享的**字符串契约**常量（跨端手工同步）。
 *
 * 为什么手抄而不从后端包导入：`apps/admin-api` 与 `apps/admin-web` 是两个独立
 * 包（web 只通过 HTTP 契约认识后端，没有 TS 工程引用）。既有先例同样是"显式
 * 注明来源行、后端改了请同步"（见 ApplicationListPage 的上传上限、
 * executorLiveness 的判死阈值）。
 *
 * 本文件集中放这类常量，避免同一契约在多个页面各抄一份而漂移。
 */

/**
 * stop() 未能把停机信号送达执行器时，statusMessage 的前缀。
 *
 * 来源：`apps/admin-api/src/modules/application/app-deployment.service.ts`
 * 的 `STOP_NOT_DELIVERED_PREFIX`（同名同值）。**改一处必须改两处。**
 *
 * 语义：后端 stop() 是 best-effort——执行器离线时行仍转 STOPPED（停机意图已
 * 表达），但信号没送到，设备上的进程可能还在跑。前端必须据此用 warning 而不是
 * success 提示，否则用户以为停干净了（本次报障主线「界面说的和实际不一致」）。
 */
export const STOP_NOT_DELIVERED_PREFIX = '[Stop not delivered] ';

/** 判断一条 statusMessage 是否表示「停机信号未送达」。 */
export function isStopNotDelivered(statusMessage?: string | null): boolean {
  return typeof statusMessage === 'string' && statusMessage.startsWith(STOP_NOT_DELIVERED_PREFIX);
}
