// A4（第三轮审计·高）：派发体 task 字段白名单。
//
// 此前派发载荷的 `task` 是**整实体直传**（`{ ...task }` / `{ ...task, packageUrl }`），
// 任务行的全部列（含密文 secrets——虽靠 select:false 侥幸不出现，但那是列声明
// 的偶然而非派发面的必然，还叠加了 ownerUserId/deploymentPolicy/alarmEmail 等
// 与执行无关的内部面）一并序列化进 HTTP 载荷与 Redis pull 队列。本文件把
// 「执行器拿到的 task」收口为显式白名单。
//
// 白名单推导（协议声明 ∪ 三端实际读取，再∩实体字段集）：
// 1. protocol.json schemas.TaskConfig 已声明字段（packages/executor-protocol/
//    protocol.json）——camelCase 正名 + snake_case 别名（别名是执行器侧历史
//    兼容入口，admin 实体上不存在对应列，天然不会出现在载荷里）；
// 2. 三端执行器对派发 task 的实际读取面（源码逐一核对）：
//    - executor-node routes/execute.ts（body.task.*）与 dispatchExecutionToWorker
//      的 placeholder 展开、env 注入（TASK_ID/TASK_NAME）；
//    - executor-python routers/execute.py（task.get(...)，含 snake_case 回退）；
//    - executor-desktop 内嵌 executor-node ncc bundle（见
//      apps/executor-desktop/executor-node-bundle.sha256），读取面与 node 一致；
// 3. `packageUrl` 由 admin 在派发时解析注入（任务实体无此列，见
//    ExecutorService.resolveDispatchTask 头注）。
//
// 并集再交上「实体实际拥有的列」后收敛为以下 14 个字段——缺任何一个都会让
// 对应渠道在执行器侧失效（gitRepo/gitBranch/gitCommit=git 渠道、glueSource/
// glueLanguage=glue 渠道、codeSource/applicationId/packageUrl=zip 渠道、
// runtime/runtimeVersion/entrypoint/timeout/requirements/name/id=通用面）。
// 刻意不在名单内（示例）：secrets/webhookSecret（凭据，另有专用载荷字段或
// 根本不该下发）、params（独立载荷字段）、ownerUserId/alarmEmail/
// alarmChannels/executorAppName/deploymentPolicy/executorId/executorGroup/
// executorTags/executorAffinityTags/executorAntiAffinityTags/blockStrategy/
// misfireStrategy/maxRetry/retryDelay/retryableErrors/priority（调度面或
// admin 内部语义，执行器从不读取）、createdAt/updatedAt/deletedAt/版本列。
import { Task } from "../task/entities/task.entity";

/** 派发体 task 的字段白名单（全部为 Task 实体列；packageUrl 除外——派发时解析注入）。 */
export const DISPATCH_TASK_FIELD_WHITELIST = [
  "id",
  "name",
  "runtime",
  "runtimeVersion",
  "entrypoint",
  "timeout",
  "requirements",
  "gitRepo",
  "gitBranch",
  "gitCommit",
  "glueSource",
  "glueLanguage",
  "codeSource",
  "applicationId",
] as const;

export type DispatchTaskField = (typeof DISPATCH_TASK_FIELD_WHITELIST)[number];

/** 派发体 task 的形状：白名单列原值 + 可选的解析态 packageUrl（仅 zip 渠道）。 */
export type DispatchTaskPayload = Pick<Task, DispatchTaskField> & {
  packageUrl?: string;
};

/**
 * 从任务实体挑选白名单字段构造派发体。语义与旧 `{ ...task }` 逐字段对齐：
 * - 白名单列**恒出现**（值为 undefined/null 也保留键位——TypeORM 查回的实体
 *   本就全列存在；`requirements` 的字面 null 是协议 TaskConfig 明文要求接受
 *   的形态，见 protocol.json requirements.description）；
 * - `packageUrl` 仅在显式传入时存在（非 zip 渠道不带该键，与旧行为一致）；
 * - 绝不读写入参实体——纯挑选，零副作用。
 */
export function buildDispatchTaskPayload(
  task: Task,
  packageUrl?: string | null,
): DispatchTaskPayload {
  // 逐字段复制经 Record 中转：TS 对「union 键位逐个赋值」的窄化不友好
  // （payload[field] 直写被判 never），而这里的字段集与值域由白名单常量静态
  // 保证，收口处一次 as 是安全的。
  const payload: Record<string, unknown> = {};
  for (const field of DISPATCH_TASK_FIELD_WHITELIST) {
    payload[field] = task[field];
  }
  if (typeof packageUrl === "string" && packageUrl.length > 0) {
    payload.packageUrl = packageUrl;
  }
  return payload as DispatchTaskPayload;
}

/**
 * 技术债 A 组（2026-10-01）·按原版本重放：把任务版本快照覆盖到派发用的
 * task 形体上（不改库内任务行）。
 *
 * 语义对齐 rollbackToVersion 的既有解析（Object.assign(task, snapshot) 后走
 * 正常派发链），但**只覆盖派发体白名单内的执行相关字段**，且仅当快照确有
 * 该键（旧快照缺键保留现值，与 rollback 的 Object.assign 缺键语义一致）：
 * - codeSource / gitRepo / gitBranch / gitCommit / glueSource / glueLanguage /
 *   entrypoint / runtimeVersion / requirements / applicationId —— 三条代码
 *   渠道（git / glue / zip）的解释字段；packageUrl 无快照键，仍由派发链按
 *   覆盖后的 applicationId 解析（resolveDispatchTask 不变）；
 * - id / name / runtime / timeout 也在快照与白名单交集内：id 恒同值，
 *   name/runtime/timeout 属执行体形态——钉定重放跑的就是那一版的样子。
 *
 * 刻意**不**覆盖（调度面，跟随任务当前配置）：executorId/executorAppName/
 * executorGroup/executorTags/affinity/deploymentPolicy 等不在派发体白名单内；
 * params/secrets 亦由派发链从执行行与现任务取，快照不含 secrets（见
 * saveVersion 快照键注释）。
 *
 * 纯函数：绝不读改入参实体，返回浅拷贝（processor 以覆盖后的副本传给
 * dispatch，库内任务行零影响）。
 */
export function applyPinnedVersionSnapshot(
  task: Task,
  snapshot: Record<string, unknown>,
): Task {
  const overlaid: Record<string, unknown> = { ...task };
  for (const field of DISPATCH_TASK_FIELD_WHITELIST) {
    if (field in snapshot) {
      overlaid[field] = snapshot[field];
    }
  }
  // 同 buildDispatchTaskPayload：字段集由白名单常量静态保证，收口处一次
  // 经 unknown 的 as 是安全的（与既有注释同一理由）。
  return overlaid as unknown as Task;
}
