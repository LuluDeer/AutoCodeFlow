/**
 * 会话协议单测（视频转 SOP · 交互式）。
 *
 * 协议是"问 / 出稿 / 无效"三分：判错一个，UI 就会把**问句当草稿**展示（用户
 * 以为已完成）或把**草稿当问句**（用户永远拿不到结果）。所以三种形态逐条钉死，
 * 另外钉住两条成本相关的防线（提问预算、视频上限的提示文案来源）。
 */
import {
  MAX_SESSION_QUESTIONS,
  MAX_SESSION_VIDEOS,
  SOFT_QUESTION_LIMIT,
  buildAuthoringSystemPrompt,
  composeTurnMessages,
  parseAuthoringReply,
} from "../ai-sop-session.protocol";

describe("parseAuthoringReply", () => {
  it("ask：带 question 与 needsVideo", () => {
    expect(
      parseAuthoringReply(
        '{"action":"ask","question":"报表发到哪里？","needsVideo":false}',
      ),
    ).toEqual({ kind: "ask", question: "报表发到哪里？", needsVideo: false });
  });

  it("ask 缺 question → invalid（不把空问句丢给用户）", () => {
    expect(parseAuthoringReply('{"action":"ask"}')).toMatchObject({
      kind: "invalid",
    });
  });

  it("draft：标题/slug/frontMatter/正文/假设", () => {
    const res = parseAuthoringReply(
      JSON.stringify({
        action: "draft",
        title: "每日报表",
        slug: "daily-report",
        frontMatter: { capabilities: ["browser"], acceptance: [] },
        bodyMarkdown: "## 步骤\n1. 打开",
        assumptions: ["假设报表走浏览器", "  "],
      }),
    );
    expect(res.kind).toBe("draft");
    if (res.kind === "draft") {
      expect(res.title).toBe("每日报表");
      expect(res.bodyMarkdown).toContain("打开");
      // 空白假设被剔除（前端要逐条展示给人看）
      expect(res.assumptions).toEqual(["假设报表走浏览器"]);
    }
  });

  it("缺 action 但带 bodyMarkdown → 按草稿处理，并补一条「未声明动作」提示", () => {
    const res = parseAuthoringReply('{"title":"t","bodyMarkdown":"## x"}');
    expect(res.kind).toBe("draft");
    if (res.kind === "draft") {
      expect(res.assumptions.join()).toContain("未显式声明动作");
    }
  });

  it("围栏/前后闲话都能提取", () => {
    const res = parseAuthoringReply(
      '好的：\n```json\n{"action":"ask","question":"要发邮件吗"}\n```',
    );
    expect(res).toMatchObject({ kind: "ask", question: "要发邮件吗" });
  });

  it.each([
    ["", "空内容"],
    ["   ", "空内容"],
    ["不是 JSON", "不是可解析的 JSON"],
    ['{"action":"draft"}', "缺少 bodyMarkdown"],
    ['{"action":"weird","bodyMarkdown":"x"}', "未知动作"],
  ])("非法输出 %s → invalid", (text, reasonPart) => {
    const res = parseAuthoringReply(text);
    expect(res.kind).toBe("invalid");
    if (res.kind === "invalid") expect(res.reason).toContain(reasonPart);
  });
});

describe("buildAuthoringSystemPrompt", () => {
  it("把剩余提问次数写进 prompt（模型据此收敛）", () => {
    expect(buildAuthoringSystemPrompt(5)).toContain("还可以追问 5 次");
  });

  it("低于软上限时明确要求「优先出草稿」", () => {
    expect(buildAuthoringSystemPrompt(SOFT_QUESTION_LIMIT)).toContain(
      "优先直接产出草稿",
    );
    expect(buildAuthoringSystemPrompt(SOFT_QUESTION_LIMIT + 1)).not.toContain(
      "优先直接产出草稿",
    );
  });

  it("协议样例必须是可解析的 JSON（prompt 与解析器同源）", () => {
    const prompt = buildAuthoringSystemPrompt(3);
    const askSample = prompt
      .split("\n")
      .find((l) => l.includes('"action":"ask"'));
    const draftSample = prompt
      .split("\n")
      .find((l) => l.includes('"action":"draft"'));
    expect(askSample).toBeTruthy();
    expect(draftSample).toBeTruthy();
    expect(parseAuthoringReply(askSample!).kind).toBe("ask");
    expect(parseAuthoringReply(draftSample!).kind).toBe("draft");
  });
});

describe("composeTurnMessages —— append-only（缓存友好）", () => {
  const history = [
    {
      role: "user" as const,
      text: "第一段录屏",
      mediaIds: ["m1"],
      at: "t1",
    },
    {
      role: "assistant" as const,
      text: "报表发到哪里？",
      action: "ask" as const,
      at: "t2",
    },
  ];
  const urls = { m1: "https://x/1.mp4" };

  it("system 打头；视频挂在**引入它的那条 user 消息**里（不再集中到最前面）", () => {
    const msgs = composeTurnMessages({
      systemPrompt: "S",
      history,
      mediaUrls: urls,
    });
    expect(msgs[0]).toEqual({ role: "system", content: "S" });
    expect(msgs[1].role).toBe("user");
    const parts = msgs[1].content as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ type: "text", text: "第一段录屏" });
    expect(parts.filter((p) => p.type === "video_url")).toHaveLength(1);
    expect(msgs[2]).toEqual({ role: "assistant", content: "报表发到哪里？" });
  });

  it("补录第二段时，**前缀逐字节不变**（这是缓存命中的前提）", () => {
    const turn1 = composeTurnMessages({
      systemPrompt: "S",
      history,
      mediaUrls: urls,
    });
    const turn2 = composeTurnMessages({
      systemPrompt: "S",
      history: [
        ...history,
        {
          role: "user" as const,
          text: "补录了登录弹窗",
          mediaIds: ["m2"],
          at: "t3",
        },
      ],
      mediaUrls: { m1: "https://x/1.mp4", m2: "https://x/2.mp4" },
    });

    // 老内容（system + 首条 user + 首条 assistant）必须与上一轮完全一致
    expect(turn2.slice(0, turn1.length)).toEqual(turn1);
    // 新视频出现在尾部那条 user 消息里
    const tail = turn2[turn2.length - 1].content as Array<
      Record<string, unknown>
    >;
    expect(tail.filter((p) => p.type === "video_url")).toHaveLength(1);
    expect(JSON.stringify(tail)).toContain("x/2.mp4");
  });

  it("直链缺失时退化为纯文字（不让一条坏链接毁掉整轮）", () => {
    const msgs = composeTurnMessages({
      systemPrompt: "S",
      history,
      mediaUrls: {},
    });
    expect(msgs[1]).toEqual({ role: "user", content: "第一段录屏" });
  });

  it("上限常量自洽（视频上限 > 0，硬闸 > 软闸）", () => {
    expect(MAX_SESSION_VIDEOS).toBeGreaterThan(0);
    expect(MAX_SESSION_QUESTIONS).toBeGreaterThan(SOFT_QUESTION_LIMIT);
  });
});

describe("buildAuthoringSystemPrompt", () => {
  it("把剩余提问次数写进 prompt（模型据此收敛）", () => {
    expect(buildAuthoringSystemPrompt(5)).toContain("还可以追问 5 次");
  });

  it("低于软上限时明确要求「优先出草稿」", () => {
    expect(buildAuthoringSystemPrompt(SOFT_QUESTION_LIMIT)).toContain(
      "优先直接产出草稿",
    );
    expect(buildAuthoringSystemPrompt(SOFT_QUESTION_LIMIT + 1)).not.toContain(
      "优先直接产出草稿",
    );
  });

  it("协议样例必须是可解析的 JSON（prompt 与解析器同源）", () => {
    const prompt = buildAuthoringSystemPrompt(3);
    const askSample = prompt
      .split("\n")
      .find((l) => l.includes('"action":"ask"'));
    const draftSample = prompt
      .split("\n")
      .find((l) => l.includes('"action":"draft"'));
    expect(askSample).toBeTruthy();
    expect(draftSample).toBeTruthy();
    expect(parseAuthoringReply(askSample!).kind).toBe("ask");
    expect(parseAuthoringReply(draftSample!).kind).toBe("draft");
  });
});
