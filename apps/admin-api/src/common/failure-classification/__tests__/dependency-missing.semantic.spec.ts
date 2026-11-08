/**
 * `dependency_missing` 语义的**现状钉桩**（Round 2 · guard-hardening）。
 *
 * ## 这份 spec 钉的是什么
 *
 * 一个**已知的语义近似**，不是理想状态：
 *
 *   **当前**：`ModuleNotFoundError`（用户脚本 `import pandas` 失败）被归为
 *   `package_fetch_failed`（「拉包失败」）。
 *
 * **更精确的**应是 `dependency_missing`（「依赖缺失」）——但**当前不存在**
 * 这个码值。
 *
 * ## 为什么本轮**不改**产品行为
 *
 * 新增 `failureReason` 码值属**协议变更**：
 *   · 要 bump `packages/executor-protocol/protocol.json` 的 `protocolVersion`；
 *   · 要同步三端枚举（admin-api `ExecutionFailureReason` /
 *     executor-node `prepareFailureReason` / executor-python
 *     `_refine_failure_reason`）；
 *   · 要动 admin-web 的标签映射与前端 runbook。
 *
 * 那是**下一轮**的事。本轮**只把现状钉住**，让将来改码值时**必然**触发一次
 * 显式的、有注释的更新，而不是被人悄悄改掉、事后没人记得。
 *
 * ## 本 spec 的三条断言各自的作用
 *
 * ① **钉住现状**：`ModuleNotFoundError` → `package_fetch_failed`。
 *    这是**当前事实**的记录，不是对它的认可。将来立项 `dependency_missing`
 *    时，这条会红 ⇒ 强制人更新它 ⇒ **不会被遗忘**。
 * ② **钉住底线**：**绝不能**回退到 `executor_offline`。
 *    这才是本轮修复（H-2，裸 `enotfound`）的**核心价值**——
 *    `executor_offline` 在**默认重试集**里，被误判成它 = 白烧重试预算
 *    + 把运维排查方向带偏（以为是执行器离线，实际是依赖没装上）。
 *    这条**不依赖**未来的码值选择，**任何时候都必须成立**。
 * ③ **钉住迁移条件**：写下「待 `dependency_missing` 码值立项后迁移」的
 *    显式条件，避免「将来有人看到这条 spec 说现状不对就随手改判据」。
 *
 * ## 与既有 spec 的分工
 *
 * · `failure-classification.path-parity.spec.ts`（27 条）：**函数级**的
 *   归因等值表 + 判据单一事实源。
 * · `failure-classification.consumer-e2e.spec.ts`：**消费端端到端**的
 *   落库归因（回调 + 派发两条路径）。
 * · **本 spec**：`dependency_missing` 这一**语义近似**的现状与迁移条件。
 *
 * @see failure-classification.path-parity.spec.ts
 * @see failure-classification.consumer-e2e.spec.ts
 */
import {
  EXECUTOR_OFFLINE_PATTERN,
  PACKAGE_FETCH_PATTERN,
  classifyFailure,
} from "../failure-patterns";
import { ExecutionFailureReason } from "../../../modules/task/entities/task-execution.entity";

describe("dependency_missing 语义现状钉桩（已知近似，非理想状态）", () => {
  /**
   * ① **现状**：`ModuleNotFoundError` → `package_fetch_failed`。
   *
   * ## 为什么这被标为「已知近似」而不是「正确」
   *
   * `PACKAGE_FETCH_PATTERN` 现在把 `modulenotfounderror|no module named`
   * 归到 `package_fetch_failed`。于是「用户脚本 `import pandas` 失败」被
   * 说成「拉包失败」——但**包拉取本身是成功的**（应用包已经拉到了），
   * 失败的是**包里的依赖没装上**。
   *
   * ## 为什么会这样（历史）
   *
   * H-1 修复前，`PACKAGE_FETCH_PATTERN` 原只写了**空格分隔**的
   * `module not found`，而 Python 原文是**连写**的 `modulenotfounderror` ——
   * 只写前者**根本接不住这一类**，于是它被裸子串 `enotfound` 误打误撞地
   * 接住（H-2 缺陷），归成了 `executor_offline`。修复时补
   * `modulenotfounderror|no module named` 接住它，但**归到了当时唯一可用的
   * 那一格**——`package_fetch_failed`。
   *
   * ## 待迁移
   *
   * 待 `dependency_missing` 码值立项（协议 bump + 三端枚举 + 前端标签）后，
   * 本条应迁移为 `dependency_missing`。**迁移前**保持现状，**不得**顺手
   * 改判据（那是协议变更，不在守卫轮次的写域内）。
   */
  it("现状：ModuleNotFoundError 归 package_fetch_failed（已知语义近似）", () => {
    for (const text of [
      "ModuleNotFoundError: No module named 'pandas'",
      "Traceback (most recent call last):\n  File \"main.py\", line 1\nModuleNotFoundError: No module named 'requests'",
    ]) {
      expect(classifyFailure({ errorMessage: text })).toBe(
        ExecutionFailureReason.PACKAGE_FETCH_FAILED,
      );
    }
  });

  /**
   * ①′ 现状在**判据层**也成立（`PACKAGE_FETCH_PATTERN` 认它、
   *    `EXECUTOR_OFFLINE_PATTERN` 不认它）——这是 ② 的判据侧前提。
   */
  it("现状（判据层）：PACKAGE_FETCH 认它、EXECUTOR_OFFLINE 不认它", () => {
    expect(PACKAGE_FETCH_PATTERN.test("ModuleNotFoundError")).toBe(true);
    expect(PACKAGE_FETCH_PATTERN.test("No module named 'x'")).toBe(true);
    // 裸子串 `enotfound` 不得命中（H-2 的修复点，词边界必须还在）。
    expect(EXECUTOR_OFFLINE_PATTERN.test("modulenotfounderror")).toBe(false);
  });

  /**
   * ② **底线**：**绝不能**回退到 `executor_offline`。
   *
   * ## 为什么这条与码值选择无关、必须恒成立
   *
   * `executor_offline` 在**默认重试集**里（用户未配置 `retryableErrors`
   * 时一切可重试）。把「依赖没装上」误判成「执行器离线」的后果是：
   *   · **白烧重试预算**——重试不会让 `pandas` 自己装上；
   *   · **排障方向被带偏**——运维去查执行器在线情况，而问题在依赖清单；
   *   · **排队语义被误触发**——派发路径的互斥回队门
   *     （`failureReason === EXECUTOR_OFFLINE` ⇒ 回 WAITING 等唤醒）
   *     会把这类执行**无限排队**而不是落死。
   *
   * 这正是 H-2（`09b5d3c0` 修掉的缺陷）的**全部价值**。
   * 故这条**不依赖**未来的 `dependency_missing` 是否立项——
   * 无论最终归 `package_fetch_failed` 还是 `dependency_missing`，
   * **都不是** `executor_offline`。
   */
  it("底线：依赖缺失绝不能回退到 executor_offline（可重试 → 白烧预算）", () => {
    for (const text of [
      "ModuleNotFoundError: No module named 'pandas'",
      "ModuleNotFoundError: No module named 'requests'",
      "Traceback (most recent call last):\n  File \"main.py\", line 1\nModuleNotFoundError: No module named 'requests'",
      "modulenotfounderror",
      "No module named 'numpy'",
    ]) {
      const reason = classifyFailure({ errorMessage: text });
      expect({ text, reason }).toEqual({
        text,
        reason: ExecutionFailureReason.PACKAGE_FETCH_FAILED,
      });
      expect(reason).not.toBe(ExecutionFailureReason.EXECUTOR_OFFLINE);
    }
  });

  /**
   * ②′ 底线的**判据侧**否定式：裸 `enotfound` 不在离线判据里。
   *
   * 这条是**独立于归因链**的判据断言 —— 避免「归因表恰好对上了」掩盖
   * 「判据过宽」。若有人把 `\benotfound\b` 改回裸 `enotfound`，本条红。
   */
  it("底线（判据侧）：裸 enotfound 不得回到离线判据里", () => {
    // 裸子串形态：`modulenotfounderror` 里含 `enotfound`（第 5 字符起）。
    expect(EXECUTOR_OFFLINE_PATTERN.test("modulenotfounderror")).toBe(false);
    // 词边界不能把真实的 ENOTFOUND 也挡掉（反向保护）。
    expect(EXECUTOR_OFFLINE_PATTERN.test("getaddrinfo ENOTFOUND host")).toBe(
      true,
    );
    expect(
      EXECUTOR_OFFLINE_PATTERN.test(
        "Error: connect ECONNREFUSED 127.0.0.1:8000",
      ),
    ).toBe(true);
  });

  /**
   * ③ **迁移条件**：显式写下「待 `dependency_missing` 码值立项后迁移」。
   *
   * ## 这条断言的作用
   *
   * 它是一条**规格锚点**：把「当前归 `package_fetch_failed` 是**暂时的**、
   * 已知近似」这件事写进**可执行的**断言里，而不只是注释里的一句愿望。
   *
   * 将来任何人要改这条语义，必须**同时**满足：
   *   · `dependency_missing` 码值已立项（协议 bump + 三端枚举 + 前端标签）；
   *   · **本 spec 被显式更新**（这条断言会红，强制他们来看这段注释）。
   *
   * 若将来 `dependency_missing` 立项，本文件的期望值应改为
   * `ExecutionFailureReason.DEPENDENCY_MISSING`；**在那之前**不得改动。
   */
  it("迁移条件：`dependency_missing` 码值尚未立项，归因保持在 package_fetch_failed", () => {
    // 码值本身**当前不存在** —— 这正是「尚未立项」的机械证据。
    // 若将来立项并加进枚举，这条会红（届时应把期望值改成 DEPENDENCY_MISSING）。
    expect(
      (ExecutionFailureReason as Record<string, string>)["DEPENDENCY_MISSING"],
    ).toBeUndefined();

    // 迁移前的现状保持不变。
    expect(
      classifyFailure({
        errorMessage: "ModuleNotFoundError: No module named 'x'",
      }),
    ).toBe(ExecutionFailureReason.PACKAGE_FETCH_FAILED);
  });
});
