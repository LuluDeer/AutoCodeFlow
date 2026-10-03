/**
 * B-9（调度域审计）：params 体积上限的单一事实源。
 *
 * 背景：触发参数体积此前只有 webhook 面（TaskWebhookService）一道 64KB
 * 门——手动/API 触发（TriggerTaskDto）与任务默认 params（Create/Update
 * DTO）无上限，同一份 params 从不同入口进来受不同约束。
 *
 * 常量此前内联在 task.service.ts（FEAT-21 注入路径消费）；DTO 校验器
 * （params-size.constraint.ts）也要读它——DTO 被 task.service import，
 * 若 constraint 反向 import task.service 即成模块环，故抽到本零依赖 util，
 * task.service 保留 re-export 维持既有 import 面。
 */

/** params（默认参数 / 触发覆盖参数 / webhook 参数）统一字节上限：64KB */
export const TASK_PARAMS_MAX_BYTES = 65_536;

/**
 * params 序列化字节体积（utf8）。序列化失败（循环引用等）返回 null——
 * 调用方按「不可序列化 = 超限」处理。
 */
export function taskParamsByteSize(params: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(params) ?? "", "utf8");
  } catch {
    return null;
  }
}
