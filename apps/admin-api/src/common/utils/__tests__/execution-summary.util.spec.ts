import {
  EXECUTION_SUMMARY_MAX_CHARS,
  firstLineOf,
  logHeadOf,
  summarizeScriptFailure,
} from "../execution-summary.util";

/**
 * D-3：脚本崩溃摘要补全（`summarizeScriptFailure`）单测。
 *
 * 实测现场（真栈 fragile 任务）：摘要只有「进程以退出码 1 结束」，原始
 * `Error: demo intentional failure…` 留在 logs 栈里。本套件钉死：
 * - 骨架文案 + logs 异常行 → 上提原始消息，骨架作旁证后缀；
 * - 已是可读原因 → 不改动；
 * - 骨架但无可识别异常行 → 保留骨架，不硬造消息；
 * - 超长消息按 {@link EXECUTION_SUMMARY_MAX_CHARS} 口径截断，不加省略号。
 */

const NODE_FRAGILE_LOGS = [
  "about to fail on purpose",
  "/data/tasks/4d3d6934-a907-4ad5-983f-b9c99a58162d/glue_script.js:2",
  "throw new Error('demo intentional failure: check failureReason & error message');",
  "^",
  "",
  "Error: demo intentional failure: check failureReason & error message",
  "    at Object.<anonymous> (/data/tasks/4d3d6934-a907-4ad5-983f-b9c99a58162d/glue_script.js:2:7)",
  "    at Module._compile (node:internal/modules/cjs/loader:1929:14)",
].join("\n");

const PYTHON_TRACEBACK_LOGS = [
  "Traceback (most recent call last):",
  '  File "/data/tasks/x/run.py", line 4, in <module>',
  '    raise ValueError("配置项 db_host 不能为空")',
  "ValueError: 配置项 db_host 不能为空",
].join("\n");

describe("summarizeScriptFailure — D-3 骨架文案上提", () => {
  it("Node 崩溃现场：从 logs 上提 Error 消息，骨架作旁证后缀", () => {
    const summary = summarizeScriptFailure(
      "进程以退出码 1 结束",
      NODE_FRAGILE_LOGS,
    );
    expect(summary).toBe(
      "demo intentional failure: check failureReason & error message" +
        "（进程以退出码 1 结束）",
    );
  });

  it("Python Traceback：取栈尾最后一条 XxxError 消息", () => {
    const summary = summarizeScriptFailure(
      "进程以退出码 1 结束",
      PYTHON_TRACEBACK_LOGS,
    );
    expect(summary).toBe("配置项 db_host 不能为空（进程以退出码 1 结束）");
  });

  it("信号终止骨架同样上提 logs 里的异常行", () => {
    const summary = summarizeScriptFailure(
      "进程被信号 SIGKILL 终止（SIGKILL 只能由外部发出…）",
      "Error: memory budget exceeded while writing rows",
    );
    expect(summary).toBe(
      "memory budget exceeded while writing rows" +
        "（进程被信号 SIGKILL 终止（SIGKILL 只能由外部发出…））",
    );
  });

  it("已是可读原因（非骨架）→ 原样返回，不二次加工", () => {
    const readable = "解释器 3.12 无法获取（缓存缺失 + 下载失败：网络超时）";
    expect(summarizeScriptFailure(readable, "some logs")).toBe(readable);
  });

  it("骨架文案但 logs 只有普通 stdout、无异常行 → 保留骨架", () => {
    expect(
      summarizeScriptFailure("进程以退出码 1 结束", "step 1 done\nstep 2 done"),
    ).toBe("进程以退出码 1 结束");
  });

  it("骨架文案但 logs 为空 → 保留骨架", () => {
    expect(summarizeScriptFailure("进程以退出码 1 结束", "")).toBe(
      "进程以退出码 1 结束",
    );
    expect(summarizeScriptFailure("进程以退出码 1 结束", null)).toBe(
      "进程以退出码 1 结束",
    );
  });

  it("空/非字符串 errorMessage 原样透传", () => {
    expect(summarizeScriptFailure(undefined, "logs")).toBeUndefined();
    expect(summarizeScriptFailure(null, "logs")).toBeNull();
    expect(summarizeScriptFailure("", "logs")).toBe("");
  });

  it("链式 cause 取最后一条异常行", () => {
    const chained = [
      "Error: outer failure",
      "Caused by:",
      "TypeError: cannot read property 'name' of undefined",
    ].join("\n");
    expect(summarizeScriptFailure("进程以退出码 1 结束", chained)).toBe(
      "cannot read property 'name' of undefined（进程以退出码 1 结束）",
    );
  });

  it("超长原始消息按 500 字符口径截断，不加省略号；全文仍在 logs", () => {
    const longMessage = "x".repeat(EXECUTION_SUMMARY_MAX_CHARS + 120);
    const logs = `Error: ${longMessage}`;
    const summary = summarizeScriptFailure("进程以退出码 1 结束", logs);
    expect(summary?.length).toBeLessThanOrEqual(
      EXECUTION_SUMMARY_MAX_CHARS + "（进程以退出码 1 结束）".length,
    );
    expect(summary).not.toContain("…");
    expect(summary).not.toContain("...");
  });
});

describe("既有摘要口径（回归守住）", () => {
  it("firstLineOf 归一 CRLF/CR 行终止符", () => {
    expect(firstLineOf("first\r\nsecond")).toBe("first");
    expect(firstLineOf("first\rsecond")).toBe("first");
    expect(firstLineOf("single")).toBe("single");
  });

  it("logHeadOf 空输入返回空串，超长首行硬切 500 不加省略号", () => {
    expect(logHeadOf(null)).toBe("");
    expect(logHeadOf(undefined)).toBe("");
    const long = "y".repeat(EXECUTION_SUMMARY_MAX_CHARS + 50);
    const head = logHeadOf(long);
    expect(head).toHaveLength(EXECUTION_SUMMARY_MAX_CHARS);
    expect(head).not.toContain("…");
  });
});
