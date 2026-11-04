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
