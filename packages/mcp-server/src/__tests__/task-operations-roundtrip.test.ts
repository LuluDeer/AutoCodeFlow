/**
 * export_task / import_task 的 verbatim round-trip 契约。
 *
 * ① export_task 出口后端已剔除 secrets，MCP 不得再做本地脱敏：普通参数
 *    键名（PASSWORD / API_KEY）的值必须逐字回传，否则 import_task 回传会
 *    把 `[redacted]` 写进任务定义。
 * ② import_task 是写面：任何 `[redacted]` 哨兵都必须在 POST 前拒绝。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import { registerTaskTools } from "../tools";
import { rejectRedactionSentinel } from "../tools/shared";

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface RegisteredTool {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: ToolHandler;
}

const TASK_ID = "33333333-3333-4333-8333-333333333333";
const parse = (r: { content: Array<{ text: string }> }) =>
  JSON.parse(r.content[0].text);

let tools: Map<string, RegisteredTool>;
let call: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const registered = new Map<string, RegisteredTool>();
  call = vi.fn().mockResolvedValue({ ok: true });
  const fakeServer = {
    tool: (
      name: string,
      description: string,
      schema: Record<string, z.ZodTypeAny>,
      fourth: ToolAnnotations | ToolHandler,
      fifth?: ToolHandler,
    ) => {
      const handler = (fifth ?? fourth) as ToolHandler;
      registered.set(name, { name, description, schema, handler });
    },
  };
  registerTaskTools(fakeServer as never, call as never);
  tools = registered;
});

describe("task export/import verbatim round-trip", () => {
  it("export_task 保留普通参数 PASSWORD=real-pw（verbatim）且不输出 secrets", async () => {
    const payload = {
      schemaVersion: "1",
      exportedAt: "2026-11-25T00:00:00.000Z",
      task: {
        name: "demo",
        runtime: "node",
        params: { PASSWORD: "real-pw", API_KEY: "real-key" },
      },
    };
    call.mockResolvedValueOnce(payload);

    const result = await tools.get("export_task")!.handler({ taskId: TASK_ID });
    const text = result.content[0].text;
    const exported = parse(result);

    expect(call).toHaveBeenCalledWith("GET", `/tasks/${TASK_ID}/export`);
    expect(exported.task.params.PASSWORD).toBe("real-pw");
    expect(exported.task.params.API_KEY).toBe("real-key");
    expect(text).not.toContain("[redacted]");
    expect(exported.task).not.toHaveProperty("secrets");
    expect(text).not.toMatch(/secret/i);
    // 描述与实现一致：verbatim + secrets 由后端剔除。
    expect(tools.get("export_task")!.description).toMatch(/verbatim/i);
    expect(tools.get("export_task")!.description).toMatch(/secrets are already removed by the backend/i);
  });

  it("import_task 遇到 [redacted] 哨兵立即 isError 且零 POST", async () => {
    const payload = {
      schemaVersion: "1",
      task: { name: "demo", params: { PASSWORD: "[redacted]" } },
    };

    const result = await tools.get("import_task")!.handler({ payload });

    expect(result.isError).toBe(true);
    expect(parse(result).error).toBe("REDACTION_SENTINEL_IN_PAYLOAD");
    expect(call).not.toHaveBeenCalled();
    // 描述与实现一致：明确拒绝哨兵回传。
    expect(tools.get("import_task")!.description).toContain("[redacted]");
  });

  it("13+ 层深嵌 [redacted] 被 fail-closed 拒绝，import_task 零 POST", async () => {
    let nested: Record<string, unknown> = { PASSWORD: "[redacted]" };
    for (let i = 0; i < 13; i += 1) nested = { deeper: nested };
    const payload = {
      schemaVersion: "1",
      task: { name: "demo", params: nested },
    };

    const direct = rejectRedactionSentinel(payload, "import_task.deep");
    expect(direct).not.toBeNull();
    expect(direct!.isError).toBe(true);
    expect(parse(direct!).error).toBe("REDACTION_SENTINEL_IN_PAYLOAD");
    expect(parse(direct!).field).toContain("<depth-limit>");

    const result = await tools.get("import_task")!.handler({ payload });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toBe("REDACTION_SENTINEL_IN_PAYLOAD");
    expect(call).not.toHaveBeenCalled();
  });
});
