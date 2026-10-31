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

/**
 * A1（S2 上下文压缩与记忆 §A1）：折叠摘要必须写出被折工具调用的 `toolCallId`，
 * 并点名两条只读召回通道（`get_tool_call_result` / `get_session_steps`）。
 *
 * 为什么这值得单测：摘要不写 id 时，`get_tool_call_result` 存在但**不可调用**
 * ——模型无法为「摘要里的那一行」构造入参，只能重跑工具，而有副作用的工具重跑
 * 会重复执行。id 是纯字符串拼进摘要的既有事实，必须能被机械提取且与原始 id
 * 逐字一致（错一位就等于回读打空）。
 */
describe("buildDigest · 折叠摘要写入 toolCallId 并点名召回工具（A1）", () => {
  /** 纯文本轮次（无 tool call）：每条约 200 token（800 汉字）。 */
  const bulky = (n: number): Msg[] => {
    const out: Msg[] = [msg("system", "s")];
    for (let i = 0; i < n; i += 1) {
      out.push(msg("user", `${i}`.padEnd(800, "查")));
      out.push(msg("assistant", "已处理"));
    }
    return out;
  };

  /** 早期一轮带 tool call 的调用 + 大量填充，确保该组被折进摘要。 */
  const withEarlyCall = (
    calls: Msg["tool_calls"],
    answers: string[],
  ): Msg[] => {
    const messages: Msg[] = [
      msg("system", "s"),
      msg("assistant", null, { tool_calls: calls }),
    ];
    answers.forEach((a, i) => {
      messages.push(
        msg("tool", a, { tool_call_id: calls?.[i]?.id ?? `t${i}` }),
      );
    });
    for (let i = 0; i < 20; i += 1) {
      messages.push(msg("user", `${i}`.padEnd(800, "填")));
      messages.push(msg("assistant", "ok"));
    }
    return messages;
  };

  it("每个被折 tool_call 的 id 都出现在摘要中，且可从摘要逐字回提取", () => {
    const plan = planContextWindow(
      withEarlyCall(
        [
          {
            id: "call_abc123",
            function: {
              name: "list_executors",
              arguments: '{"status":"online"}',
            },
          },
        ],
        ["3 台在线"],
      ) as never,
      { maxTokens: 1_200, minRecentMessages: 4, digestMaxChars: 1_000 },
    );

    expect(plan.foldedMessages).toBeGreaterThan(0);
    expect(plan.digest).toContain("#call_abc123");
    // 端到端形状：模型从摘要里抽出的就是 get_tool_call_result 的入参
    const ids = [...plan.digest!.matchAll(/· 调用 #(\S+) /g)].map((m) => m[1]);
    expect(ids).toEqual(["call_abc123"]);
    // id 与它那条调用的名字/应答成对出现（不能张冠李戴）
    const line = plan
      .digest!.split("\n")
      .find((l) => l.includes("#call_abc123"))!;
    expect(line).toContain("list_executors");
    expect(line).toContain("3 台在线");
    // 两条召回通道都被点名（get_session_steps 是截断后的兜底）
    expect(plan.digest).toContain("get_tool_call_result");
    expect(plan.digest).toContain("get_session_steps");
  });

  it("多个调用时 id 与各自的名字成对出现（不做两列拼接，避免错位）", () => {
    const plan = planContextWindow(
      withEarlyCall(
        [
          { id: "c1", function: { name: "list_executors", arguments: "{}" } },
          { id: "c2", function: { name: "get_task", arguments: '{"id":7}' } },
        ],
        ["在线 3 台", "任务 7 失败"],
      ) as never,
      { maxTokens: 1_200, minRecentMessages: 4, digestMaxChars: 1_000 },
    );
    const line = plan.digest!.split("\n").find((l) => l.startsWith("· 调用"))!;
    expect(line).toContain("#c1 list_executors({})");
    expect(line).toContain('#c2 get_task({"id":7})');
  });

  it("没有 tool call 的消息不产生空字段噪声（纯文本折叠仍走行式摘要）", () => {
    const plan = planContextWindow(bulky(20) as never, {
      maxTokens: 1_200,
      minRecentMessages: 4,
      digestMaxChars: 400,
    });
    expect(plan.foldedMessages).toBeGreaterThan(0);
    // 不出现"调用"行，也就不该出现任何 id 前缀
    expect(plan.digest).not.toContain("· 调用");
    // 每一行事件仍是「角色：内容」，没有悬空的 `#` / `()` 字段
    const eventLines = plan
      .digest!.split("\n")
      .filter((l) => l.startsWith("· "));
    expect(eventLines.length).toBeGreaterThan(0);
    for (const l of eventLines) {
      expect(l).toMatch(/^· (用户|助手|系统|工具结果)：/);
    }
  });

  it("tool_call 缺 id 时只写名字，不留空的 `#` 占位", () => {
    const plan = planContextWindow(
      withEarlyCall(
        [{ function: { name: "get_task", arguments: "{}" } }],
        ["ok"],
      ) as never,
      { maxTokens: 1_200, minRecentMessages: 4, digestMaxChars: 1_000 },
    );
    const line = plan.digest!.split("\n").find((l) => l.startsWith("· 调用"))!;
    expect(line).toContain("· 调用 get_task({})");
    expect(line).not.toContain("#");
  });

  it("超长摘要仍被截断到预算内，且结构没有被破坏（头部与完整行保持原格式）", () => {
    const messages: Msg[] = [msg("system", "s")];
    // 20 组带 id 的调用，足以把 600 字符的摘要顶穿
    for (let i = 0; i < 20; i += 1) {
      messages.push(
        msg("assistant", null, {
          tool_calls: [
            {
              id: `call_${i}`,
              function: { name: `tool_${i}`, arguments: `{"i":${i}}` },
            },
          ],
        }),
        msg("tool", `结果 ${i}`, { tool_call_id: `call_${i}` }),
      );
    }
    for (let i = 0; i < 20; i += 1) {
      messages.push(msg("user", `${i}`.padEnd(800, "填")));
      messages.push(msg("assistant", "ok"));
    }

    const plan = planContextWindow(messages as never, {
      maxTokens: 1_500,
      minRecentMessages: 4,
      digestMaxChars: 600,
    });
    expect(plan.digest!.length).toBeLessThanOrEqual(600);
    expect(plan.digest!.endsWith("…")).toBe(true);
    // 结构守卫：头部完整保留（截断只从尾部发生）
    expect(plan.digest!.startsWith("【早期对话摘要（确定性压缩，已省略 ")).toBe(
      true,
    );
    expect(plan.digest).toContain("get_session_steps");
    // 未被子串截断的完整个数行仍保持 `#id name(args) → answer` 的形状
    const completeLines = plan
      .digest!.split("\n")
      .filter((l) => l.startsWith("· 调用") && !l.endsWith("…"));
    expect(completeLines.length).toBeGreaterThan(0);
    for (const l of completeLines) {
      expect(l).toMatch(
        /^· 调用 #call_\d+ tool_\d+\(\{"i":\d+\}\) → 结果 \d+$/,
      );
    }
    // 截断只允许发生在**行的中间**：末尾半行必须逐字是某条真实行的前缀
    // （即没有凭空造字），且半行里出现的 id 与工具名必须同号（不错位）。
    const tail = plan.digest!.split("\n").pop()!;
    expect(tail.endsWith("…")).toBe(true);
    const partial = tail.slice(0, -1);
    const canonical = [
      ...Array.from(
        { length: 20 },
        (_, i) => `· 调用 #call_${i} tool_${i}({\"i\":${i}}) → 结果 ${i}`,
      ),
      ...Array.from({ length: 20 }, (_, i) => {
        const text = `${i}${"填".repeat(800 - `${i}`.length)}`.slice(0, 160);
        return `· 用户：${text}…`;
      }),
    ];
    expect(canonical.some((c) => c.startsWith(partial))).toBe(true);
    const paired = partial.match(/#call_(\d+) tool_(\d+)\(/);
    if (paired) expect(paired[1]).toBe(paired[2]);
  });

  it("截断不得把 `#<toolCallId>` 切成半截：半截 id 回读必然打空", () => {
    // 为什么值得单测：`#id` 是模型回读原文的**唯一句柄**。截断切在 id 中间时，
    // 模型拿到的是「格式合法、内容不存在」的 id——它会先付一次必然失败的
    // `get_tool_call_result` 往返，再改用 `get_session_steps` 兜底。逐预算扫一遍，
    // 钉住「任何截断长度下都不出现半截 # 令牌」这条不变量。
    const base = "call_abcdefghij0123456789";
    const messages: Msg[] = [msg("system", "s")];
    for (let i = 0; i < 3; i += 1) {
      messages.push(
        msg("assistant", null, {
          tool_calls: [
            {
              id: `${base}_${i}`,
              function: { name: `tool_${i}`, arguments: `{"i":${i}}` },
            },
          ],
        }),
        msg("tool", `结果 ${i}`.padEnd(200, "答"), {
          tool_call_id: `${base}_${i}`,
        }),
      );
    }
    for (let i = 0; i < 20; i += 1) {
      messages.push(msg("user", `${i}`.padEnd(800, "填")));
      messages.push(msg("assistant", "ok"));
    }

    for (let budget = 100; budget <= 900; budget += 1) {
      const plan = planContextWindow(messages as never, {
        maxTokens: 1_500,
        minRecentMessages: 4,
        digestMaxChars: budget,
      });
      const digest = plan.digest;
      if (!digest || !digest.endsWith("…")) continue;
      const body = digest.slice(0, -1);
      if (/#[^\s]*$/.test(body)) {
        throw new Error(
          `digestMaxChars=${budget} 时截断停在半截 # 令牌上：…${body.slice(-30)}`,
        );
      }
    }
  });
});

/**
 * 第 6 轮审计 P2：窗口判定不能只看消息估算——工具 schema、输出预留与
 * provider 实测 prompt token 都会占同一窗口；忽略它们会让「估算没超、
 * provider 报 400」直接打成 failed。
 */
describe("planContextWindow · 实测值与预留预算（第 6 轮审计 P2）", () => {
  const many = (n: number): Msg[] =>
    Array.from({ length: n }, (_, i) =>
      msg("user", `u${i}-${"x".repeat(800)}`),
    );

  it("reservedTokens 计入占用：消息本身不超、加上预留就超 → 折叠", () => {
    const messages = many(20);
    const withoutReserve = planContextWindow(messages as never, {
      maxTokens: 24_000,
      reservedTokens: 0,
    });
    expect(withoutReserve.foldedMessages).toBe(0);

    const withReserve = planContextWindow(messages as never, {
      maxTokens: 24_000,
      reservedTokens: 30_000,
    });
    expect(withReserve.foldedMessages).toBeGreaterThan(0);
    expect(withReserve.tokensBefore).toBeGreaterThan(24_000);
  });

  it("measuredTokens（provider 实测）高于估算时以实测为准 → 折叠", () => {
    const messages = many(20);
    const estimated = planContextWindow(messages as never, {
      maxTokens: 5_000,
    });
    expect(estimated.foldedMessages).toBe(0);

    const measured = planContextWindow(messages as never, {
      maxTokens: 5_000,
      measuredTokens: 30_000,
    });
    expect(measured.foldedMessages).toBeGreaterThan(0);
  });

  it("折叠后的 tokensAfter 同样包含预留（守卫预算口径一致）", () => {
    const plan = planContextWindow(many(20) as never, {
      maxTokens: 24_000,
      reservedTokens: 30_000,
    });
    expect(plan.foldedMessages).toBeGreaterThan(0);
    expect(plan.tokensAfter).toBeGreaterThanOrEqual(30_000);
  });
});
