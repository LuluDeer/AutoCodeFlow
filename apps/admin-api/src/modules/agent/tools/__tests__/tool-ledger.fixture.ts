import type { AgentToolCall } from "../../entities/agent-tool-call.entity";
import { AgentSessionService } from "../../runtime/agent-session.service";

/** 只替换仓储：计数、事件和就地更新都经过生产的 AgentSessionService。 */
export function toolLedger() {
  const rows: AgentToolCall[] = [];
  const matching = (where: Partial<AgentToolCall>) =>
    rows.filter((row) =>
      Object.entries(where).every(
        ([k, v]) => row[k as keyof AgentToolCall] === v,
      ),
    );
  const repo = {
    create: (row: AgentToolCall) => row,
    save: async (row: AgentToolCall) => {
      const { sessionId, toolCallId } = row;
      // 迁移 077：非 NULL 的 (sessionId, toolCallId) 唯一，第二次 INSERT 必须失败。
      if (toolCallId != null && matching({ sessionId, toolCallId }).length) {
        const constraint = "uq_agent_tool_calls_session_toolCallId";
        throw Object.assign(new Error(`duplicate key: ${constraint}`), {
          code: "23505",
          constraint,
        });
      }
      const saved = { ...row, id: `row-${rows.length + 1}` };
      rows.push(saved);
      return saved;
    },
    find: async ({ where }: { where: Partial<AgentToolCall> }) =>
      matching(where),
    findOne: async ({ where }: { where: Partial<AgentToolCall> }) =>
      matching(where)[0] ?? null,
    update: async (
      where: Partial<AgentToolCall>,
      patch: Partial<AgentToolCall>,
    ) => {
      const found = matching(where);
      found.forEach((row) => Object.assign(row, patch));
      return { affected: found.length };
    },
  };
  let totalToolCalls = 0;
  const increment = {
    update: () => increment,
    set: () => increment,
    where: () => increment,
    execute: async () => {
      totalToolCalls++;
    },
  };
  const service = new AgentSessionService(
    { createQueryBuilder: () => increment } as never,
    {} as never,
    repo as never,
    {} as never,
    {} as never,
  );
  jest.spyOn(service, "findEventSeqByRef").mockResolvedValue(null);
  const events = jest.spyOn(service, "tryAppendEvent").mockResolvedValue(null);
  return {
    service,
    rows,
    history: () => events.mock.calls.map(([, e]) => [e.kind, e.payload.status]),
    get totalToolCalls() {
      return totalToolCalls;
    },
  };
}
