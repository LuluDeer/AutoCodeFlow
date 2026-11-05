/**
 * R67（ADR-031 步骤 4/5）：**结果整形与终局载荷**模块的独立单测。
 *
 * 这段从 `execute` 尾部整段搬出。独立单测证明它确实「不依赖 service 的状态」——
 * 三个注入项（`sanitizeResult` / `sha256` / `maxChars`）在本文件里都用**可控替身**，
 * 因此能逐条钉住 R41/R43 的取舍，而不必驱动 `ToolExecutorService` 的重型夹具。
 */
import { finalizeToolResult } from "../tool-executor.result-finalize.util";

const base = {
  durationMs: 12,
  maxChars: 2000,
  sanitizeResult: (d: unknown) => d,
  sha256: (s: string) => `sha(${s.length})`,
};

describe("finalizeToolResult（R67 搬出后的独立契约）", () => {
  it("成功且未超限：status=ok，result 是脱敏后的数据，观察结果=原文", () => {
    const out = finalizeToolResult({
      ...base,
      data: { ok: true },
      isError: false,
      errorMessage: undefined,
    });
    expect(out.patch.status).toBe("ok");
    expect(out.patch.resultTruncated).toBe(false);
    expect(out.patch.result).toEqual({ ok: true });
    expect(out.patch.errorMessage).toBeNull();
    expect(out.patch.durationMs).toBe(12);
    expect(out.observation.content).toContain("ok");
    expect(out.observation.truncated).toBe(false);
  });

  it("失败：status=error，观察结果是【调用失败】+ 工具自报文案", () => {
    const out = finalizeToolResult({
      ...base,
      data: null,
      isError: true,
      errorMessage: "boom",
    });
    expect(out.patch.status).toBe("error");
    expect(out.patch.errorMessage).toBe("boom");
    expect(out.observation.content).toBe("【调用失败】boom");
  });

  it("失败但没给文案：回『未知错误』（不把 undefined 拼进用户可见文本）", () => {
    const out = finalizeToolResult({
      ...base,
      data: null,
      isError: true,
      errorMessage: null,
    });
    expect(out.observation.content).toBe("【调用失败】未知错误");
  });

  it("超限：resultTruncated=true，载荷带 sha256/preview，且 sha256 按**原文**算", () => {
    const big = "x".repeat(5000);
    const out = finalizeToolResult({
      ...base,
      data: big,
      isError: false,
      errorMessage: undefined,
    });
    expect(out.patch.resultTruncated).toBe(true);
    expect(out.patch.result).toEqual(
      expect.objectContaining({
        truncated: true,
        sha256: expect.any(String),
        preview: expect.any(String),
      }),
    );
    // 原文（含引号的 JSON 序列化）长度 —— 不是脱敏后的串
    expect(out.patch.result.sha256).toBe(`sha(${JSON.stringify(big, null, 2).length})`);
  });

  it("落库副本走注入的 sanitizeResult，而回给模型的 content 用**原文**（R41 取舍）", () => {
    const out = finalizeToolResult({
      ...base,
      data: { token: "SECRET" },
      isError: false,
      errorMessage: undefined,
      sanitizeResult: (d) => ({ ...(d as Record<string, unknown>), token: "***" }),
    });
    expect(out.patch.result).toEqual({ token: "***" });
    expect(out.observation.content).toContain("SECRET");
  });

  it("stateChangedAt 是 Date（窗口关闭时刻由本模块生成，只有一处实现）", () => {
    const out = finalizeToolResult({
      ...base,
      data: {},
      isError: false,
      errorMessage: undefined,
    });
    expect(out.patch.stateChangedAt).toBeInstanceOf(Date);
  });
});
