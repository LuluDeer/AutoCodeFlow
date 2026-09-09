import {
  renderTemplate,
  hasChannelTemplate,
  TEMPLATE_MAX_BYTES,
  TEMPLATE_TRUNCATION_SUFFIX,
} from "../render-template.util";

/**
 * FEAT-10: 渠道级通知模板渲染引擎测试矩阵（任务书要求 8+ 例，覆盖
 * 全变量 / 未知变量保留 / 单 pass 防递归注入 / 8KB 截断 / 空值语义 /
 * 非法输入降级）。
 */
describe("renderTemplate (FEAT-10)", () => {
  const fullVars = {
    taskName: "nightly-backup",
    task: "nightly-backup",
    executionId: "exec-abc-123",
    failedReason: "TIMEOUT: script exceeded 60s",
    logs: "line1\nline2\nline3",
    duration: 15230,
    runbook: "https://wiki.example.com/rb/backup",
    level: "error",
  };

  it("1. renders a template with all documented variables", () => {
    const out = renderTemplate(
      "任务 {{taskName}} ({{executionId}}) 失败：{{failedReason}}，耗时 {{duration}}ms",
      fullVars,
    );
    expect(out).toBe(
      "任务 nightly-backup (exec-abc-123) 失败：TIMEOUT: script exceeded 60s，耗时 15230ms",
    );
  });

  it("2. leaves unknown variables verbatim (config typo visibility)", () => {
    const out = renderTemplate("task={{taskNam}} ok={{known}}", {
      known: "yes",
    });
    expect(out).toBe("task={{taskNam}} ok=yes");
  });

  it("3. single-pass replacement: a value containing {{...}} is NOT re-expanded (injection-proof)", () => {
    const out = renderTemplate("{{failedReason}}", {
      failedReason: "{{taskName}} injected",
      taskName: "pwned",
    });
    expect(out).toBe("{{taskName}} injected");
  });

  it("4. truncates output beyond 8KB with a suffix marker", () => {
    const bigLog = "x".repeat(TEMPLATE_MAX_BYTES + 1000);
    const out = renderTemplate("{{logs}}", { logs: bigLog });
    // 截断到 8KB + 追加标记
    expect(out.length).toBe(
      TEMPLATE_MAX_BYTES + TEMPLATE_TRUNCATION_SUFFIX.length,
    );
    expect(out.endsWith(TEMPLATE_TRUNCATION_SUFFIX)).toBe(true);
    expect(out.startsWith("x")).toBe(true);
  });

  it("5. keeps output of exactly 8KB untouched (boundary)", () => {
    const exact = "y".repeat(TEMPLATE_MAX_BYTES);
    const out = renderTemplate("{{logs}}", { logs: exact });
    expect(out).toBe(exact);
  });

  it("6. null/undefined variable values render as empty string", () => {
    const out = renderTemplate(
      "task={{taskName}} reason={{failedReason}} end",
      { taskName: null, failedReason: undefined },
    );
    expect(out).toBe("task= reason= end");
  });

  it("7. tolerates whitespace inside braces: {{ var }}", () => {
    const out = renderTemplate("{{ taskName }}|{{  duration  }}", fullVars);
    expect(out).toBe("nightly-backup|15230");
  });

  it("8. non-numeric identifiers like {{a-b}} / {{}} are not placeholders (kept verbatim)", () => {
    const out = renderTemplate("keep {{a-b}} and {{}} and {{{taskName}}}", {
      taskName: "t",
    });
    // {{a-b}} / {{}} 不匹配变量语法 → 原样；{{{taskName}}} 外层花括号保留
    expect(out).toBe("keep {{a-b}} and {{}} and {t}");
  });

  it("9. returns empty string for empty/null/non-string templates (fail-safe)", () => {
    expect(renderTemplate(undefined, fullVars)).toBe("");
    expect(renderTemplate(null, fullVars)).toBe("");
    expect(renderTemplate("", fullVars)).toBe("");
    expect(renderTemplate(123 as unknown as string, fullVars)).toBe("");
  });

  it("10. template without any placeholder passes through (minus size cap)", () => {
    expect(renderTemplate("plain text", fullVars)).toBe("plain text");
  });

  it("11. numeric values are stringified", () => {
    expect(renderTemplate("took {{duration}}ms", { duration: 42 })).toBe(
      "took 42ms",
    );
  });

  it("12. truncation marker itself does not push output past the cap twice", () => {
    const big = "z".repeat(TEMPLATE_MAX_BYTES * 3);
    const out = renderTemplate("{{logs}}", { logs: big });
    expect(out.length).toBe(
      TEMPLATE_MAX_BYTES + TEMPLATE_TRUNCATION_SUFFIX.length,
    );
  });
});

describe("hasChannelTemplate (FEAT-10)", () => {
  it("returns false for undefined/empty config", () => {
    expect(hasChannelTemplate(undefined)).toBe(false);
    expect(hasChannelTemplate({})).toBe(false);
    expect(hasChannelTemplate({ titleTemplate: "" })).toBe(false);
    expect(hasChannelTemplate({ contentTemplate: "" })).toBe(false);
  });

  it("returns true when either template key is a non-empty string", () => {
    expect(hasChannelTemplate({ titleTemplate: "[{{level}}] {{task}}" })).toBe(
      true,
    );
    expect(
      hasChannelTemplate({ contentTemplate: "exec {{executionId}} failed" }),
    ).toBe(true);
    expect(
      hasChannelTemplate({
        titleTemplate: "t",
        contentTemplate: "c",
      }),
    ).toBe(true);
  });
});
