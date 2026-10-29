/**
 * `agent-context`（推理质量轮）：上下文窗口折叠计划。
 *
 * 为什么值得单独测：折叠是「会话被上游 400 判死」与「模型失忆后重复干活」之间
 * 唯一的一根杠杆，而它的三个失败模式都不报错：
 *   ① 折掉 system → 角色与纪律丢失（模型开始自称别的身份）；
 *   ② 折掉「最近一次工具结果」→ 模型下一步重复调用同一工具（看起来像模型笨，
 *      其实是上下文被我们自己删了）；
 *   ③ 保留段以悬空 `tool` 开头 → 上游 400（tool 必须紧跟其 assistant）。
 *
 * 这里的断言全部是**结构判据**（谁被保留、谁进摘要、配对是否完整），
 * 不依赖任何 provider。
 */
import {
  DEFAULT_CONTEXT_WINDOW,
  estimateContentTokens,
  estimateMessageTokens,
  estimateTextTokens,
  estimateTokens,
  planContextWindow,
} from "./agent-context";

type Msg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

const msg = (
  role: Msg["role"],
  content: string | null,
  extra: Partial<Msg> = {},
): Msg => ({ role, content, ...extra }) as Msg;

describe("token 估算 —— 单调且量级正确", () => {
  it("CJK ≈ 1 token/字，其他 ≈ 4 字符/token", () => {
    expect(estimateTextTokens("你好世界")).toBe(4);
    expect(estimateTextTokens("abcdefgh")).toBe(2);
    expect(estimateTextTokens("")).toBe(0);
  });

  it("多模态：文本按字算，图片按固定量级（不解析二进制）", () => {
    const parts = [
      { type: "text" as const, text: "四个汉字" },
      {
        type: "image_url" as const,
        image_url: { url: "data:image/png;base64,AAA" },
      },
    ];
    const tokens = estimateContentTokens(parts as never);
    expect(tokens).toBeGreaterThan(estimateTextTokens("四个汉字"));
  });

  it("null / undefined 内容记 0（tool 空响应不该凭空占预算）", () => {
    expect(estimateContentTokens(null)).toBe(0);
    expect(estimateContentTokens(undefined)).toBe(0);
    expect(
      estimateMessageTokens(msg("tool", null) as never),
    ).toBeGreaterThanOrEqual(0);
  });

  it("总估算 = 各条之和（闸门按总和判，不是均值）", () => {
    const messages = [msg("system", "系统提示"), msg("user", "你好世界")];
    expect(estimateTokens(messages as never)).toBe(
      estimateMessageTokens(messages[0] as never) +
        estimateMessageTokens(messages[1] as never),
    );
  });
});

describe("planContextWindow —— 未超预算时零成本", () => {
  it("空数组 / 预算 <= 0 / 未超上限 → 原样返回，foldedMessages=0", () => {
    expect(planContextWindow([] as never).foldedMessages).toBe(0);

    const messages = [msg("system", "s"), msg("user", "hi")];
    const zeroBudget = planContextWindow(messages as never, { maxTokens: 0 });
    expect(zeroBudget.foldedMessages).toBe(0);
    expect(zeroBudget.digest).toBeNull();

    const roomy = planContextWindow(messages as never, { maxTokens: 10_000 });
    expect(roomy.foldedMessages).toBe(0);
    expect(roomy.messages).toHaveLength(2);
    expect(roomy.tokensAfter).toBe(roomy.tokensBefore);
  });

  it("返回的是**副本**（调用方改动不会污染原数组）", () => {
    const messages = [msg("system", "s")];
    const plan = planContextWindow(messages as never, { maxTokens: 10_000 });
    expect(plan.messages).not.toBe(messages);
    expect(plan.messages).toEqual(messages);
  });
});

describe("planContextWindow —— 超预算时折叠", () => {
  /** 造 n 轮「user 大段文本」：每条约 200 token（800 汉字）。 */
  const bulky = (n: number): Msg[] => {
    const out: Msg[] = [msg("system", "你是运维助手，只做只读操作")];
    for (let i = 0; i < n; i += 1) {
      out.push(msg("user", `${i}`.padEnd(800, "查")));
      out.push(msg("assistant", "已处理"));
    }
    return out;
  };

  it("system 恒保留在首位，摘要紧随其后（折掉 system 等于换了个 Agent）", () => {
    const plan = planContextWindow(bulky(20) as never, {
      maxTokens: 1_200,
      minRecentMessages: 4,
      digestMaxChars: 400,
    });
    expect(plan.foldedMessages).toBeGreaterThan(0);
    expect(plan.messages[0].role).toBe("system");
    expect(plan.messages[1].role).toBe("user");
    expect(String(plan.messages[1].content)).toContain("早期对话摘要");
  });

  it("折叠后 token 明显下降，且摘要声明「原始步骤仍在会话记录中」（可回读）", () => {
    const plan = planContextWindow(bulky(20) as never, {
      maxTokens: 1_200,
      minRecentMessages: 4,
      digestMaxChars: 400,
    });
    expect(plan.tokensAfter).toBeLessThan(plan.tokensBefore);
    // 措辞纪律：承诺的每个动作都真实存在（P4 起 get_tool_call_result 已实现）
    expect(plan.digest).toContain("get_tool_call_result");
    expect(plan.digest).toContain("按 id 重新调用相应工具");
    expect(plan.digest).not.toContain("可用工具回读");
  });

  it("保留段不少于 minRecentMessages 条（宁可略超估算，也不折掉刚看到的工具结果）", () => {
    const plan = planContextWindow(bulky(20) as never, {
      maxTokens: 1_200,
      minRecentMessages: 6,
      digestMaxChars: 400,
    });
    // 摘要 + 保留条数；减去 system 与摘要两条
    expect(plan.messages.length - 2).toBeGreaterThanOrEqual(6);
  });

  it("摘要内容由被折消息**确定性**生成（同输入同输出，不编造）", () => {
    const input = bulky(12);
    const opts = { maxTokens: 900, minRecentMessages: 2, digestMaxChars: 300 };
    const a = planContextWindow(input as never, opts);
    const b = planContextWindow(input as never, opts);
    expect(a.digest).toBe(b.digest);
    expect(a.foldedMessages).toBe(b.foldedMessages);
  });

  it("assistant 的 tool_calls 与其 tool 应答一起折叠，不会拆成悬空对（上游 400 的来源）", () => {
    const messages: Msg[] = [msg("system", "s")];
    // 早期一轮完整调用
    messages.push(
      msg("assistant", null, {
        tool_calls: [
          {
            id: "c1",
            function: {
              name: "list_executors",
              arguments: '{"status":"online"}',
            },
          },
        ],
      }),
      msg("tool", "3 台在线", { tool_call_id: "c1" }),
    );
    // 之后灌入大量文本把上面挤出去
    for (let i = 0; i < 20; i += 1) {
      messages.push(msg("user", `${i}`.padEnd(800, "填")));
      messages.push(msg("assistant", "ok"));
    }

    const plan = planContextWindow(messages as never, {
      maxTokens: 1_200,
      minRecentMessages: 4,
      digestMaxChars: 400,
    });
    // 摘要里如实记下「调用 + 结论」（模型据此知道查过了，不必重复查）
    expect(plan.digest).toContain("list_executors");
    expect(plan.digest).toContain("3 台在线");
    // 折叠后不得出现「没有任何 assistant 前置的 tool 消息」
    const kept = plan.messages;
    kept.forEach((m, i) => {
      if (m.role === "tool") {
        const prev = kept[i - 1];
        expect(prev?.role === "assistant" || prev?.role === "tool").toBe(true);
      }
    });
  });

  it("摘要超长按 digestMaxChars 截断（摘要自己不能无限膨胀）", () => {
    const plan = planContextWindow(bulky(30) as never, {
      maxTokens: 800,
      minRecentMessages: 2,
      digestMaxChars: 120,
    });
    expect(plan.digest!.length).toBeLessThanOrEqual(120);
    expect(plan.digest!.endsWith("…")).toBe(true);
  });

  it("全部要折叠时至少留最后一组（全折 = 让模型失忆后自问自答）", () => {
    const messages: Msg[] = [
      msg("system", "s"),
      msg("user", "第一条".padEnd(2_000, "甲")),
      msg("assistant", "最后一条结论"),
    ];
    const plan = planContextWindow(messages as never, {
      maxTokens: 50,
      minRecentMessages: 0,
      digestMaxChars: 100,
    });
    expect(plan.messages.length).toBeGreaterThanOrEqual(2);
    expect(plan.messages[plan.messages.length - 1].content).toBe(
      "最后一条结论",
    );
  });

  it("默认策略：24k 上限 / 保留 12 条 / 摘要 4k", () => {
    expect(DEFAULT_CONTEXT_WINDOW).toEqual({
      maxTokens: 24_000,
      minRecentMessages: 12,
      digestMaxChars: 4_000,
    });
  });
});
