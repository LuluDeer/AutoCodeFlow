import { SetMetadata } from "@nestjs/common";

/**
 * A2（DEEP_REVIEW 0ef3bbe §七）：写面守卫声明化。
 *
 * 背景（评审结论 §1.2 第 2 条）：RBAC 的「收口战役」留下成建制缺口——批量删除
 * 恒 403（测试把缺陷固化成断言）、updateGlue/rollback/rollbackToVersion 三个
 * 代码/配置写面完全绕过归属守卫，任意登录用户可篡改他人任务的执行代码。根因是
 * **归属守卫在 service 内手工调用**，没有任何「缺省拒绝」机制，这类漂移还会再
 * 发生。
 *
 * 本装饰器不改变运行时行为（纯元数据），配合
 * `src/common/guards/__tests__/write-guard-coverage.spec.ts` 的**穷举扫描**把
 * 「这个写端点的授权形态是什么」从「逐点人肉记忆」变成「必须显式声明，否则 CI 红」：
 *
 *   每个写端点（POST/PUT/PATCH/DELETE）必须满足其一：
 *     ① 有非空 @Roles(...)（角色门控，最常见）；
 *     ② 有 @WriteGuard(resource, { scope })（声明非角色门控的授权形态）。
 *
 * scope 取值与约束：
 *   - 'ownership'     已登录 + 资源归属校验（service 内 assertOwner 等）。
 *                     不得是 @Public()。
 *   - 'authenticated' 已登录即可，无资源归属概念（如「创建属于我的任务」）。
 *                     不得是 @Public()。
 *   - 'token'         非 JWT 凭据（执行器共享令牌 / 执行回调令牌 / API Key）。
 *                     必须同时 @Public() 且给出 reason。
 *   - 'public'        完全开放（webhook 接收端、健康探针等）。
 *                     必须同时 @Public() 且给出 reason。
 *
 * 用法：
 *   @Post(":id/kill")
 *   @WriteGuard("execution", { scope: "ownership" })
 *   kill(@Param("id") id: string) { ... }
 *
 *   @Post("callback")
 *   @Public()
 *   @WriteGuard("execution-callback", {
 *     scope: "token",
 *     reason: "执行器持 per-execution HMAC 令牌回调，非用户会话面",
 *   })
 *   callback(@Body() dto: CallbackDto) { ... }
 */
export const WRITE_GUARD_KEY = "writeGuard";

export type WriteScope = "ownership" | "authenticated" | "token" | "public";

export interface WriteGuardMetadata {
  /** 受写的资源域（task / execution / application / deployment / user / ...）。 */
  resource: string;
  scope: WriteScope;
  /** scope='token' | 'public' 时必填：为什么这里可以不要求 JWT/角色。 */
  reason?: string;
}

/**
 * 声明一个写端点的授权形态。纯元数据（不注册守卫、不改行为）——真正的强制点
 * 是穷举扫描 spec：漏声明的新写端点会让 CI 变红。
 */
export const WriteGuard = (
  resource: string,
  meta: Omit<WriteGuardMetadata, "resource">,
): MethodDecorator =>
  SetMetadata(WRITE_GUARD_KEY, { resource, ...meta } as WriteGuardMetadata);
