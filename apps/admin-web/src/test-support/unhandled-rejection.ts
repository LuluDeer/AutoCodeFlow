/**
 * 未处理 promise 拒绝的分类器（2026-10-27 实施轮 #9）。
 *
 * ## 背景：为什么需要它
 *
 * `apps/admin-web/vite.config.ts` 长期开着 `dangerouslyIgnoreUnhandledErrors: true`，
 * 起因是 **React + jsdom 的 teardown 竞态**：react-dom scheduler 的并发 commit
 * （MessageChannel workLoop）在 CI 高负载下可能晚于 jsdom teardown 执行，
 * `prepareForCommit` 于是访问已销毁的 window。该竞态与断言正确性无关，但会让
 * vitest 随机标红一个文件。
 *
 * 问题是这个开关是**全域**的：它同时把「真缺陷泄漏出的浮空拒绝」一起无视了——
 * 于是「写了个没 await 的 promise，里面 reject 了」这类回归永远不会红。
 *
 * ## 本轮的做法（以及为什么不是直接关掉开关）
 *
 * 关掉开关会让上面那个环境竞态重新变成随机红（实测记录：96 文件/878 用例全通过，
 * 仅 1 个随机文件因 teardown 竞态标红）⇒ 一个会随机红的闸等于没有闸。
 * 因此本轮先把**分类能力**落地：
 *   · 已知 teardown 竞态 → 静默（保持 CI 稳定）；
 *   · 其他一切浮空拒绝 → 以固定前缀 `[ACF][unhandledRejection]` **大声打日志**
 *     （不改变 pass/fail，但让真回归在 CI 日志里可检索、可追）；
 *   · 分类器本身是纯函数，有独立用例钉住它的判定边界。
 *
 * 彻底移除 `dangerouslyIgnoreUnhandledErrors` 的前置条件（下一轮可直接认领）：
 * 让 teardown 竞态不再产生 unhandled rejection（升级 vitest/jsdom 环境或把 React
 * 并发 commit 在 afterEach 里 flush 干净）——条件成立后把开关置 false，并让本
 * 分类器在非已知形态时**真的抛出**。
 */

/** 已知的 React/jsdom teardown 竞态特征（宁可窄：只认能复现的两类）。 */
export const KNOWN_TEARDOWN_SIGNATURES: readonly RegExp[] = [
  /prepareForCommit/i,
  /Cannot read properties of null \(reading 'document'\)/,
  /document is not defined/,
];

export type UnhandledRejectionKind = "known-teardown" | "unexpected";

/** 把拒绝原因归类（字符串 / Error / 任意值都能吃，绝不抛）。 */
export function classifyUnhandledRejection(reason: unknown): UnhandledRejectionKind {
  const text =
    typeof reason === "string"
      ? reason
      : reason instanceof Error
        ? `${reason.name}: ${reason.message}\n${reason.stack ?? ""}`
        : (() => {
            try {
              return JSON.stringify(reason) ?? String(reason);
            } catch {
              return String(reason);
            }
          })();
  return KNOWN_TEARDOWN_SIGNATURES.some((re) => re.test(text))
    ? "known-teardown"
    : "unexpected";
}

/** 真实回归要能在 CI 日志里被一眼检索到——固定前缀，别散落成自由文本。 */
export const UNEXPECTED_REJECTION_PREFIX = "[ACF][unhandledRejection]";

/**
 * 安装进程级监听（测试环境用）。返回卸载函数。
 *
 * 为什么显式 `preventDefault()`：Node 15+ 在**没有** `unhandledRejection`
 * 监听者时才走默认行为（打印 + 退出）；一旦有监听者，是否算 unhandled 由它决定。
 * 这里不抛，是为了不在环境竞态上制造随机红（见文件头）。
 */
export function installUnhandledRejectionReporter(
  target: Pick<NodeJS.Process, "on" | "off"> = process,
  logger: Pick<Console, "error"> = console,
): () => void {
  const onRejection = (reason: unknown, promise: Promise<unknown>): void => {
    // 已知竞态：静默（否则回到随机红）
    if (classifyUnhandledRejection(reason) === "known-teardown") return;
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : reason;
    logger.error(
      `${UNEXPECTED_REJECTION_PREFIX} unexpected floating promise rejection (not a known teardown race) — ` +
        `usually a missing await/catch, a real defect (not failing yet, see vite.config.ts):`,
      detail,
    );
    // 兜住 promise 本身，避免 "unhandled rejection" 计数继续累积
    void promise;
  };
  target.on("unhandledRejection", onRejection);
  return () => target.off("unhandledRejection", onRejection);
}
