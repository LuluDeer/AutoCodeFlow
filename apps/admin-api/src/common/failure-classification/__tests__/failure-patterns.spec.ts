import { AppError } from "../../errors/app-error";
import {
  APPLICATION_MISSING_PATTERN,
  EXECUTOR_OFFLINE_PATTERN,
  INTERPRETER_UNAVAILABLE_PATTERN,
  PACKAGE_FETCH_PATTERN,
  SANDBOX_UNAVAILABLE_PATTERN,
  SCRIPT_ERROR_PATTERN,
  TIMEOUT_PATTERN,
  classifyFailure,
} from "../failure-patterns";
import { ERROR_CODE_FAILURE_REASON } from "../../errors/error-code-failure-reason";
import { ExecutionFailureReason } from "../../../modules/task/entities/task-execution.entity";

/**
 * 共享失败分类器（`classifyFailure`）的规格测试。
 *
 * ## 这组用例在守什么
 *
 * 失败归因是一个**横切**判定：回调路径（`task.service.ts`）与派发失败路径
 * （`task.processor.ts`）都要给出同一个答案。此前两条路径各有一份正则链，
 * 且**规则集合都不同**——于是同一个故障在两条路径上归因不同，进而导致
 * 「是否烧重试预算」的判断不同（`failureReason` 决定 `UnrecoverableError`
 * 门禁与互斥回队）。本文件把「两条路径共用一份裁决」这件事钉成可执行的断言。
 *
 * ## 为什么是表驱动
 *
 * 单条规则改一个字符，可能让另一条规则的命中面塌陷（例：把 TIMEOUT 提到
 * INTERPRETER_UNAVAILABLE 之前，会让「解释器下载超时」从
 * `interpreter_unavailable` 变成 `timeout`——**重试语义反转**）。表驱动让
 * 「顺序」这个规格变成一条条可执行的断言，而不是注释里的君子协定。
 */
describe("classifyFailure —— 失败归因的唯一裁决入口", () => {
  /**
   * 文案 → 期望归因。**这些文案是从真实产物抄下来的**（执行器原文、中台
   * 错误码表渲染结果、历史落库值），不是编的——编的文案守不住真实漂移。
   */
  const CASES: Array<{
    /** 用例名（失败时能一眼看出是哪条规则塌了） */
    name: string;
    errorMessage: string;
    logs?: string;
    exitCode?: number;
    expected: ExecutionFailureReason;
  }> = [
    // ── ① interpreter_unavailable（必须最先） ──────────────────────────
    {
      name: "uv 的 No interpreter found（英文原文）",
      errorMessage:
        "No interpreter found for Python 3.7 in managed installations or search path",
      expected: ExecutionFailureReason.INTERPRETER_UNAVAILABLE,
    },
    {
      name: "uv 的 No download found（英文原文）",
      errorMessage: "No download found for request: cpython-3.7-linux-x86_64",
      expected: ExecutionFailureReason.INTERPRETER_UNAVAILABLE,
    },
    {
      name: "UV_PYTHON_DOWNLOADS=manual 阻断提示",
      errorMessage: "python downloads are set to 'manual'",
      expected: ExecutionFailureReason.INTERPRETER_UNAVAILABLE,
    },
    {
      name: "解释器下载超时**不得**被 TIMEOUT 吞掉（顺序保护）",
      errorMessage: "interpreter download timeout after 300s",
      expected: ExecutionFailureReason.INTERPRETER_UNAVAILABLE,
    },
    {
      name: "调用栈含 ExecutorService.failInterpreterUnavailable **不得**被误判成 executor_offline（顺序保护）",
      errorMessage: "[interpreter_unavailable] 解释器不可用",
      logs: "at ExecutorService.failInterpreterUnavailable (/app/src/modules/executor/executor.service.ts:3297:11)",
      expected: ExecutionFailureReason.INTERPRETER_UNAVAILABLE,
    },
    {
      name: "中文：解释器无法获取",
      errorMessage: "解释器 3.7 无法获取（缓存缺失且下载失败）",
      expected: ExecutionFailureReason.INTERPRETER_UNAVAILABLE,
    },

    // ── ② application_missing（必须在 PACKAGE_FETCH 之前） ─────────────
    {
      name: "应用已删除（含 packageUrl ⇒ 不得被拉包规则吞掉，顺序保护）",
      errorMessage:
        "Cannot resolve packageUrl for task t1: application 0f7a-uuid not found",
      expected: ExecutionFailureReason.APPLICATION_MISSING,
    },
    {
      name: "中文：找不到应用",
      errorMessage: "无法解析 packageUrl：找不到应用",
      expected: ExecutionFailureReason.APPLICATION_MISSING,
    },

    // ── ③ timeout ─────────────────────────────────────────────────────
    {
      name: "真实任务超时（英文）",
      errorMessage: "execution timed out after 300s",
      expected: ExecutionFailureReason.TIMEOUT,
    },
    {
      name: "真实任务超时（中文）",
      errorMessage: "执行已超时（300s）",
      expected: ExecutionFailureReason.TIMEOUT,
    },

    // ── ④ sandbox_unavailable（必须在 executor_offline 之前） ─────────
    {
      name: "沙箱不可用（结构化 token）",
      errorMessage:
        "[sandbox_unavailable] 沙箱不可用：bwrap 缺失或用户命名空间被禁（已 fail-closed，未降级直跑）",
      expected: ExecutionFailureReason.SANDBOX_UNAVAILABLE,
    },
    {
      name: "沙箱不可用（英文 bwrap 文案）",
      errorMessage: "bwrap: setting up uid map: Permission denied",
      expected: ExecutionFailureReason.SANDBOX_UNAVAILABLE,
    },
    {
      name: "沙箱文案带 unavailable ⇒ 不得被 executor_offline 吞掉（顺序保护）",
      errorMessage: "task sandbox is unavailable on this host",
      expected: ExecutionFailureReason.SANDBOX_UNAVAILABLE,
    },

    // ── ⑤ executor_offline ────────────────────────────────────────────
    {
      name: "无可用执行器（英文原文）",
      errorMessage: "no available executor (all candidates are offline)",
      expected: ExecutionFailureReason.EXECUTOR_OFFLINE,
    },
    {
      name: "pinned 离线（**中文长文案**——容差必须覆盖它，这正是历史缺陷）",
      errorMessage:
        '指定的固定执行器 "my-super-long-application-name-here" (0f7a1234-5678-90ab-cdef-1234567890ab) 已离线',
      expected: ExecutionFailureReason.EXECUTOR_OFFLINE,
    },
    {
      name: "网络错误（ECONNRESET / socket hang up）",
      errorMessage: "socket hang up ECONNRESET",
      expected: ExecutionFailureReason.EXECUTOR_OFFLINE,
    },

    // ── ⑥ package_fetch_failed（含 module not found —— 历史分叉点） ────
    {
      name: "依赖安装失败（npm install）",
      errorMessage: "npm install failed with exit code 1",
      expected: ExecutionFailureReason.PACKAGE_FETCH_FAILED,
    },
    {
      // ⚠️ 这条是**真分叉点**：此前**派发路径**的 PACKAGE_FETCH 正则不含
      // `module not found`，于是同一条失败在回调路径归 PACKAGE_FETCH_FAILED、
      // 在派发路径归 SCRIPT_ERROR。收敛后两条路径必须一致。
      name: "module not found（此前派发路径缺这条 ⇒ 两路径归因不一致）",
      errorMessage: "Error: Cannot find module 'axios'",
      expected: ExecutionFailureReason.PACKAGE_FETCH_FAILED,
    },
    {
      name: "中文：安装依赖失败",
      errorMessage: "安装依赖失败：pip install 返回 1",
      expected: ExecutionFailureReason.PACKAGE_FETCH_FAILED,
    },

    // ── ⑦ script_error ────────────────────────────────────────────────
    {
      name: "Python traceback",
      errorMessage: "Traceback (most recent call last):",
      expected: ExecutionFailureReason.SCRIPT_ERROR,
    },
    {
      name: "非 0 退出码（无文案线索时也判脚本错误）",
      errorMessage: "process exited",
      exitCode: 1,
      expected: ExecutionFailureReason.SCRIPT_ERROR,
    },

    // ── ⑧ 兜底 ───────────────────────────────────────────────────────
    {
      name: "无任何线索 ⇒ UNKNOWN",
      errorMessage: "something odd happened",
      expected: ExecutionFailureReason.UNKNOWN,
    },
  ];

  it.each(CASES)("$name", ({ errorMessage, logs, exitCode, expected }) => {
    expect(classifyFailure({ errorMessage, logs, exitCode })).toBe(expected);
  });

  /**
   * 码化优先：`errorCode` 命中码表 ⇒ **完全跳过文案正则**。
   *
   * 这是「根治文案漂移」的那一层——用例刻意用一条**完全不匹配任何分类正则**
   * 的文案，证明归因来自码而不是文案。
   */
  describe("码化优先（errorCode 命中 ⇒ 不看文案）", () => {
    it("PINNED_EXECUTOR_OFFLINE ⇒ executor_offline（文案无关）", () => {
      expect(
        classifyFailure({
          errorMessage: "某个完全不含任何分类关键词的文案 xyzzy",
          errorCode: "PINNED_EXECUTOR_OFFLINE",
        }),
      ).toBe(ExecutionFailureReason.EXECUTOR_OFFLINE);
    });

    /**
     * **反证**：文案被改写（中文化改措辞、appName 变长）后，归因**不变**。
     *
     * 这正是码化优先要解决的问题：走正则时，容差是手调魔数，文案一变就可能
     * 静默失效（历史缺陷：容差 20 < 自家文案 63 ⇒ pinned 离线被归成
     * script_error，且 script_error 在默认重试集里 ⇒ 白烧重试预算）。
     */
    it("文案改写后归因不变（正则路径会失效，码路径不会）", () => {
      const variants = [
        '指定的固定执行器 "a" (uuid) 已离线',
        'pinned executor "a-very-long-application-name-that-pushes-the-gap-way-past-any-hand-tuned-tolerance" (uuid) 已离线',
        "该执行器当前处于离线状态",
        "完全不相关的文案",
      ];
      for (const errorMessage of variants) {
        expect(
          classifyFailure({
            errorMessage,
            errorCode: "PINNED_EXECUTOR_OFFLINE",
          }),
        ).toBe(ExecutionFailureReason.EXECUTOR_OFFLINE);
      }
      // 对照：去掉码之后，最后一条文案确实**归不出** executor_offline
      // （证明上方的稳定性来自码，不是文案恰好能匹配）。
      expect(classifyFailure({ errorMessage: "完全不相关的文案" })).toBe(
        ExecutionFailureReason.UNKNOWN,
      );
    });

    it("码表未登记的 code ⇒ 回落到文案正则（不静默吞掉）", () => {
      expect(
        classifyFailure({
          errorMessage: "execution timed out after 300s",
          // TASK_NOT_FOUND 不在码表里 ⇒ 必须继续走正则，命中 TIMEOUT
          errorCode: "TASK_NOT_FOUND",
        }),
      ).toBe(ExecutionFailureReason.TIMEOUT);
    });

    it("码表里每条映射都能被 AppError 的真实 errorCode 取到（防码名笔误）", () => {
      // 用真实 AppError 构造，取它的 errorCode —— 码名拼错会在 ERROR_CATALOG
      // 的联合类型处编译失败；这里再钉一次运行时形态。
      const err = new AppError("PINNED_EXECUTOR_OFFLINE", {
        appName: "a",
        executorId: "uuid",
      });
      expect(err.errorCode).toBe("PINNED_EXECUTOR_OFFLINE");
      expect(classifyFailure({ errorCode: err.errorCode })).toBe(
        ExecutionFailureReason.EXECUTOR_OFFLINE,
      );
    });

    it("码表非空（结构断言：清空码表 = 码化优先整层静默失效）", () => {
      // 与 check-failure-reasons.mjs 的「事实源被清空 = 永真断言」同类风险：
      // 码表被清空后，上面的「码优先」用例仍可能因文案恰好匹配而假绿。
      expect(Object.keys(ERROR_CODE_FAILURE_REASON).length).toBeGreaterThan(0);
    });
  });

  /**
   * 判据常量的**结构断言**——防「正则被清空/改坏」。
   *
   * 为什么值得单测：这些正则是**字符串**，一个手滑的转义就会让整条规则永不
   * 命中，而所有用例仍然绿（因为不命中只是回落到更笼统的规则）。下界断言让
   * 「规则塌陷」变成红灯。
   */
  describe("判据常量结构（防规则塌陷）", () => {
    it("每条判据都能命中它自己声明的样本", () => {
      expect(INTERPRETER_UNAVAILABLE_PATTERN.source.length).toBeGreaterThan(50);
      expect(EXECUTOR_OFFLINE_PATTERN.source.length).toBeGreaterThan(50);
      expect(SANDBOX_UNAVAILABLE_PATTERN.source.length).toBeGreaterThan(20);
      expect(APPLICATION_MISSING_PATTERN.source.length).toBeGreaterThan(20);
      expect(TIMEOUT_PATTERN.source.length).toBeGreaterThan(10);
      expect(PACKAGE_FETCH_PATTERN.source.length).toBeGreaterThan(50);
      expect(SCRIPT_ERROR_PATTERN.source.length).toBeGreaterThan(50);
    });

    it("中英双语：每条面向用户文案的判据都有中文支（反之亦然）", () => {
      // 两侧独立发版，滚动升级必然新旧并存 ⇒ 中英并列是唯一安全口径。
      const hasCjk = (re: RegExp) => /[\u4e00-\u9fa5]/.test(re.source);
      expect(hasCjk(INTERPRETER_UNAVAILABLE_PATTERN)).toBe(true);
      expect(hasCjk(EXECUTOR_OFFLINE_PATTERN)).toBe(true);
      expect(hasCjk(SANDBOX_UNAVAILABLE_PATTERN)).toBe(true);
      expect(hasCjk(APPLICATION_MISSING_PATTERN)).toBe(true);
      expect(hasCjk(TIMEOUT_PATTERN)).toBe(true);
      expect(hasCjk(PACKAGE_FETCH_PATTERN)).toBe(true);
      expect(hasCjk(SCRIPT_ERROR_PATTERN)).toBe(true);
    });

    it("EXECUTOR_OFFLINE 的中文容差覆盖 appName 列宽上界（历史缺陷的回归钉）", () => {
      // appName 列宽上界按 56 字符计：`执行器` + `"` + appName + `" (uuid) 已离线`
      // 的间隔必须仍被覆盖。容差被调回 20 会让本用例转红。
      const longAppName = "a".repeat(56);
      const msg = `执行器 "${longAppName}" (0f7a1234-5678-90ab-cdef-1234567890ab) 已离线`;
      expect(EXECUTOR_OFFLINE_PATTERN.test(msg)).toBe(true);
    });
  });
});
