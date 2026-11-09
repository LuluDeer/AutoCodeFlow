/**
 * R143（A6b）：`trigger_task` 的可选入参 `consumeNextFirePoint`。
 *
 * ## 契约（三条，全部有反证）
 *
 * ① **true ⇒ body 带 `consumeNextFirePoint: true`**（与 `params` 共存）。
 * ② **缺省 / false ⇒ 请求体与 A6b 落地前逐字节一致**：
 *    - `params` 缺失 ⇒ body 是 `{}`（**绝不**多发 `consumeNextFirePoint: false`）；
 *    - `params` 存在 ⇒ body 只有 `{ params }`。
 * ③ **既有契约不许被破坏**：`trigger_task` 的 schema **不声明** `executorId`
 *    （TriggerTaskDto 只接受 `params`），且不带 `params` 时 body 不出现任何内容。
 *
 * ## 为什么把「false 也要不发」写成断言
 *
 * 「恒发 `consumeNextFirePoint: false`」看上去等价（后端 `=== true` 判），
 * 但它**破坏「缺省 ⇒ 请求体逐字节不变」这条口径**（A6b 的验收标准就是它）：
 * 请求体多一个键 ⇒ 幂等 payload hash 变了 ⇒ 同键同参的幂等请求不再被判为
 * replay（后端把 `consumeNextFirePoint` 算进了 hash，
 * `task.controller.ts:963`）⇒ 行为漂移且难以察觉。
 * ⇒ 本文件用「body 里**没有**这个键」把这条钉死。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import { registerTaskTools } from "../tools";

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

const trigger = () => tools.get("trigger_task")!;
/** `UUID_PATH_ID` 是 z.string().uuid() ⇒ 走 SDK 解析时 taskId 必须是真 UUID。 */
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const bodyOf = (n = 0) => call.mock.calls[n]?.[2] as Record<string, unknown> | undefined;
/** 最近一次调用的 body（同一条用例里连发多次时用）。 */
const lastBody = () =>
  call.mock.calls.at(-1)?.[2] as Record<string, unknown> | undefined;

/**
 * 走一遍 MCP SDK 真正的解析：`z.object(shape).parse(args)`。
 *
 * 为什么要走这一层：SDK 把注册时的 shape 归一成 `z.object(shape)` 再 parse，
 * zod 默认**剥掉未声明的键**（strip）⇒ 一个「schema 里没声明、handler 里读了」
 * 的字段会**静默消失** ⇒ 测试直接塞 args 进 handler 永远绿。生产里发生的正是
 * 这一层，所以测试也必须走它。
 */
async function invoke(args: Record<string, unknown>) {
  const tool = trigger();
  const parsed = z.object(tool.schema).parse(args) as Record<string, unknown>;
  return tool.handler(parsed);
}

describe("trigger_task · consumeNextFirePoint（A6b）", () => {
  it("① 传 true ⇒ POST body 含 consumeNextFirePoint: true", async () => {
    await invoke({ taskId: TASK_ID, consumeNextFirePoint: true });
    expect(call).toHaveBeenCalledWith("POST", `/tasks/${TASK_ID}/trigger`, {
      consumeNextFirePoint: true,
    });
    expect(bodyOf()).toHaveProperty("consumeNextFirePoint", true);
  });

  it("① 与 params 共存 ⇒ 两个键都在（params 仍是整组覆盖）", async () => {
    await invoke({
      taskId: TASK_ID,
      params: { a: 1 },
      consumeNextFirePoint: true,
    });
    expect(bodyOf()).toEqual({ params: { a: 1 }, consumeNextFirePoint: true });
  });

  it("② 缺省 ⇒ body 不含该键（params 缺失时 body 是空对象）", async () => {
    await invoke({ taskId: TASK_ID });
    const body = bodyOf() ?? {};
    expect(body).not.toHaveProperty("consumeNextFirePoint");
    expect(Object.keys(body)).toEqual([]);
    // 与既有断言同形：params 缺失 ⇒ body 空（不是 undefined，也非 {consumeNextFirePoint:false}）
    expect(call).toHaveBeenCalledWith("POST", `/tasks/${TASK_ID}/trigger`, {});
  });

  it("② 缺省 + 有 params ⇒ body 只有 params，没有该键", async () => {
    await invoke({ taskId: TASK_ID, params: { a: 1 } });
    expect(bodyOf()).toEqual({ params: { a: 1 } });
    expect(bodyOf()).not.toHaveProperty("consumeNextFirePoint");
  });

  it("② 显式 false ⇒ 同样**不发**这个键（恒发 false 会破坏「缺省 ⇒ 逐字节不变」）", async () => {
    await invoke({ taskId: TASK_ID, consumeNextFirePoint: false });
    expect(lastBody()).not.toHaveProperty("consumeNextFirePoint");
    await invoke({ taskId: TASK_ID, params: { a: 1 }, consumeNextFirePoint: false });
    expect(lastBody()).toEqual({ params: { a: 1 } });
  });

  it("③ 既有契约：schema 不声明 executorId（TriggerTaskDto 只接受 params）", () => {
    expect(trigger().schema).not.toHaveProperty("executorId");
    expect(trigger().schema).toHaveProperty("consumeNextFirePoint");
  });

  it("③ 既有契约：只有 taskId 时 body 为空（params 缺失 ⇒ 不带 params 键）", async () => {
    await invoke({ taskId: TASK_ID });
    expect(bodyOf()).not.toHaveProperty("params");
  });

  it("description 写清语义：仅 cron / 409 / 只跳一次不是暂停", () => {
    const d = trigger().description;
    // 仅 cron 任务可用（非 cron ⇒ 400）
    expect(d).toMatch(/cron/i);
    expect(d).toMatch(/400/);
    // 已有未消耗登记 ⇒ 409
    expect(d).toMatch(/409/);
    // 只跳一次、不是暂停
    expect(d).toMatch(/one-shot|ONE-SHOT/);
    expect(d).toMatch(/not a pause|NOT a pause/i);
  });
});
