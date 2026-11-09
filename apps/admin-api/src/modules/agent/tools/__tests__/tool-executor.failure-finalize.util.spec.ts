/**
 * R67（ADR-031 步骤 4/5）：**失败/超时出口**模块的独立单测。
 *
 * 这里钉住的是「缺陷 A ②」那条语义分叉的全部三个后果：
 * 观察结果、落库载荷、**是否记熔断**。它从 `execute` 的 catch 分支整段搬出，
 * 搬出后这三件事由纯函数一次算出 ⇒ 可以逐条断言，而不必驱动整条执行链。
 */
import { finalizeToolFailure } from "../tool-executor.failure-finalize.util";

const base = {
  sessionId: "s-1",
  toolName: "deploy_app",
  timeoutMs: 60_000,
  durationMs: 60_001,
  safeMessage: "srv boom",
  consumeHint: null,
};

describe("finalizeToolFailure（R67 搬出后的独立契约）", () => {
  it("写类超时 ⇒ kind=unknown_timeout：回『结果未知』、status=timeout、**不记熔断**", () => {
    const out = finalizeToolFailure({
      ...base,
      message: "timed out",
      isTimeout: true,
      tier: "write",
    });
    expect(out.kind).toBe("unknown_timeout");
    expect(out.patch.status).toBe("timeout");
    expect(out.patch.errorMessage).toContain("结果未知（超时）");
    expect(out.observation.content).toContain("不要直接重试同一写调用");
    // 「未知」既不记 true 也不记 false —— 不改变连续失败计数
    expect(out.recordFailure).toBe(false);
    expect(out.warnLog).toContain("outcome unknown");
    expect(out.warnLog).toContain("session=s-1");
  });

  it("危险类超时同样按「结果未知」处理（tier !== read）", () => {
    const out = finalizeToolFailure({
      ...base,
      message: "timed out",
      isTimeout: true,
      tier: "dangerous",
    });
    expect(out.kind).toBe("unknown_timeout");
    expect(out.recordFailure).toBe(false);
  });

  it("只读超时 ⇒ 按**失败**处理（重试是安全的）且记熔断", () => {
    const out = finalizeToolFailure({
      ...base,
      toolName: "get_task",
      message: "timed out",
      isTimeout: true,
      tier: "read",
    });
    expect(out.kind).toBe("failed");
    expect(out.patch.status).toBe("timeout");
    expect(out.recordFailure).toBe(true);
    expect(out.warnLog).toBeNull();
  });

  it("普通失败 ⇒ status=error、记熔断、回【调用失败】", () => {
    const out = finalizeToolFailure({
      ...base,
      message: "boom",
      isTimeout: false,
      tier: "write",
    });
    expect(out.kind).toBe("failed");
    expect(out.patch.status).toBe("error");
    expect(out.patch.errorMessage).toBe("srv boom");
    expect(out.observation.content).toBe("【调用失败】srv boom");
    expect(out.recordFailure).toBe(true);
  });

  it("已消耗审批单时：落库与模型文案**都**带处置指引（两出口一致）", () => {
    const hint = "请重新申请审批";
    const out = finalizeToolFailure({
      ...base,
      message: "boom",
      isTimeout: false,
      tier: "write",
      consumeHint: hint,
    });
    expect(out.patch.errorMessage).toContain(hint);
    expect(out.observation.content).toContain(hint);
    expect(out.observation.content.startsWith("【调用失败】")).toBe(true);
  });

  it("超时文案里的阈值来自入参（不在模块内写死）", () => {
    const out = finalizeToolFailure({
      ...base,
      timeoutMs: 1234,
      message: "timed out",
      isTimeout: true,
      tier: "write",
    });
    expect(out.observation.content).toContain("1234ms");
  });
});
