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
 * 本装饰器本身不改变运行时行为（纯元数据），真正的强制分两层：
 *   ① `src/common/guards/__tests__/write-guard-coverage.spec.ts` 的**穷举扫描**
 *      把「这个写端点的授权形态是什么」从「逐点人肉记忆」变成「必须显式声明，
 *      否则 CI 红」；
 *   ② A2-B 的 `WriteGuardEnforcementInterceptor` 对 ownership / project-role
 *      两种 scope 做**运行时强制**：拿不出对应断言证据就直接 500（缺省拒绝）。
 *
 *   每个写端点（POST/PUT/PATCH/DELETE）必须满足其一：
 *     ① 有非空 @Roles(...)（角色门控，最常见）；
 *     ② 有 @WriteGuard(resource, { scope })（声明非角色门控的授权形态）。
 *
 * scope 取值与约束：
 *   - 'ownership'     已登录 + 资源归属校验（service 内 assertCanWrite /
 *                     assertCanWriteProjectAware / assertCanManage 等）。
 *                     不得是 @Public()。
 *   - 'project-role'  已登录 + **项目角色**校验（service 内 assertCanOperate）。
 *                     语义弱于 ownership：目前只显式拒绝项目 viewer，不校验
 *                     属主（ADR-013 已知缺口：「任何登录用户可 trigger」的宽松
 *                     语义待产品拍板后才收紧）。声明它必须如实——它是「这里没有
 *                     属主校验」的显式登记，不是 ownership 的同义词。
 *                     不得是 @Public()。
 *   - 'authenticated' 已登录即可，无资源归属概念（如「创建属于我的任务」）。
 *                     不得是 @Public()。
 *   - 'token'         非 JWT 凭据（执行器共享令牌 / 执行回调令牌 / API Key）。
 *                     必须同时 @Public() 且给出 reason。
 *   - 'public'        完全开放（webhook 接收端、健康探针等）。
 *                     必须同时 @Public() 且给出 reason。
 *
 * A2-B：ownership / project-role 两种 scope 由
 * `WriteGuardEnforcementInterceptor` **运行时强制**——端点成功返回前若拿不出
 * 对应种类的断言证据（见 ownership-assertion.store.ts）直接 500，因此「声明了
 * 属主校验但 service 里忘了调」不再可能静默通过。
 *
 * 用法：
 *   @Patch(":id")
 *   @WriteGuard("task", { scope: "ownership" })
 *   update(@Param("id") id: string, @Body() dto: UpdateTaskDto) { ... }
 *
 *   @Post(":id/trigger")
 *   @WriteGuard("task", { scope: "project-role" })
 *   trigger(@Param("id") id: string) { ... }
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

export type WriteScope =
  "ownership" | "project-role" | "authenticated" | "token" | "public";

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
