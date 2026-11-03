/**
 * PG 唯一约束冲突的**唯一判据**（T2-B4 收尾收敛 / R5 相 2）。
 *
 * ## ⚠️ 本文件在 `common/utils/` ⇒ fan-in 是全仓最高
 *
 * 放这里是因为它要被**多个业务模块**共用（task / executor-package / users）
 * ——留在 `modules/task/` 会让 executor/users 反向依赖 task 业务模块。
 * ⇒ **代价**：本文件只做**一件事**（判定 23505 + 取约束名）。
 * **不要**顺手往这里加「通用错误归一」「错误码映射」之类的能力——
 * 那会让一个内核 util 变成什么都干的垃圾桶（fan-in 越高越危险）。
 *
 * ## 由来：多份物理副本 ⇒ 一份（**但不是全部**）
 *
 * 收尾前本仓有多份各自独立的「23505 判据 + 约束名读取」实现。副本的风险
 * 不是「重复」而是**各自漂移**：哪天有人只改其中一份，两个调用点对同一个错误
 * 的归因就不一致了——而且**测试不一定红**（两边各自都"对"）。
 *
 * ⇒ **已收敛到本文件**（R5 相 2 批准范围）：
 *   ① `task.service.ts`（R6 + 技术债 A 组）
 *   ② `task/task-version.collaborator.ts`（B4 第四刀搬 `saveVersion` 时复制的）
 *   ③ `executor-package/executor-package.service.ts`（逐字等价）
 *   ④ `users/users.service.ts`（逐字等价；**刻意保留**它"不做错误消息匹配"的
 *      意图 —— 防 PG 文案/版本漂移 ⇒ 本文件也**不做** message 匹配）
 *
 * ## ⚠️ **刻意保持独立**的副本（**不得**收敛）
 *
 * 收敛重复逻辑时，判据的「更宽松/更严格」**不是风格差异，是语义差异**：
 * **注释里有「不许误报 / 只认 X」这类显式契约的 ⇒ 刻意严格，收敛 = 违背契约。**
 *
 *   · `application/app-deployment.service.ts:2016` `isUniqueViolationWithConstraint`
 *     —— **只认指定约束名**（遍历 err/driverError/cause）。作者原话：
 *     「any other unique violation **must not be misreported**」。放宽 ⇒ 别的
 *     唯一约束冲突被谎报成「在途部署冲突 / 灰度批次已被抢」⇒ **静默吞掉不该吞的冲突**。
 *   · `project/projects.service.ts:255` `isUniqueViolationOn` —— **只认
 *     `UQ_projects_name`**。作者原话：「为什么不用一刀切……比笼统的『资源已存在』
 *     **更误导**」。
 *   · `application/mutex-group.service.ts:23` —— 多一层 `instanceof
 *     QueryFailedError`；**且它目前没有专属 23505 spec** ⇒ **没有回归网的地方不动**
 *     （改了也不知道好坏）。
 *   · `executor/executor.service.ts:467` —— 刻意保留 `instanceof` 收紧
 *     （已是宽松版，收敛会去掉这层类型收紧 ⇒ **收益 0、风险 > 0**）。
 *     **勿当作遗漏收敛。**
 *   · `agent/runtime/agent-session.service.ts` / `agent-approvals.service.ts`
 *     —— agent 域的 23505 用于**重试**判据；放宽 ⇒ 更多错误被当「可重试的冲突」
 *     ⇒ 可能无限重试 ⇒ 影响面与别处不同，**单独评估**（不在相 2 范围）。
 *
 * ## 语义（**刻意是三者中最宽松的**）
 *
 * · **是否 23505**：看 `code`；`code` 缺失时**回落到 `driverError.code`**
 *   （TypeORM 的 `QueryFailedError` 把驱动错误的属性拷到自身，但不同驱动/版本
 *   的挂载位置不同 ⇒ 两处都看）。
 * · **约束名**：同样**顶层优先、`driverError` 兜底**；缺失时返回 `null`
 *   （调用方据此回落笼统的 409——宁可文案笼统，不可把错误归因到错的字段）。
 *
 * ⚠️ **兼容性**：既有 task 域 spec（`task.service.spec.ts:1278` / `:6369` 等）把
 * `constraint` 直接挂在错误**顶层** ⇒ 顶层优先的读法**逐字兼容**；
 * `projects.service.ts` 的 `isUniqueViolationOn`（同时看两处）也**兼容**。
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: unknown;
    driverError?: { code?: unknown } | null;
  };
  const code = e.code ?? e.driverError?.code;
  return code === "23505";
}

/**
 * 从 23505 错误提取命中的**约束名**。
 *
 * TypeORM 的 `QueryFailedError` 会把驱动错误的自有属性拷贝到自身
 * （`QueryFailedError.js` 里 `ObjectUtils.assign(this, otherProperties)`），
 * pg 驱动错误自带 `constraint` 字段——据此区分「撞主键」与「撞业务唯一索引」，
 * 给并发窗口下的写面冲突配上可读的 409 文案（而非笼统的 conflict）。
 *
 * @returns 约束名；非 23505 / 约束名缺失 ⇒ `null`
 */
export function uniqueConstraintName(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    constraint?: unknown;
    driverError?: { constraint?: unknown } | null;
  };
  const constraint = e.constraint ?? e.driverError?.constraint;
  return typeof constraint === "string" ? constraint : null;
}
