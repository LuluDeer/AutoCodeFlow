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
 *   · 其他一切浮空拒绝 → 固定前缀 `[ACF][unhandledRejection]` 打日志，
 *     **并让当前 test 失败**（R98-B1，见下）；
 *   · 分类器本身是纯函数，有独立用例钉住它的判定边界。
 *
 * ## R98（B1）：从「只打印」升级为「让 test 红」
 *
 * 为什么升：R92 实测证明「只打印」= 纪律形同虚设 —— `dangerouslyIgnoreUnhandledErrors`
 * 加上「已注册 process.on 监听器」两层吸收后，**任何**浮空拒绝都不会让门禁红
 * （连 `void Promise.reject(...)` 都 exit 0）。于是新代码漏一个 `.catch` 没人会知道。
 *
 * 怎么做：本模块把「真实 process 上收到的、非已知竞态的」拒绝攒进
 * `pendingUnexpected`；`test-setup.ts` 的 `afterEach` 取出并以抛错形式让它
 * **归到当前用例**（test 级失败）。teardown 竞态仍由分类器豁免，避免回到
 * 2026-09-18 那次「96 文件全过却随机标红」。
 *
 * 归属规则（刻意）：**只有 `target === process` 才计入**。自检用例会传入
 * fake EventEmitter target 来验证日志形态 —— 那些是装置的产物、不是被测代码的
 * 缺陷，若也计入就会把自检本身判红（R95 的实验版正是踩了这个坑）。
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
 * R98：**待判**的浮空拒绝（仅真实 process 来源）。
 *
 * 由 `test-setup.ts` 的 `afterEach` 取出并抛错 ⇒ 归到当前用例。
 * 取「攒 + 每用例清空」而不是「立刻抛」：unhandledRejection 在 Node 里是
 * **微任务检查点**才派发，可能晚于用例体结束；让 afterEach 统一收割才能稳定归属。
 */
const pendingUnexpected: unknown[] = [];

/** 取出并清空待判列表（`test-setup.ts` 每用例末尾调用）。 */
export function drainUnexpectedRejections(): unknown[] {
  return pendingUnexpected.splice(0, pendingUnexpected.length);
}

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
  // R98：只有真实 process 的拒绝才计入「让 test 红」；自检用例传 fake target
  // （EventEmitter）验证日志形态，那些不计入（否则自检自己被判红）。
  const countedAsFailure = target === process;
  const onRejection = (reason: unknown, promise: Promise<unknown>): void => {
    // 已知竞态：静默（否则回到随机红）
    if (classifyUnhandledRejection(reason) === "known-teardown") return;
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : reason;
    logger.error(
      `${UNEXPECTED_REJECTION_PREFIX} unexpected floating promise rejection (not a known teardown race) — ` +
        `usually a missing await/catch, a real defect (not failing yet, see vite.config.ts):`,
      detail,
    );
    // R98：攒起来交给 afterEach ⇒ 该 test 失败（B1）。日志仍照打，便于 grep。
    if (countedAsFailure) pendingUnexpected.push(reason);
    // 已注册监听器 ⇒ Node 不再走「打印+退出」的默认行为；这里不断言 promise，
    // 仅避免未使用参数（真正的判定在 afterEach）。
    void promise;
  };
  target.on("unhandledRejection", onRejection);
  return () => target.off("unhandledRejection", onRejection);
}
