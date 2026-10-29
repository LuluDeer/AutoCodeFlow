/**
 * 会话服务单测（视频转 SOP · 交互式）。
 *
 * 三个"看起来正常、实则烧钱或骗人"的形态都在这里拦：
 *  ① 追问不收敛 → 每轮重算全部视频（必须如实报错，而不是继续问）；
 *  ② 视频无限追加 → 每轮重发的载荷线性变大（必须挡在上限）；
 *  ③ 模型输出空/畸形 → 必须报 502 语义，绝不返回 `200 + 空草稿`。
 */
import { AiSopSessionService } from "../ai-sop-session.service";
import {
  MAX_SESSION_QUESTIONS,
  MAX_SESSION_VIDEOS,
} from "../ai-sop-session.protocol";

const mediaRow = (id: string) => ({
  id,
  name: `${id}.mp4`,
  mime: "video/mp4",
  sizeBytes: 10,
  storedPath: `${id}/x.mp4`,
  uploadedBy: "user:1",
  createdAt: new Date(),
});

function harness(
  opts: {
    row?: Record<string, unknown>;
    rows?: Array<Record<string, unknown>>;
    replies?: string[];
    media?: Array<ReturnType<typeof mediaRow>>;
    /** claim 的 UPDATE 影响行数：0 = 已有回合在跑（并发提交） */
    claimAffected?: number;
    /** 让某些 mediaId 表现为"已被保留期清理" */
    missingMedia?: string[];
  } = {},
) {
  const row: Record<string, unknown> = opts.row ?? {
    id: "s-1",
    status: "active",
    messagesJson: [],
    mediaJson: [{ mediaId: "m1", name: "m1.mp4" }],
    draftJson: null,
    provider: null,
    questionsAsked: 0,
    createdBy: "user:1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const repo = {
    create: (v: unknown) => ({ ...(v as object), id: "s-1" }),
    save: jest.fn(async (v: Record<string, unknown>) => {
      Object.assign(row, v);
      return row;
    }),
    findOne: jest.fn(
      async (opts?: { where?: { id?: string; createdBy?: string } }) => {
        const where = opts?.where ?? {};
        if (where.id && row.id !== where.id) return null;
        // 归属谓词必须被真实求值：否则「他人会话」用例会假绿
        if (where.createdBy && row.createdBy !== where.createdBy) return null;
        return row;
      },
    ),
    findAndCount: jest.fn(async () => [
      opts.rows ?? [],
      (opts.rows ?? []).length,
    ]),
    // 回合锁：claim 走条件 UPDATE（affected=0 表示别人正在跑）
    createQueryBuilder: jest.fn(() => {
      const chain = {
        update: () => chain,
        set: () => chain,
        where: () => chain,
        execute: jest.fn(async () => ({
          affected: opts.claimAffected ?? 1,
        })),
      };
      return chain;
    }),
  };
  const replies = [...(opts.replies ?? [])];
  const ai = {
    signedVideoUrl: jest.fn(async (mediaId: string, name: string) => ({
      status: "ok",
      url: `https://acf.example.com/api/ai/media/${mediaId}/${name}?exp=1&sig=s`,
      // 真实语义：签发后一小时过期（用 1 会让"复用"永远不成立——
      // 会话层会把它当已过期，每轮重签，缓存就永远命中不了）
      expEpochSec: Math.floor((Date.now() + 3_600_000) / 1000),
    })),
    chatMultimodal: jest.fn(async () => {
      const next = replies.shift() ?? '{"action":"ask","question":"还有吗"}';
      return {
        content: next,
        usage: { tokensIn: 1, tokensOut: 1 },
        model: "qwen-vl-max",
        provider: "qwen-vl",
      };
    }),
    // 流式：把同一份回复拆成两段增量（真实 provider 也是这么吐的）
    chatMultimodalStream: jest.fn(
      async (_req: unknown, handlers?: { onDelta?: (t: string) => void }) => {
        const next = replies.shift() ?? '{"action":"ask","question":"还有吗"}';
        const mid = Math.floor(next.length / 2);
        handlers?.onDelta?.(next.slice(0, mid));
        handlers?.onDelta?.(next.slice(mid));
        return {
          content: next,
          usage: { tokensIn: 1, tokensOut: 1 },
          model: "qwen-vl-max",
          provider: "qwen-vl",
        };
      },
    ),
  };
  const media = {
    requireById: jest.fn(async (id: string) => {
      if ((opts.missingMedia ?? []).includes(id)) {
        // 与真实服务同文案：保留期清理后是 AI_MEDIA_NOT_FOUND
        throw new Error("视频不存在或已被清理");
      }
      const found = (
        opts.media ?? [
          mediaRow("m0"),
          mediaRow("m1"),
          mediaRow("m2"),
          mediaRow("m-new"),
        ]
      ).find((m) => m.id === id);
      if (!found) throw new Error("视频不存在或已被清理");
      return found;
    }),
  };
  const svc = new AiSopSessionService(
    repo as never,
    ai as never,
    media as never,
  );
  return { svc, row, repo, ai, media };
}

const draftReply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    action: "draft",
    title: "每日报表",
    slug: "Daily Report",
    frontMatter: { capabilities: ["browser"], acceptance: [] },
    bodyMarkdown: "## 步骤\n1. 打开报表页",
    assumptions: ["假设走浏览器"],
    ...over,
  });

describe("create —— 首轮", () => {
  it("模型追问 → 会话 active、问题入历史、剩余次数 -1", async () => {
    const h = harness({
      replies: ['{"action":"ask","question":"报表发到哪里？"}'],
    });
    const view = await h.svc.create({ mediaId: "m1", createdBy: "user:1" });

    expect(view.status).toBe("active");
    expect(view.questionsAsked).toBe(1);
    expect(view.remainingQuestions).toBe(MAX_SESSION_QUESTIONS - 1);
    expect(view.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(view.draft).toBeNull();
  });

  it("首轮就出稿 → drafted + front-matter YAML + 假设", async () => {
    const h = harness({ replies: [draftReply()] });
    const view = await h.svc.create({ mediaId: "m1", createdBy: "user:1" });

    expect(view.status).toBe("drafted");
    expect(view.draft?.title).toBe("每日报表");
    expect(view.draft?.slug).toBe("daily-report");
    expect(view.draft?.frontMatterYaml).toContain("capabilities");
    expect(view.draft?.assumptions).toEqual(["假设走浏览器"]);
    expect(view.questionsAsked).toBe(0);
  });

  it("空数组 acceptance 归一为「未填」，不报错（草稿允许留空）", async () => {
    const h = harness({ replies: [draftReply()] });
    await expect(
      h.svc.create({ mediaId: "m1", createdBy: "user:1" }),
    ).resolves.toBeTruthy();
  });

  it("front-matter 多一个键 → 502 语义的可读错误", async () => {
    const h = harness({
      replies: [draftReply({ frontMatter: { acceptance: [], evil: 1 } })],
    });
    await expect(
      h.svc.create({ mediaId: "m1", createdBy: "user:1" }),
    ).rejects.toThrow(/front-matter 不合法/);
  });

  it("模型输出空 → 400 语义（没有可用视频模型）", async () => {
    const h = harness({ replies: [""] });
    await expect(
      h.svc.create({ mediaId: "m1", createdBy: "user:1" }),
    ).rejects.toThrow(/视频理解模型/);
  });

  it("签不出直链 → 503 语义，且不调用模型", async () => {
    const h = harness({ replies: [draftReply()] });
    h.ai.signedVideoUrl.mockResolvedValueOnce({
      status: "error",
      reason: "no_secret",
      message: "AI_MEDIA_URL_SECRET 未配置",
    } as never);
    await expect(
      h.svc.create({ mediaId: "m1", createdBy: "user:1" }),
    ).rejects.toThrow(/AI_MEDIA_BASE_URL/);
    expect(h.ai.chatMultimodal).not.toHaveBeenCalled();
  });
});

describe("turn —— 追问与补录", () => {
  it("用户答一句 → 下一轮出稿（历史里能看到问答）", async () => {
    const h = harness({
      replies: ['{"action":"ask","question":"报表发到哪里？"}', draftReply()],
    });
    await h.svc.create({ mediaId: "m1", createdBy: "user:1" });
    const view = await h.svc.turn("s-1", "user:1", { text: "发到 OSS 的 reports/ 目录" });

    expect(view.status).toBe("drafted");
    expect(view.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    // 第二轮请求里必须带着上一轮的问答（否则模型会重问一遍）
    const secondReq = (h.ai.chatMultimodal as jest.Mock).mock.calls[1][0];
    const flat = JSON.stringify(secondReq.messages);
    expect(flat).toContain("报表发到哪里");
    expect(flat).toContain("OSS");
  });

  it("中途补录视频 → 计入 media，并在该轮请求里多一段 video_url", async () => {
    const h = harness({
      replies: ['{"action":"ask","question":"还有吗"}', draftReply()],
    });
    await h.svc.create({ mediaId: "m1", createdBy: "user:1" });
    const view = await h.svc.turn("s-1", "user:1", {
      mediaId: "m2",
      text: "补录了登录弹窗",
    });

    expect(view.media.map((m) => m.mediaId)).toEqual(["m1", "m2"]);
    const secondReq = (h.ai.chatMultimodal as jest.Mock).mock.calls[1][0];
    const parts = JSON.stringify(secondReq.messages);
    // 每个 video 片段在 JSON 里出现两次（type 与键名），故按 type 计数
    expect(parts.split('"type":"video_url"').length - 1).toBe(2);
  });

  it("既没文字也没视频 → 400 语义（不空跑一轮模型）", async () => {
    const h = harness();
    await expect(h.svc.turn("s-1", "user:1", {})).rejects.toThrow(/补充一句话/);
    expect(h.ai.chatMultimodal).not.toHaveBeenCalled();
  });

  it("视频超上限 → 400 语义（每轮全量重发，不能无限加）", async () => {
    const h = harness({
      row: {
        id: "s-1",
        status: "active",
        messagesJson: [],
        mediaJson: Array.from({ length: MAX_SESSION_VIDEOS }, (_v, i) => ({
          mediaId: `m${i}`,
          name: `m${i}.mp4`,
        })),
        draftJson: null,
        provider: null,
        questionsAsked: 0,
        createdBy: "user:1",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await expect(h.svc.turn("s-1", "user:1", { mediaId: "m-new" })).rejects.toThrow(
      /最多/,
    );
  });

  it("追问次数用尽后仍追问 → 如实报错（不继续烧全量视频）", async () => {
    const h = harness({
      row: {
        id: "s-1",
        status: "active",
        messagesJson: [],
        mediaJson: [{ mediaId: "m1", name: "m1.mp4" }],
        draftJson: null,
        provider: null,
        questionsAsked: MAX_SESSION_QUESTIONS,
        createdBy: "user:1",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      replies: ['{"action":"ask","question":"再问一句"}'],
    });
    await expect(h.svc.turn("s-1", "user:1", { text: "嗯" })).rejects.toThrow(/追问/);
  });

  it("会话不存在 → 404 语义", async () => {
    const h = harness();
    h.repo.findOne.mockResolvedValueOnce(null as never);
    await expect(h.svc.turn("nope", "user:1", { text: "x" })).rejects.toThrow(/不存在/);
  });
});

describe("markSaved", () => {
  it("标记 saved（保存动作由前端走既有 POST /sop，服务端只记状态）", async () => {
    const h = harness();
    const view = await h.svc.markSaved("s-1", "user:1");
    expect(view.status).toBe("saved");
    expect(h.repo.save).toHaveBeenCalled();
  });
});

describe("缓存友好（本轮新增）", () => {
  it("直链在会话内**复用**：两轮只签一次（每轮重签会让前缀缓存必然 miss）", async () => {
    const h = harness({
      replies: ['{"action":"ask","question":"还有吗"}', draftReply()],
    });
    await h.svc.create({ mediaId: "m1", createdBy: "user:1" });
    await h.svc.turn("s-1", "user:1", { text: "发到 OSS" });

    expect(h.ai.signedVideoUrl).toHaveBeenCalledTimes(1);
  });

  it("临近过期（<5 分钟）才重签，并写回新的过期时刻", async () => {
    const expiringSoon = Date.now() + 60_000;
    const h = harness({
      row: {
        id: "s-1",
        status: "active",
        messagesJson: [
          { role: "user", text: "第一段", mediaIds: ["m1"], at: "t1" },
        ],
        mediaJson: [
          {
            mediaId: "m1",
            name: "m1.mp4",
            url: "https://x/old.mp4?exp=1",
            expiresAt: expiringSoon,
          },
        ],
        draftJson: null,
        provider: null,
        questionsAsked: 0,
        createdBy: "user:1",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      replies: [draftReply()],
    });

    const view = await h.svc.turn("s-1", "user:1", { text: "继续" });
    expect(h.ai.signedVideoUrl).toHaveBeenCalledTimes(1);
    // 新链写回会话（下轮继续复用，不会每轮重签）
    const media0 = view.media[0] as unknown as {
      url?: string;
      expiresAt?: number;
    };
    expect(media0.url).toContain("sig=s");
    expect(media0.expiresAt as number).toBeGreaterThan(expiringSoon);
  });

  it("上游报告 cachedTokens 时透出（用于验证到底命中没有）", async () => {
    const h = harness({ replies: [draftReply()] });
    (h.ai.chatMultimodal as jest.Mock).mockResolvedValueOnce({
      content: draftReply(),
      usage: { tokensIn: 1000, tokensOut: 50, cachedTokens: 800 },
      model: "qwen-vl-max",
      provider: "qwen-vl",
    });
    const view = (await h.svc.create({
      mediaId: "m1",
      createdBy: "user:1",
    })) as unknown as { lastTurnUsage?: { cachedTokens?: number } };
    expect(view.lastTurnUsage?.cachedTokens).toBe(800);
  });
});

describe("流式轮次", () => {
  it("给了 onDelta 就走流式：逐段回调，落库结果与同步一致", async () => {
    const h = harness({ replies: [draftReply()] });
    const chunks: string[] = [];

    const view = await h.svc.turn("s-1", "user:1", { text: "发到 OSS 的 reports/ 目录" },
      (t) => chunks.push(t),
    );

    expect(h.ai.chatMultimodalStream).toHaveBeenCalledTimes(1);
    expect(h.ai.chatMultimodal).not.toHaveBeenCalled();
    expect(chunks.length).toBeGreaterThan(0);
    // 协议解析/落库完全一致：流只影响"何时看到字"
    expect(view.status).toBe("drafted");
    expect(view.draft?.title).toBe("每日报表");
  });
});

describe("listMine —— 会话切换器", () => {
  it("只列本人会话，并给出可读标签（草稿标题/状态/视频段数）", async () => {
    const h = harness({
      rows: [
        {
          id: "s-2",
          status: "drafted",
          messagesJson: [],
          mediaJson: [{ mediaId: "a" }, { mediaId: "b" }],
          draftJson: { title: "每日报表" },
          provider: null,
          questionsAsked: 1,
          createdBy: "user:1",
          createdAt: new Date("2026-10-01"),
          updatedAt: new Date("2026-10-02"),
        },
        {
          id: "s-1",
          status: "active",
          messagesJson: [],
          mediaJson: [{ mediaId: "a" }],
          draftJson: null,
          provider: null,
          questionsAsked: 0,
          createdBy: "user:1",
          createdAt: new Date("2026-09-30"),
          updatedAt: new Date("2026-09-30"),
        },
      ],
    });

    const out = await h.svc.listMine("user:1", { pageSize: 20 });
    expect(out.total).toBe(2);
    expect(out.items.map((i) => i.id)).toEqual(["s-2", "s-1"]);
    expect(out.items[0]).toMatchObject({
      title: "每日报表",
      mediaCount: 2,
      status: "drafted",
    });
    expect(out.items[1].title).toBeNull();
    // 归属过滤必须落在 SQL 条件上（不能拉全表再筛）
    const arg = (h.repo.findAndCount as jest.Mock).mock.calls[0][0];
    expect(arg.where).toEqual({ createdBy: "user:1" });
  });
});

describe("并发提交（回合锁）", () => {
  it("已有一轮在跑（claim 命中 0 行）→ 409，且不调用模型", async () => {
    const h = harness({ claimAffected: 0, replies: [draftReply()] });
    await expect(h.svc.turn("s-1", "user:1", { text: "再来一次" })).rejects.toThrow(
      /还在生成中/,
    );
    expect(h.ai.chatMultimodal).not.toHaveBeenCalled();
  });

  it("正常路径会释放锁（失败也要释放，否则 5 分钟内无法重试）", async () => {
    const h = harness({ replies: [draftReply()] });
    await h.svc.turn("s-1", "user:1", { text: "继续" });
    // claim + release 各一次 UPDATE
    expect(h.repo.createQueryBuilder).toHaveBeenCalledTimes(2);
  });
});

describe("保留期错配（媒体 7 天 / 会话 30 天）", () => {
  it("部分录屏已被清理 → 剔除该段并提示，其余照常推理", async () => {
    const h = harness({
      row: {
        id: "s-1",
        status: "active",
        messagesJson: [
          { role: "user", text: "两段录屏", mediaIds: ["m1", "m2"], at: "t1" },
        ],
        mediaJson: [
          { mediaId: "m1", name: "m1.mp4" },
          { mediaId: "m2", name: "m2.mp4" },
        ],
        draftJson: null,
        provider: null,
        questionsAsked: 0,
        createdBy: "user:1",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      missingMedia: ["m2"],
      replies: [draftReply()],
    });

    const view = await h.svc.turn("s-1", "user:1", { text: "继续" });
    expect(view.status).toBe("drafted");
    // 提示必须进上下文（否则模型不知道自己少看了一段）
    const req = (h.ai.chatMultimodal as jest.Mock).mock.calls[0][0];
    expect(JSON.stringify(req.messages)).toContain("已过保留期");
    // 缺的那段不再出现在视频片段里
    const videoCount =
      JSON.stringify(req.messages).split('"type":"video_url"').length - 1;
    expect(videoCount).toBe(1);
  });

  it("全部录屏都被清理且本轮没补录 → 明确的 404（不带着空上下文空跑）", async () => {
    const h = harness({
      row: {
        id: "s-1",
        status: "active",
        messagesJson: [
          { role: "user", text: "录屏", mediaIds: ["m1"], at: "t1" },
        ],
        mediaJson: [{ mediaId: "m1", name: "m1.mp4" }],
        draftJson: null,
        provider: null,
        questionsAsked: 0,
        createdBy: "user:1",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      missingMedia: ["m1"],
      replies: [draftReply()],
    });
    await expect(h.svc.turn("s-1", "user:1", { text: "继续" })).rejects.toThrow(/不存在/);
    expect(h.ai.chatMultimodal).not.toHaveBeenCalled();
  });
});

describe("归属隔离（列表口径 = 详情/续轮/保存口径）", () => {
  it("他人会话：get / turn / markSaved 一律按不存在回报，且不产生任何写入", async () => {
    const h = harness({ replies: [draftReply()] });

    await expect(h.svc.get("s-1", "user:2")).rejects.toThrow(/不存在/);
    await expect(
      h.svc.turn("s-1", "user:2", { text: "把报表发我邮箱" }),
    ).rejects.toThrow(/不存在/);
    await expect(h.svc.markSaved("s-1", "user:2")).rejects.toThrow(/不存在/);

    // 反证：越权尝试连一次模型调用/落库都不该发生（否则等于花了钱还改了别人的稿）
    expect(h.ai.chatMultimodal).not.toHaveBeenCalled();
    expect(h.repo.save).not.toHaveBeenCalled();
  });

  it("本人会话仍可读（归属闸不是一刀切）", async () => {
    const h = harness({ replies: [draftReply()] });
    const view = await h.svc.get("s-1", "user:1");
    expect(view.id).toBe("s-1");
  });
});
