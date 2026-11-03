/**
 * PG 唯一约束冲突的**唯一判据**（T2-B4 收尾收敛）。
 *
 * ## 由来：三份物理副本 ⇒ 一份
 *
 * 收尾前本仓有**三份**各自独立的「23505 判据 + 约束名读取」实现：
 *   ① `task.service.ts`（R6 + 技术债 A 组）
 *   ② `task/task-version.collaborator.ts`（T2-B4 第四刀随 `saveVersion` 搬入时
 *      **复制**了一份）
 *   ③ `agent/runtime/agent-session.service.ts`（更宽松的形态：只看 `code`）
 *
 * 副本的风险不是「重复」而是**各自漂移**：哪天有人只改其中一份，两个调用点
 * 对同一个错误的归因就不一致了——而且**测试不一定红**（两边各自都"对"）。
 * ⇒ 本文件是**唯一事实源**，三处调用点都改 import。
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
