/**
 * R12（2026-11-05）：**按 key 串行化**的异步执行器（零依赖）。
 *
 * ## 为什么需要它（真机实证的缺陷）
 *
 * `issueToken` 的幂等复用建立在**进程内缓存**上：先 `issuedTokenCache.get(key)`（同步读），
 * 未命中才 `rotateToken()`（await）。并发请求因此**都能在写入前读到 miss** ⇒ 各自轮换：
 * 真机 4 并发 × 6 轮实测 **每轮都发生 4 次轮换**（`artifacts/autonomy/R12/token-race-before.log`），
 * 先返回的令牌**刚签发就被下一次轮换覆盖**（调用方拿到死令牌 ⇒ 401 ⇒ 再取 ⇒ 又一轮换）。
 *
 * ## 语义
 *
 * 同一个 key 上的 `run()` 调用**按到达顺序串行**；不同 key 之间互不影响（并发度不降）。
 * 失败**不阻塞**后续调用（前一个 reject 后，后一个照常执行）。
 *
 * ## 与分布式锁的区别（刻意）
 *
 * 本类只在**单进程内**生效。跨实例的幂等需要共享存储（Redis 明文缓存）或
 * 「只存哈希、无法回取明文」的设计变更 ⇒ 属 ADR 级决策，不在本轮范围
 * （边界写在 `artifacts/autonomy/R12/brief.md` §5 与 PLAYBOOK §7.11）。
 */
export class KeyedSerializer {
  /** key → 该 key 上「最后一个排队者」的 promise（链式续接，不保存历史）。 */
  private readonly chains = new Map<string, Promise<unknown>>();

  /** 当前在途/排队的 key 数（可观测；正常回落到 0）。 */
  get inFlightKeys(): number {
    return this.chains.size;
  }

  /**
   * 在 `key` 上串行执行 `fn`。
   *
   * 实现要点：把「上一个排队者的 promise」当锁——新调用者的 `fn` 挂在上一个之后；
   * 前一个无论成功或失败都**不得阻塞**后续（故用 `then(ok, err)` 双分支而不是 `then(ok)`）。
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key);
    const start = prev ? prev.then(() => undefined, () => undefined) : Promise.resolve();
    const next = start.then(fn);
    this.chains.set(key, next);
    // 队列清空时移除键（否则长跑进程里 Map 会随身份数无限增长）。
    return next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    }) as Promise<T>;
  }
}

/**
 * R13（ADR-030 §7.2）：缓存命中却**复核失败**时的归因（纯判定，无 IO）。
 *
 * 跨实例双轮换有一个可观测症状：`issueToken` 读到**本进程**缓存条目，
 * 但它的明文已不能通过 `bcrypt.compare` 与库里的 `tokenHash` 对上，
 * 而该行的 `executorStartupId` **与缓存里记录的一致**（= 不是重启，是"别人把我的令牌换掉了"）。
 * 单实例内这只可能是管理台 `rotate-token`（那条路径会 `rememberIssuedToken` 回填新明文，
 * 所以正常也不会走到这）；**两实例部署**下它还会是"另一实例刚轮换过"。
 *
 * ⇒ 归因三态：
 *   · `"verified"`        —— 缓存的明文仍是库里的那个（可安全复用，调用方不会走到这里）；
 *   · `"stale-own-rotation"` —— 明文对不上且 startupId 变了 ⇒ 本进程/本机的正常轮换或重启痕迹；
 *   · `"foreign-rotation"`   —— 明文对不上但 startupId 未变 ⇒ **疑似另一实例轮换**（ADR-030 症状）。
 *
 * 服务层对第三态打 WARN（每身份每 TTL 去重），不改变行为——本轮的过渡措施只让缺陷**可见**。
 */
export type TokenCacheMissKind =
  | "verified"
  | "stale-own-rotation"
  | "foreign-rotation";

export function classifyTokenCacheMiss(input: {
  /** 缓存条目里记录的 startupId（可能是 null：legacy 无 startupId 的取法）。 */
  cachedStartupId: string | null;
  /** 本次请求带来的 startupId（已 trim / 空串归一为 null）。 */
  incomingStartupId: string | null;
  /** 行上当前的 executorStartupId（DB 事实）。 */
  rowStartupId: string | null;
  /** `bcrypt.compare(缓存明文, 库里的 tokenHash)` 的结果；库无 hash 时为 false。 */
  plaintextVerifies: boolean;
}): TokenCacheMissKind {
  if (input.plaintextVerifies) return "verified";
  // 同一进程生命（startupId 两侧一致，且行上的也没变）却没验过 ⇒ 不是我们这轮的轮换。
  const sameLife =
    input.cachedStartupId === input.incomingStartupId &&
    input.incomingStartupId !== null &&
    input.rowStartupId === input.incomingStartupId;
  return sameLife ? "foreign-rotation" : "stale-own-rotation";
}
