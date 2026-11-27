import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { registerTurnaroundTools } from "../turnaround-tools";
import { registerTaskUpdateTools } from "../task-update";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
type RegisteredTool = {
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: Handler;
};

/** 与仓库既有假 server 同形：接住 server.tool 的 5 参注册形态。 */
function capture(register: (server: never, call: never) => void): {
  tools: Map<string, RegisteredTool>;
  call: ReturnType<typeof vi.fn>;
} {
  const tools = new Map<string, RegisteredTool>();
  const call = vi.fn().mockResolvedValue({ ok: true });
  const server = {
    tool: (
      name: string,
      description: string,
      schema: Record<string, z.ZodTypeAny>,
      fourth: unknown,
      fifth?: Handler,
    ) => {
      tools.set(name, {
        description,
        schema,
        handler: (fifth ?? fourth) as Handler,
      });
    },
  };
  register(server as never, call as never);
  return { tools, call };
}

const payloadOf = (res: ToolResult): Record<string, unknown> =>
  JSON.parse(res.content[0].text) as Record<string, unknown>;

const NULL_FIELDS = ["blockStrategy", "misfireStrategy"] as const;
const TASK_ID = "11111111-1111-4111-8111-111111111111";

const REGISTRATIONS: Array<{
  name: string;
  register: (server: never, call: never) => void;
}> = [
  { name: "create_task", register: registerTurnaroundTools },
  { name: "update_task", register: registerTaskUpdateTools },
];

describe("MCP NOT NULL enum 语义：create_task / update_task", () => {
  for (const { name, register } of REGISTRATIONS) {
    it(`${name}: 两字段 schema 不再接受 null；合法枚举与域外值行为不变`, () => {
      const { tools } = capture(register);
      const schema = tools.get(name)!.schema;

      for (const field of NULL_FIELDS) {
        const f = schema[field];
        expect(f.safeParse(null).success, `${name}.${field} 必须驳回 null`).toBe(false);
        expect(f.safeParse("bogus").success, `${name}.${field} 必须驳回域外值`).toBe(false);
      }
      expect(schema.blockStrategy.safeParse("serial").success).toBe(true);
      expect(schema.blockStrategy.safeParse("discard").success).toBe(true);
      expect(schema.blockStrategy.safeParse("cover_early").success).toBe(true);
      expect(schema.misfireStrategy.safeParse("ignore").success).toBe(true);
      expect(schema.misfireStrategy.safeParse("fire_once").success).toBe(true);
    });

    it(`${name}: 非法枚举在 SDK 入站解析即被驳回（不到 handler/后端）`, () => {
      const { tools } = capture(register);
      const parsed = z.object(tools.get(name)!.schema).safeParse({
        ...(name === "create_task"
          ? { name: "nightly-alignment", triggerType: "manual" }
          : { taskId: TASK_ID, name: "renamed" }),
        blockStrategy: "cover-early",
      });
      expect(parsed.success).toBe(false);
    });

    it(`${name}: 描述不再宣称 null=default，明确省略才走默认值`, () => {
      const { tools } = capture(register);
      const tool = tools.get(name)!;
      expect(tool.description).not.toMatch(/null\s*=\s*(?:default|legacy)/i);
      expect(tool.description).toMatch(/omit/i);
      for (const field of NULL_FIELDS) {
        const description = tool.schema[field].description ?? "";
        expect(description, `${name}.${field} 描述不得再写 null=default`).not.toMatch(
          /null\s*=\s*(?:default|legacy)/i,
        );
        expect(description, `${name}.${field} 描述必须说明省略语义`).toMatch(/omit/i);
      }
    });
  }

  describe("create_task handler", () => {
    const base = { name: "nightly-alignment", triggerType: "manual" } as const;

    it("显式 null 返回 NULL_NOT_ALLOWED，且没有 POST", async () => {
      const { tools, call } = capture(registerTurnaroundTools);
      const handler = tools.get("create_task")!.handler;

      for (const field of NULL_FIELDS) {
        call.mockClear();
        const res = await handler({ ...base, [field]: null });
        expect(res.isError, `${field}=null 必须是 isError`).toBe(true);
        expect(payloadOf(res)).toMatchObject({
          error: "NULL_NOT_ALLOWED",
          errorCode: "NULL_NOT_ALLOWED",
          fields: [field],
        });
        expect(call, `${field}=null 不得调用后端`).not.toHaveBeenCalled();
      }
    });

    it("两个字段同时 null 时一次列出两个字段且不发 POST", async () => {
      const { tools, call } = capture(registerTurnaroundTools);
      const res = await tools.get("create_task")!.handler({
        ...base,
        blockStrategy: null,
        misfireStrategy: null,
      });
      expect(res.isError).toBe(true);
      expect(payloadOf(res)).toMatchObject({
        error: "NULL_NOT_ALLOWED",
        fields: ["blockStrategy", "misfireStrategy"],
      });
      expect(call).not.toHaveBeenCalled();
    });

    it("省略两个字段仍成功创建，POST body 不带枚举键", async () => {
      const { tools, call } = capture(registerTurnaroundTools);
      const res = await tools.get("create_task")!.handler(base);
      expect(res.isError).toBeUndefined();
      expect(call).toHaveBeenCalledWith("POST", "/tasks", base);
      const body = call.mock.calls[0][2] as Record<string, unknown>;
      expect(body).not.toHaveProperty("blockStrategy");
      expect(body).not.toHaveProperty("misfireStrategy");
    });
  });

  describe("update_task handler", () => {
    const base = { taskId: TASK_ID, name: "renamed" } as const;

    it("显式 null 返回 NULL_NOT_ALLOWED，且没有 PATCH", async () => {
      const { tools, call } = capture(registerTaskUpdateTools);
      const handler = tools.get("update_task")!.handler;

      for (const field of NULL_FIELDS) {
        call.mockClear();
        const res = await handler({ ...base, [field]: null });
        expect(res.isError, `${field}=null 必须是 isError`).toBe(true);
        expect(payloadOf(res)).toMatchObject({
          error: "NULL_NOT_ALLOWED",
          errorCode: "NULL_NOT_ALLOWED",
          fields: [field],
        });
        expect(call, `${field}=null 不得调用后端`).not.toHaveBeenCalled();
      }
    });

    it("省略两个字段仍成功更新，PATCH body 不带枚举键", async () => {
      const { tools, call } = capture(registerTaskUpdateTools);
      const res = await tools.get("update_task")!.handler(base);
      expect(res.isError).toBeUndefined();
      expect(call).toHaveBeenCalledWith("PATCH", `/tasks/${TASK_ID}`, { name: "renamed" });
      const body = call.mock.calls[0][2] as Record<string, unknown>;
      expect(body).not.toHaveProperty("blockStrategy");
      expect(body).not.toHaveProperty("misfireStrategy");
    });
  });
});
