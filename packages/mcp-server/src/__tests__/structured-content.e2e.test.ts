import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { withStructuredToolErrors } from "../tools";

/**
 * R34-B1（总控补）：`structuredContent` 的**端到端**验证。
 *
 * R31-E2 用 Proxy 在注册边界给工具错误补 structuredContent，但当既有用例都是
 * 「拿假 server 调 handler」——它们证明的是 **handler 被人手调用时**的行为，
 * 证不到**真实 MCP 协议往返**里 structuredContent 是否真的出现在结果里。
 * 而「注册边界」正是这层的全部意义所在：如果 SDK 在把 handler 返回值序列化成
 * protocol 结果时丢掉未知字段，那这层就是白做的，而所有单测照样绿。
 *
 * 这里用 SDK 自带的 InMemoryTransport 建一对真实链路：真 McpServer + 真 Client，
 * 走 tools/call 的完整往返。
 */
describe("R34-B1: structuredContent 经真实 MCP 协议往返", () => {
  async function connect() {
    const server = new McpServer({ name: "r34b1", version: "0.0.0" });
    const wrapped = withStructuredToolErrors(server);
    // 带 errorCode / params 的错（真实链路里由 api.ts 的 attachErrorCodeFields 挂上）
    wrapped.tool(
      "boom",
      "总是抛带码的错误",
      { id: z.string() },
      async () => {
        const err = new Error("API error (404): 任务不存在") as Error & {
          errorCode?: string;
          params?: Record<string, unknown>;
        };
        err.errorCode = "TASK_NOT_FOUND";
        err.params = { taskId: "t-1" };
        throw err;
      },
    );
    // 不带码的错：必须原样走 SDK 路径（无 structuredContent）
    wrapped.tool("plain", "总是抛无码错误", { id: z.string() }, async () => {
      throw new Error("plain failure");
    });

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "r34b1-client", version: "0.0.0" });
    await client.connect(clientT);
    return client;
  }

  it("带 errorCode 的工具错误 → isError + structuredContent（协议层真的带出来了）", async () => {
    const client = await connect();
    const res: any = await client.callTool({
      name: "boom",
      arguments: { id: "x" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toEqual({
      errorCode: "TASK_NOT_FOUND",
      params: { taskId: "t-1" },
    });
    // 文本面与 SDK 默认错误转换同款（逐字节）
    expect(res.content[0]).toEqual({
      type: "text",
      text: "API error (404): 任务不存在",
    });
  });

  it("不带码的工具错误 → structuredContent 缺省（不伪造机读面）", async () => {
    const client = await connect();
    const res: any = await client.callTool({
      name: "plain",
      arguments: { id: "x" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
  });
});
