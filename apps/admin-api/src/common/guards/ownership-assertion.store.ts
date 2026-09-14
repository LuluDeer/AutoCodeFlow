import { AsyncLocalStorage } from "async_hooks";

/**
 * A2-B（DEEP_REVIEW 0ef3bbe §七）：属主断言的**运行时证据**通道。
 *
 * 背景：A2 只把「这个写端点的授权形态是什么」做成了**声明**（`@WriteGuard`），
 * 漏声明会让 CI 红，但**声明了 `ownership` 却没人真的去校验**照样红不了——
 * service 里忘了调 `assertCanWrite`，声明依旧是 `ownership`，评审 §1.2 指出
 * 的成建制缺口（updateGlue/rollback 绕过归属守卫）会以同样的形态再次发生。
 *
 * 本模块补上「证据」那一半：真正的属主校验函数在执行时**落一条证据**到当前
 * 请求作用域（AsyncLocalStorage），`WriteGuardEnforcementInterceptor` 在
 * 端点成功返回前核对「声明的 scope 是否有对应证据」。没有证据 = 没有校验 =
 * 直接失败（缺省拒绝），而不是静默放行。
 *
 * 为什么用 ALS 而不是挂在 req 上：落证据的是 service 层深调用
 * （`task.service.assertCanWrite` / `application.service.assertCanWrite` /
 * `event-subscription.service.assertCanManage`），它们拿不到 req 对象；ALS
 * 是唯一不需要把 request 一路透传下去的通道（仓库内 `TraceService` 同款做法）。
 *
 * 作用域外（如定时任务、进程启动逻辑）调用落证据函数是**静默 no-op**——
 * 守卫只约束 HTTP 请求面，不约束后台任务。
 */

/**
 * 断言种类：
 * - 'write'   属主/项目 editor 级写校验（`assertCanWrite` /
 *             `assertCanWriteProjectAware` / `assertCanManage`）。
 * - 'operate' 执行类写面的项目角色校验（`assertCanOperate`）——只显式拒绝
 *             viewer，**不是**属主校验，故与 'write' 分开记（见 ADR-013：
 *             「任何登录用户可 trigger」的宽松语义待产品拍板后才收紧）。
 */
export type OwnershipAssertionKind = "write" | "operate";

interface OwnershipScope {
  /** 元素形如 `${resource}:${kind}`。 */
  seen: Set<string>;
}

const storage = new AsyncLocalStorage<OwnershipScope>();

const key = (resource: string, kind: OwnershipAssertionKind): string =>
  `${resource}:${kind}`;

/**
 * 在当前异步上下文中开启一个属主证据作用域并返回 `fn` 的结果。
 *
 * 注意：调用方必须**在回调内订阅**上游 Observable（而不是只创建它），
 * 否则 handler 的实际执行会落在作用域之外，证据丢失、守卫误判。
 */
export function runOwnershipScope<T>(fn: () => T): T {
  return storage.run({ seen: new Set<string>() }, fn);
}

/**
 * 落一条「本请求对 `resource` 真的做了 `kind` 校验」的证据。
 * 在 HTTP 请求作用域之外调用为 no-op。
 */
export function recordOwnershipAssertion(
  resource: string,
  kind: OwnershipAssertionKind = "write",
): void {
  storage.getStore()?.seen.add(key(resource, kind));
}

/** 本请求是否已对 `resource` 做过 `kind` 校验。 */
export function hasOwnershipAssertion(
  resource: string,
  kind: OwnershipAssertionKind = "write",
): boolean {
  return storage.getStore()?.seen.has(key(resource, kind)) ?? false;
}

/** 当前作用域内已落的全部证据（测试/诊断用），稳定排序。 */
export function snapshotOwnershipAssertions(): string[] {
  return Array.from(storage.getStore()?.seen ?? []).sort();
}

/** 当前是否处于受守卫的请求作用域内（用于区分「没校验」与「不在请求里」）。 */
export function isInsideOwnershipScope(): boolean {
  return storage.getStore() !== undefined;
}
