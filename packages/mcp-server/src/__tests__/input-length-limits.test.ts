/**
 * R111-A1：MCP 入参**字符串长度上限**（zod schema 层）。
 *
 * 只钉「上限本身」这三件事，不复述业务行为（行为在 tools.test.ts）：
 *   (a) 合法长值仍通过（含恰好等于上限的边界值）；
 *   (b) 超限被拒；
 *   (c) 上限**不比后端更严**——按**码点**计（后端 @MaxLength 走 validator.js
 *       isLength，减代理对；若用 zod 的 .max() 数 UTF-16 码元，128 个 emoji
 *       这种后端接受的名字会被拒）。
 *
 * 每条例子的上限出处见 tools.ts 调用点旁的注释与文件头汇总表；此处用
 * `source` 字段把出处钉在断言里，避免以后有人把数字改大/改小而没人发现。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface RegisteredTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: ToolHandler;
}

import {
  registerTaskTools,
  registerApplicationTools,
  registerDeploymentTools,
  registerAuditTools,
} from "../tools";

function setup() {
  const registered = new Map<string, RegisteredTool>();
  const call = vi.fn().mockResolvedValue({ ok: true });
  const fakeServer = {
    tool: (
      name: string,
      description: string,
      _schema: Record<string, z.ZodTypeAny>,
      fourth: ToolAnnotations | ToolHandler,
      fifth?: ToolHandler,
    ) => {
      const handler = (fifth ?? fourth) as ToolHandler;
      registered.set(name, { name, description, schema: _schema, handler });
    },
  };
  for (const fn of [
    registerTaskTools,
    registerApplicationTools,
    registerDeploymentTools,
    registerAuditTools,
  ]) {
    fn(fakeServer as never, call as never);
  }
  return { tools: registered, call };
}

let tools: Map<string, RegisteredTool>;
let call: ReturnType<typeof vi.fn>;

beforeEach(() => {
  ({ tools, call } = setup());
});

/** 取某工具某字段的 zod schema（能 .parse 即可）。 */
const field = (tool: string, key: string) => {
  const schema = tools.get(tool)?.schema;
  if (!schema) throw new Error(`tool ${tool} is not registered`);
  const s = schema[key] as { parse: (v: unknown) => unknown } | undefined;
  if (!s) throw new Error(`tool ${tool} exposes no field ${key}`);
  return s;
};

const accepts = (tool: string, key: string, value: unknown) => {
  expect(() => field(tool, key).parse(value), `${tool}.${key} should accept the value`).not.toThrow();
};

const rejects = (tool: string, key: string, value: unknown) => {
  expect(() => field(tool, key).parse(value), `${tool}.${key} should reject the value`).toThrow();
};

interface LimitCase {
  tool: string;
  key: string;
  /** 上限（码点） */
  max: number;
  /** `@MaxLength(N)` / `@IsTaskName()` 的出处（admin-api 侧 file:line） */
  source: string;
  /** 是否 optional（决定 undefined 是否合法） */
  optional: boolean;
}

const LIMITS: LimitCase[] = [
  {
    tool: "update_task",
    key: "name",
    max: 255,
    source:
      "CreateTaskDto.name @IsTaskName() (create-task.dto.ts:66-69) → TASK_NAME_MAX_LENGTH=255 (task-name.constraint.ts:43)",
    optional: true,
  },
  {
    tool: "create_task_from_template",
    key: "name",
    max: 255,
    source:
      "CreateTaskDto.name @IsTaskName() (create-task.dto.ts:66-69) → task-name.constraint.ts:43",
    optional: false,
  },
  {
    tool: "update_task",
    key: "description",
    max: 2000,
    source:
      "BACKEND HAS NO LIMIT (create-task.dto.ts:70 is @IsString() only) — client-side protection",
    optional: true,
  },
  {
    tool: "create_task_from_template",
    key: "description",
    max: 2000,
    source:
      "BACKEND HAS NO LIMIT (create-task.dto.ts:70) — client-side protection",
    optional: true,
  },
  {
    tool: "create_application",
    key: "description",
    max: 500,
    source: "CreateApplicationDto.description @MaxLength(500) (application.dto.ts:27)",
    optional: true,
  },
  {
    tool: "update_application",
    key: "description",
    max: 500,
    source:
      "UpdateApplicationDto = PartialType(CreateApplicationDto) (application.dto.ts:85) → @MaxLength(500) (:27)",
    optional: true,
  },
  {
    tool: "update_application",
    key: "webhookSecret",
    max: 256,
    source: "UpdateApplicationDto.webhookSecret @MaxLength(256) (application.dto.ts:102)",
    optional: true,
  },
  {
    tool: "deploy_application",
    key: "startCommand",
    max: 2000,
    source: "CreateDeploymentDto.startCommand @MaxLength(2000) (app-deployment.dto.ts:84)",
    optional: true,
  },
  {
    tool: "deploy_app",
    key: "startCommand",
    max: 2000,
    source: "CreateDeploymentDto.startCommand @MaxLength(2000) (app-deployment.dto.ts:84)",
    optional: true,
  },
];

describe("R111-A1 input length limits", () => {
  describe.each(LIMITS)("$tool.$key (max $max)", ({ tool, key, max, optional }) => {
    it("accepts a legal short value", () => {
      accepts(tool, key, "ok");
    });

    it("accepts a legal long value (10x shorter than the cap would suggest: exactly max)", () => {
      // (a) 合法长值仍通过 —— 恰好等于上限是最容易被「顺手改小一点」打破的边界。
      accepts(tool, key, "x".repeat(max));
    });

    it("accepts the boundary value max (off-by-one guard)", () => {
      // (c) 边界值恰好 N 必须通过（上限是「≤N」而不是「<N」）。
      accepts(tool, key, "y".repeat(max));
    });

    it("rejects max + 1", () => {
      // (b) 超限被拒
      rejects(tool, key, "z".repeat(max + 1));
    });

    it("rejects a grossly oversized value (previously unbounded)", () => {
      rejects(tool, key, "q".repeat(max * 3));
    });

    it(optional ? "undefined is still allowed" : "undefined is still required", () => {
      if (optional) accepts(tool, key, undefined);
      else rejects(tool, key, undefined);
    });
  });

  it("counts CODE POINTS, not UTF-16 units (never stricter than @MaxLength)", () => {
    // 255 个 emoji = 255 码点 = 510 UTF-16 码元。后端 taskNameLength 用
    // Array.from().length（task-name.constraint.ts:52-54）接受它；
    // 若这里写成 zod 的 .max(255)（数码元）就会拒 —— 那就是「比后端更严」，
    // 会拒掉后端接受的合法值。
    const emoji255 = "\u{1F600}".repeat(255);
    expect(emoji255.length).toBe(510);
    accepts("update_task", "name", emoji255);
    accepts("create_task_from_template", "name", emoji255);
    // 256 个码点（512 码元）仍然要被拒。
    rejects("update_task", "name", "\u{1F600}".repeat(256));
  });

  it("still forwards a legal maximum-length value to the API verbatim", async () => {
    // schema 放行不等于 handler 会带出去：钉住「合法长值真的进了请求体」。
    const longDescription = "d".repeat(500);
    await tools.get("create_application")!.handler({
      name: "app",
      version: "1.0.0",
      runtime: "node",
      description: longDescription,
    });
    expect(call).toHaveBeenCalledTimes(1);
    const [method, path, body] = call.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(method).toBe("POST");
    expect(path).toBe("/applications");
    expect(body.description).toBe(longDescription);
  });

  it("pre-existing limits are untouched (create_application.name stays 100)", () => {
    // 回归护栏：本轮只补「无上限」的字段，不得改动既有上限值。
    accepts("create_application", "name", "x".repeat(100));
    rejects("create_application", "name", "x".repeat(101));
  });

  it("fields left UNBOUNDED on purpose stay unbounded (documented 待定 set)", () => {
    // 这些字段后端只有**截断**（audit 的 slice(0,100)）或只有**格式**约束
    // （cron/timezone）——给它们拍一个数字会与后端语义分叉，故本轮刻意不动。
    // 断言「仍然接受长值」是为了让「想顺手补一个上限」的人看到这里的理由。
    accepts("list_audit_logs", "action", "a".repeat(500));
    accepts("list_audit_logs", "username", "u".repeat(500));
    accepts("update_task", "cronExpression", "0 12 * * *");
    accepts("update_task", "timezone", "Asia/Shanghai");
  });
});
