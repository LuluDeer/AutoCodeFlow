import {
  AgentSessionService,
  redactEventBodyText,
  redactForStorage,
} from "../agent-session.service";
import { sanitizeResult } from "../../tools/agent-sanitize.util";

/**
 * Agent 主表**写入点脱敏**（R2b：注释不许与代码相反）。
 *
 * ## 这组用例守的是什么
 *
 * `entities/agent-step.entity.ts` 的列注释逐字写着「消息正文。**已脱敏**」，
 * 而实现是 `content: input.content ?? null`——**原样写入、零脱敏**。
 * 工具行的 `errorMessage` 同样如此。⇒ 主表（`agent_steps` /
 * `agent_tool_calls`）是**明文长期留存面**。
 *
 * 为什么主表比事件表更关键（保留期 + 读面）：
 *   · **保留期**：事件表固定 180 天；主表分档且**不完整**——终态会话的 steps
 *     只留 90 天、read 档 tool_calls 只留 30 天，而**非终态会话**的 steps /
 *     read 档 tool_calls 压根不在清理谓词内（谓词要求会话终态）⇒ 那部分事实上
 *     **没有保留期**；write/dangerous 档 180 天。明文在主表里的暴露窗口不短于
 *     事件表，在无保留期那部分反而更长。
 *   · **读面**：主表是**被读回来再外发**的权威源——`rebuildMessages` 把
 *     `step.content` 与台账行 `errorMessage` 回灌给模型、会话导出/详情 API
 *     原样返回 steps 与 toolCalls、投影在事件正文缺失时回读主表行。
 *     事件表那份脱敏副本管不到这三跳。
 *
 * ## 断言的是「真正要落库的那一行」
 *
 * 断言对象是**写入口交给仓储的那份对象字面量**（`em.create` / `repo.create` /
 * `repo.update` 的实参），不是脱敏函数的返回值——脱敏函数返回对而写入口
 * 忘了调用它，是这个缺陷的真实形态。
 */

/** TypeORM 链式桩。 */
function qbChain(result: unknown = { affected: 1 }) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    "update",
    "set",
    "where",
    "andWhere",
    "orWhere",
    "orderBy",
    "skip",
    "take",
    "select",
    "delete",
    "from",
  ]) {
    qb[m] = jest.fn().mockReturnThis();
  }
  qb.execute = jest.fn(async () => result);
  qb.getRawOne = jest.fn(async () => ({ maxSeq: 2 }));
  qb.getRawMany = jest.fn(async () => []);
  qb.getManyAndCount = jest.fn(async () => [[{ id: "row-1" }], 1]);
  return qb;
}

type Any = Record<string, any>;

function harness() {
  const sessionQb = qbChain();
  const listQb = qbChain();
  const sessions: Any = {
    create: jest.fn((v: unknown) => ({ id: "s-new", ...(v as object) })),
    save: jest.fn(async (v: unknown) => ({ ...(v as object), id: "s-new" })),
    findOne: jest.fn(async () => ({ id: "s-1", status: "running" })),
    update: jest.fn(async () => ({ affected: 1 })),
    find: jest.fn(async () => []),
    createQueryBuilder: jest.fn((alias?: string) =>
      alias === "s" ? listQb : sessionQb,
    ),
    manager: {
      transaction: jest.fn(async (cb: (em: unknown) => Promise<unknown>) =>
        cb(em),
      ),
    },
  };
  const emQb = qbChain();
  const em: Any = {
    createQueryBuilder: jest.fn(() => emQb),
    // ★ 断言点：em.create 的实参就是**将要落库的 step 行**
    create: jest.fn((_cls: unknown, v: Any) => ({ id: "step-3", ...v })),
    save: jest.fn(async (v: unknown) => v),
    findOne: jest.fn(async () => null),
  };
  const toolCalls: Any = {
    // ★ 断言点：create 的实参就是**将要落库的台账行**
    create: jest.fn((v: unknown) => ({ id: "tc-1", ...(v as object) })),
    save: jest.fn(async (v: unknown) => v),
    find: jest.fn(async () => []),
    update: jest.fn(async () => ({ affected: 1 })),
  };
  const svc = new AgentSessionService(
    sessions as never,
    { find: jest.fn(async () => []) } as never,
    toolCalls as never,
    {
      resolveBudget: jest.fn(() => ({
        maxSteps: 40,
        maxTokens: 1000,
        wallClockMs: 60000,
        maxToolCalls: 20,
      })),
    } as never,
    {
      sessionFinished: jest.fn(async () => undefined),
      staleSweepConverged: jest.fn(async () => undefined),
    } as never,
  );
  return { svc, sessions, em, emQb, toolCalls };
}

/** 取 `em.create(Entity, { … })` 真正落库的那份对象字面量。 */
function createdStep(h: ReturnType<typeof harness>): Any {
  const call = h.em.create.mock.calls.at(-1) as [unknown, Any];
  return call[1];
}

/** 取 `toolCalls.create({ … })` 真正落库的那份对象字面量。 */
function createdToolCall(h: ReturnType<typeof harness>): Any {
  const call = h.toolCalls.create.mock.calls.at(-1) as [Any];
  return call[0];
}

/** 取 `toolCalls.update(where, patch)` 的 patch。 */
function updatedToolCall(h: ReturnType<typeof harness>): Any {
  const call = h.toolCalls.update.mock.calls.at(-1) as [Any, Any];
  return call[1];
}

describe("AgentSessionService · 主表写入点脱敏（R2b：注释不许与代码相反）", () => {
  it("① 步 content 含凭据 ⇒ 落库的正文里无明文", async () => {
    const h = harness();
    const secret = "sk-live-9f3c2a71b4";
    await h.svc.appendStep("s-1", {
      role: "assistant",
      content:
        `调用 http://api.local/x?token=${secret} ` +
        `并附带 apiKey=${secret} 以及 Authorization: Bearer ${secret}`,
    });

    const row = createdStep(h);
    // 库里那一行**没有明文**
    expect(row.content).not.toContain(secret);
    expect(row.content).not.toContain("sk-live");
    // 打码标记在
    expect(row.content).toContain("token=[REDACTED]");
    expect(row.content).toContain("apiKey=[REDACTED]");
    // 全大写 env 形态同样被拦（规则集是并集，不是单条规则）
    expect(
      (await h.svc.appendStep("s-1", {
        role: "assistant",
        content: "AUTOFLOW_TOKEN=abc123",
      }),
      createdStep(h).content),
    ).toBe("AUTOFLOW_TOKEN=[REDACTED]");
  });

  it("② 工具行 errorMessage 含凭据 ⇒ 落库的台账行里无明文（三条写入路径各一条）", async () => {
    const h = harness();
    const secret = "ghp_abcdefghij0123456789";

    // ②a 插入路径（recordToolCall）
    await h.svc.recordToolCall({
      sessionId: "s-1",
      toolName: "get_executor",
      tier: "read",
      status: "error",
      errorMessage: `上游返回 401：Authorization: Bearer ${secret}`,
    });
    const inserted = createdToolCall(h);
    expect(inserted.errorMessage).not.toContain(secret);
    expect(inserted.errorMessage).toContain("[REDACTED]");

    // ②b 就地更新路径（updateToolCallByToolCallId）
    await h.svc.updateToolCallByToolCallId("s-1", "call-1", {
      toolName: "get_executor",
      tier: "read",
      status: "error",
      errorMessage: `重试失败：token=${secret}`,
    });
    const updated = updatedToolCall(h);
    expect(updated.errorMessage).not.toContain(secret);
    expect(updated.errorMessage).toContain("token=[REDACTED]");

    // ②c 审批拒绝 settle 路径（settleToolCallByApprovalId）
    await h.svc.settleToolCallByApprovalId(
      "apr-s-1-x",
      "denied",
      `已被 admin 人工拒绝（审批单 apr-s-1-x）——apiKey=${secret}`,
    );
    const settled = updatedToolCall(h);
    expect(settled.errorMessage).not.toContain(secret);
    expect(settled.errorMessage).toContain("apiKey=[REDACTED]");
    // 拒绝文案的**语义部分**必须还在（脱敏不许把整句话吃掉）
    expect(settled.errorMessage).toContain("已被 admin 人工拒绝");
  });

  it("③ 正常正文不被误伤（防空转断言：脱敏不许改普通文本）", async () => {
    const h = harness();
    const plain = "查 task-1 的执行记录：最近一次是失败，exitCode=2，retries=3";
    await h.svc.appendStep("s-1", { role: "assistant", content: plain });
    // 逐字保留
    expect(createdStep(h).content).toBe(plain);

    // 普通错误文案逐字保留
    const plainErr = "重试 3 次后放弃：连接超时";
    await h.svc.recordToolCall({
      sessionId: "s-1",
      toolName: "get_task",
      tier: "read",
      status: "error",
      errorMessage: plainErr,
    });
    expect(createdToolCall(h).errorMessage).toBe(plainErr);

    // 审批拒绝文案（内含审批单 key，不该被吃掉）
    const denyMsg = "已被 admin 人工拒绝（审批单 apr-s-1-x）——不得重试同一调用";
    await h.svc.settleToolCallByApprovalId("apr-s-1-x", "denied", denyMsg);
    expect(updatedToolCall(h).errorMessage).toBe(denyMsg);
  });

  it("④ resultJson 不被二次脱敏（上游已过 sanitizeResult ⇒ 本层原样落库）", async () => {
    const h = harness();
    // 上游（ToolExecutorService）落库前的形态：**已脱敏**的成品。
    const upstream = sanitizeResult({
      env: "AUTOFLOW_TOKEN=[REDACTED]",
      password: "[REDACTED]",
      taskId: "task-42",
    });
    expect(upstream).toEqual({
      env: "AUTOFLOW_TOKEN=[REDACTED]",
      password: "[REDACTED]",
      taskId: "task-42",
    });

    await h.svc.recordToolCall({
      sessionId: "s-1",
      toolName: "get_executor",
      tier: "read",
      status: "ok",
      result: upstream as Record<string, unknown>,
    });

    // 落库的那份与上游**逐字节相同**（本层没有再跑一遍 sanitizeResult）
    expect(createdToolCall(h).resultJson).toEqual(upstream);
    // 反证：若本层再脱敏一次，`AUTOFLOW_TOKEN=[REDACTED]` 会被 env 规则
    // 二次命中（`[^\s\n]+` 吃掉整个值）——成品不再等于上游。
    expect(JSON.stringify(createdToolCall(h).resultJson)).toBe(
      JSON.stringify(upstream),
    );
  });

  it("⑤ null / 缺省不被脱敏函数改变（空值语义保持）", async () => {
    const h = harness();
    await h.svc.appendStep("s-1", { role: "user" });
    expect(createdStep(h).content).toBeNull();

    await h.svc.recordToolCall({
      sessionId: "s-1",
      toolName: "get_task",
      tier: "read",
      status: "ok",
    });
    expect(createdToolCall(h).errorMessage).toBeNull();
  });

  it("⑥ 主表正文**只打码不截断**：超长正文完整落库（事件表才有 4000 上限）", () => {
    // 为什么单独钉这一条：`sanitizeString` 自带 `maxLength: 4000`（为**事件 payload** 设计的封顶）。
    // 若主表误用它，>4000 字的模型回复会在库里**丢掉尾部**——那是「用丢数据换安全」。
    // 2026-11-02 实测踩到过：主表曾直接调 redactEventBodyText ⇒ 9022 字被截成 4000。
    const long = "y".repeat(9000) + " apiKey=sk-live-abc123";
    const stored = redactForStorage(long);
    // 未截断：长度 = 原文 − 凭据替换的字节差（`sk-live-abc123` 14 → `[REDACTED]` 10 = −4）
    expect(stored.length).toBe(long.length - 4);
    expect(stored.length).toBeGreaterThan(4000);
    // 仍然打码
    expect(stored).not.toContain("sk-live-abc123");
    expect(stored).toContain("[REDACTED]");
    // 对照：事件路径**该**截断（那是有界审计面）
    expect(redactEventBodyText(long).length).toBe(4000);
  });
});
