/**
 * FEAT-22 方案 A v1（deploymentPolicy=strict）：部署约束排队的共享常量。
 *
 * 语义：任务关联应用存在「用户显式指定过设备」的部署行
 * （running/stopped/upgrading）时，候选集收窄为该集合；集合全部不可派发
 * （离线/满载/被 group/tags/解释器过滤）时 dispatch 抛本错误 → task.processor
 * 在分类链**最前面**识别该 token，把执行置为 WAITING 并正常结束 job——
 * 与 MutexWaitError 完全同策（execution-mutex.ts 头注的 ①②③ 逐条适用）：
 * worker 槽位立即释放、不烧 BullMQ 重试预算、失败分类/终态事件/通知全链路
 * 不触发（这不是失败，是调度等待）。唤醒复用 scheduler 既有 10s WAITING
 * sweep（wakeMutexQueuedExecutions 对全部 WAITING 无条件重试，不止互斥行）。
 *
 * 为什么是 WAITING 而非 FAILED+重试链：strict 语义下「设备集合暂不可用」是
 * 临时态（设备重启/满载/短暂离线），走重试链会烧光 maxRetry 后落 FAILED，
 * 把一个可自愈的排队问题误判成死（MUTEX-01 P3 审计对互斥离线路径的同一结论）。
 * 逃逸出口（约束的解除方式，失败消息中必须指引）：
 *   ① 删除该应用的部署行（DELETE /app-deployments/:id，仅终态行；running 行
 *      先 stop）——集合为空即约束消失，下一次派发回全机队；
 *   ② 全局 EXECUTOR_DEPLOYMENT_POLICY 切回 prefer（软偏好）；
 *   ③ 对单条执行 kill/cancel。
 *
 * 刻意不 import 任何实体/配置：本文件被 executor 与 task 两个互相引用的模块
 * 共享，保持零模块依赖（与 execution-mutex.ts 的纪律同款）。
 */

/** dispatch 抛出的部署约束阻塞错误消息前缀（processor 分类链据此识别）。 */
export const DEPLOYMENT_WAIT_TOKEN = "[deployment_wait]";

/** dispatch 抛出的部署约束等待错误。processor 捕获后把执行置为 WAITING。 */
export class DeploymentConstraintWaitError extends Error {
  constructor(message: string) {
    super(`${DEPLOYMENT_WAIT_TOKEN}${message}`);
    this.name = "DeploymentConstraintWaitError";
  }
}
