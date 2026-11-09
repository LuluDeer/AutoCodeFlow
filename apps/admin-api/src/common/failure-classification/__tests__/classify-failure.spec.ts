import { classifyFailure } from "../failure-patterns";
import { ExecutionFailureReason } from "../../../modules/task/entities/task-execution.entity";
import { ERROR_CODE_FAILURE_REASON } from "../../errors/error-code-failure-reason";

/**
 * `classifyFailure` 的**表驱动**一致性测试（R1 阶段 1 的硬验收判据）。
 *
 * ## 这个文件要证明什么
 *
 * 本仓的失败归因此前有**两条独立的正则链**（回调路径 `task.service.ts::inferFailureReason`
 * 与派发路径 `task.processor.ts`），规则集合还不一致——回调路径缺
 * `SANDBOX_UNAVAILABLE` / `APPLICATION_MISSING` 两条。后果是**同一条失败文案
 * 在两条路径上归因不同**（历史实例：`module not found` 回调落
 * `PACKAGE_FETCH_FAILED`、派发落 `SCRIPT_ERROR`）。
 *
 * R1 阶段 1 把它们收拢到本模块的**唯一入口** `classifyFailure`。因此本文件的核心
 * 断言不是「某条文案归到某个码」（那种测试改文案就红），而是：
 *
 *   ① **顺序不变量**：某些文案天然匹配多条正则，裁决结果必须由**顺序**决定，
 *      且这个顺序是规格（改顺序 = 改语义）。用「同一条文案必须归到更具体的那个码」
 *      来钉住顺序——而不是断言正则本身。
 *   ② **码化优先**：`errorCode` 命中码表时**完全跳过文案**（与文案长度解耦）。
 *      这是根治「文案改写 → 分类静默失效」的那一层。
 *   ③ **两路径同源**：`errorMessage` 与 `logs` 是两个入口形状，同一条文案无论从
 *      哪个字段进来，归因必须一致。
 *   ④ **中英双语等价**：中文化后两侧并存（滚动升级），同一语义的中英文案必须
 *      归到同一个码。
 */

describe("classifyFailure（失败归因唯一入口）", () => {
  // ---------------------------------------------------------------------------
  // ① 顺序不变量：更具体的规则必须赢
  // ---------------------------------------------------------------------------
  describe("顺序不变量（改顺序 = 改语义）", () => {
    it("解释器下载超时 → INTERPRETER_UNAVAILABLE（不是 TIMEOUT）", () => {
      // 文案天然含 "timeout"，若让 TIMEOUT 规则先跑就会误判。
      // 语义差别是真实的：下载超时是环境问题（预填缓存/修镜像），
      // 任务超时是调 timeout / 查任务本身——分因错了等于把运维引向错误方向。
      expect(
        classifyFailure({
          errorMessage: "interpreter download timeout after 300s",
        }),
      ).toBe(ExecutionFailureReason.INTERPRETER_UNAVAILABLE);
    });

    it("解释器缺失的 uv venv 文案 → INTERPRETER_UNAVAILABLE（不是 PACKAGE_FETCH）", () => {
      // 含 "uv venv"（与依赖安装同一包装层），但根因是解释器缺失。
      expect(
        classifyFailure({
          errorMessage: "uv venv failed: No interpreter found for Python 3.7",
        }),
      ).toBe(ExecutionFailureReason.INTERPRETER_UNAVAILABLE);
    });

    it("解释器规则必须先于 EXECUTOR_OFFLINE（栈里带 ExecutorService 也不误判）", () => {
      // 真实失败现场：文案含 "No interpreter found"，栈里带
      // `ExecutorService.failInterpreterUnavailable` —— 若 offline 规则先跑，
      // `/executor.*(offline|unavailable)/i` 会命中 `ExecutorService...Unavailable`
      // 并误判成 executor_offline（于是错误地烧重试预算）。
      expect(
        classifyFailure({
          errorMessage: "No interpreter found for Python 3.7",
          logs: "at ExecutorService.failInterpreterUnavailable (executor.service.ts:1:1)",
        }),
      ).toBe(ExecutionFailureReason.INTERPRETER_UNAVAILABLE);
    });

    it("沙箱不可用 → SANDBOX_UNAVAILABLE（不是 EXECUTOR_OFFLINE）", () => {
      // 沙箱文案带 "unavailable"，栈里又带 `ExecutorService...`。
      expect(
        classifyFailure({
          errorMessage: "TASK_SANDBOX=bwrap but bwrap is unavailable",
          logs: "at ExecutorService.dispatch (executor.service.ts:1:1)",
        }),
      ).toBe(ExecutionFailureReason.SANDBOX_UNAVAILABLE);
    });

    it("应用已被删除 → APPLICATION_MISSING（不是 PACKAGE_FETCH_FAILED）", () => {
      // 文案含 "packageUrl"，会被拉包规则吞掉。
      expect(
        classifyFailure({
          errorMessage:
            "Cannot resolve packageUrl for application 0f1e2d3c not found",
        }),
      ).toBe(ExecutionFailureReason.APPLICATION_MISSING);
    });

    it("依赖缺失的 module not found → PACKAGE_FETCH_FAILED（不是 SCRIPT_ERROR）", () => {
      // 这是历史分叉点：回调路径有这两条、派发路径没有 ⇒ 同一失败归因不同。
      expect(
        classifyFailure({ errorMessage: "module not found: left-pad" }),
      ).toBe(ExecutionFailureReason.PACKAGE_FETCH_FAILED);
      expect(
        classifyFailure({
          errorMessage: "ModuleNotFoundError: No module named 'requests'",
        }),
      ).toBe(ExecutionFailureReason.PACKAGE_FETCH_FAILED);
    });
  });

  // ---------------------------------------------------------------------------
  // ② 码化优先：与文案长度/措辞完全解耦
  // ---------------------------------------------------------------------------
  describe("码化优先（errorCode 直接决定归因，跳过文案）", () => {
    it("PINNED_EXECUTOR_OFFLINE → EXECUTOR_OFFLINE，即使文案是任意垃圾", () => {
      // 历史事故：该码的中文文案「执行器→离线」实测间隔 63 字符，
      // 而中文支容差曾是 20 → 规则不命中 → 归成 script_error
      // → 用户看到「脚本错误」且白白烧重试预算。
      // 码化后与文案长度彻底解耦。
      expect(
        classifyFailure({
          errorCode: "PINNED_EXECUTOR_OFFLINE",
          errorMessage: "完全不相关的文案 with no keywords at all",
        }),
      ).toBe(ExecutionFailureReason.EXECUTOR_OFFLINE);
    });

    it("超长 appName 构造的 pinned 离线文案仍归 EXECUTOR_OFFLINE", () => {
      // 证明「与文案长度解耦」：即使正则容差不够，码化通道照样命中。
      const longName = "a".repeat(500);
      expect(
        classifyFailure({
          errorCode: "PINNED_EXECUTOR_OFFLINE",
          errorMessage: `指定的固定执行器 "${longName}" (uuid) 已离线`,
        }),
      ).toBe(ExecutionFailureReason.EXECUTOR_OFFLINE);
    });

    it("码表里没有的 errorCode 回落到文案正则（不误吞）", () => {
      expect(
        classifyFailure({
          errorCode: "SOME_UNMAPPED_CODE",
          errorMessage: "execution timed out after 300s",
        }),
      ).toBe(ExecutionFailureReason.TIMEOUT);
    });

    it("码表映射必须全部是合法的 ExecutionFailureReason 值", () => {
      // 元数据一致性：码表不能映射到不存在的枚举值（否则运行期落 undefined）。
      const valid = new Set<string>(Object.values(ExecutionFailureReason));
      for (const [code, reason] of Object.entries(ERROR_CODE_FAILURE_REASON)) {
        expect({ code, reason, ok: valid.has(reason) }).toEqual({
          code,
          reason,
          ok: true,
        });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // ③ 两路径同源：errorMessage / logs 两个入口形状，归因必须一致
  // ---------------------------------------------------------------------------
  describe("两路径同源（errorMessage vs logs 不改变归因）", () => {
    const CASES: Array<[string, ExecutionFailureReason]> = [
      ["execution timed out after 300s", ExecutionFailureReason.TIMEOUT],
      [
        "No interpreter found for Python 3.7",
        ExecutionFailureReason.INTERPRETER_UNAVAILABLE,
      ],
      [
        "module not found: left-pad",
        ExecutionFailureReason.PACKAGE_FETCH_FAILED,
      ],
      [
        "Traceback (most recent call last):",
        ExecutionFailureReason.SCRIPT_ERROR,
      ],
      [
        "bwrap: setting up uid map: Permission denied",
        ExecutionFailureReason.SANDBOX_UNAVAILABLE,
      ],
    ];

    it.each(CASES)(
      "同一条文案「%s」从 errorMessage 或 logs 进入 → 归因一致",
      (text, expected) => {
        const viaMessage = classifyFailure({ errorMessage: text });
        const viaLogs = classifyFailure({ logs: text });
        const viaBoth = classifyFailure({ errorMessage: text, logs: text });
        expect(viaMessage).toBe(expected);
        expect(viaLogs).toBe(expected);
        expect(viaBoth).toBe(expected);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // ④ 中英双语等价（滚动升级期两侧并存）
  // ---------------------------------------------------------------------------
  describe("中英双语等价", () => {
    it("超时：英文与中文归同一个码", () => {
      expect(classifyFailure({ errorMessage: "execution timed out" })).toBe(
        ExecutionFailureReason.TIMEOUT,
      );
      expect(classifyFailure({ errorMessage: "执行已超时" })).toBe(
        ExecutionFailureReason.TIMEOUT,
      );
    });

    it("解释器缺失：英文与中文归同一个码", () => {
      expect(classifyFailure({ errorMessage: "interpreter not found" })).toBe(
        ExecutionFailureReason.INTERPRETER_UNAVAILABLE,
      );
      expect(classifyFailure({ errorMessage: "解释器缺失" })).toBe(
        ExecutionFailureReason.INTERPRETER_UNAVAILABLE,
      );
    });

    it("沙箱不可用：英文与中文归同一个码", () => {
      expect(classifyFailure({ errorMessage: "bwrap is unavailable" })).toBe(
        ExecutionFailureReason.SANDBOX_UNAVAILABLE,
      );
      expect(classifyFailure({ errorMessage: "沙箱不可用" })).toBe(
        ExecutionFailureReason.SANDBOX_UNAVAILABLE,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // ⑤ 负向：不该命中的不要命中（防止正则过宽）
  // ---------------------------------------------------------------------------
  describe("负向断言（判据不得过宽）", () => {
    it("任务代码只是打印了 interpreter 一词 → 不判 INTERPRETER_UNAVAILABLE", () => {
      // 判据要求解释器词与失败词**相邻**，孤立词不构成判据。
      const reason = classifyFailure({
        errorMessage: "user script printed: interpreter is a cool word",
        exitCode: 0,
      });
      expect(reason).not.toBe(ExecutionFailureReason.INTERPRETER_UNAVAILABLE);
    });

    it("栈里出现 sandbox.ts 模块路径 → 不判 SANDBOX_UNAVAILABLE", () => {
      // 刻意不用 `\bsandbox\b`：它会命中栈里的模块路径（`.../sandbox.ts:12`），
      // 把一次瞬时、可恢复的派发失败误判成「环境类不可重试」——
      // 静默少一次重试 = 静默少一次成功，比漏判更贵。
      const reason = classifyFailure({
        errorMessage: "connection reset",
        logs: "at runSandbox (/app/src/sandbox.ts:12:3)",
      });
      expect(reason).not.toBe(ExecutionFailureReason.SANDBOX_UNAVAILABLE);
    });

    it("完全无关键词且 exitCode=0 → UNKNOWN", () => {
      expect(
        classifyFailure({
          errorMessage: "something odd happened",
          exitCode: 0,
        }),
      ).toBe(ExecutionFailureReason.UNKNOWN);
    });
  });

  // ---------------------------------------------------------------------------
  // ⑥ exitCode 语义
  // ---------------------------------------------------------------------------
  describe("exitCode 语义", () => {
    it("非 0 退出码是无关键词时的充分证据 → SCRIPT_ERROR", () => {
      expect(classifyFailure({ exitCode: 1 })).toBe(
        ExecutionFailureReason.SCRIPT_ERROR,
      );
    });

    it("exitCode=0 不触发 SCRIPT_ERROR", () => {
      expect(classifyFailure({ exitCode: 0 })).toBe(
        ExecutionFailureReason.UNKNOWN,
      );
    });

    it("更具体的规则优先于 exitCode（如超时）", () => {
      expect(
        classifyFailure({ errorMessage: "execution timed out", exitCode: 1 }),
      ).toBe(ExecutionFailureReason.TIMEOUT);
    });
  });
});
