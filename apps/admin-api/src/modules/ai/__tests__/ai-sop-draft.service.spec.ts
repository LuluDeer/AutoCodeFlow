/**
 * `ai-sop-draft.service` 单测：视频 → SOP 草稿的失败面。
 *
 * 这个功能的失败**极容易伪装成功**：空 content、半截 JSON、front-matter 多一个
 * 键，都可能产出一份"看起来像草稿"的东西。故每个失败分支都要给用户可解释的
 * 错误码，而不是 200 + 空草稿。
 */
import { AiSopDraftService } from "../ai-sop-draft.service";

function harness(
  opts: {
    media?: Record<string, unknown> | null;
    signed?: Record<string, unknown>;
    chat?: Record<string, unknown>;
  } = {},
) {
  const media = {
    requireById: jest.fn(
      async () =>
        opts.media ?? {
          id: "m-1",
          name: "demo.mp4",
          mime: "video/mp4",
          sizeBytes: 100,
          storedPath: "x/demo.mp4",
          uploadedBy: "user:1",
          createdAt: new Date(),
        },
    ),
  };
  const ai = {
    signedVideoUrl: jest.fn(
      async () =>
        opts.signed ?? {
          status: "ok",
          url: "https://acf.example.com/api/ai/media/m-1/demo.mp4?exp=1&sig=s",
          expEpochSec: 1,
        },
    ),
    chatMultimodal: jest.fn(
      async () =>
        opts.chat ?? {
          content: JSON.stringify({
            title: "每日报表",
            slug: "Daily Report",
            frontMatter: {
              capabilities: ["browser"],
              acceptance: [
                {
                  kind: "platform",
                  check: "task_status",
                  task: "t",
                  expect: "success",
                },
              ],
            },
            bodyMarkdown: "## 步骤\n1. 打开报表页",
          }),
          usage: { tokensIn: 1, tokensOut: 1 },
          model: "qwen-vl-max",
          provider: "qwen",
        },
    ),
  };
  const svc = new AiSopDraftService(ai as never, media as never);
  return { svc, ai, media };
}

describe("fromVideo —— 成功路径", () => {
  it("返回可编辑草稿（标题/slug/YAML/正文/模型归因）", async () => {
    const h = harness();
    const out = await h.svc.fromVideo({ mediaId: "m-1" });

    expect(out.title).toBe("每日报表");
    expect(out.slug).toBe("daily-report"); // slug 被归一
    expect(out.bodyMarkdown).toContain("打开报表页");
    expect(out.frontMatterYaml).toContain("acceptance:");
    expect(out.provider).toBe("qwen");
    expect(out.model).toBe("qwen-vl-max");
    expect(out.warnings).toEqual([]);
  });

  it("把视频直链作为 video_url + purpose=video 发给模型（provider 覆盖可透传）", async () => {
    const h = harness();
    await h.svc.fromVideo({
      mediaId: "m-1",
      providerId: "qwen-vl",
      hint: "每天 9 点跑",
    });

    const req = (h.ai.chatMultimodal as jest.Mock).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(req.purpose).toBe("video");
    expect(req.provider).toBe("qwen-vl");
    const body = JSON.stringify(req.messages);
    expect(body).toContain("video_url");
    expect(body).toContain("demo.mp4?exp=1&sig=s");
    expect(body).toContain("每天 9 点跑");
  });

  it("没有验收项/能力域 → 如实给 warning（草稿可存，但发布前必须补）", async () => {
    const h = harness({
      chat: {
        content: JSON.stringify({
          title: "t",
          slug: "t",
          frontMatter: { acceptance: [] },
          bodyMarkdown: "## 步骤\n1. x",
        }),
        usage: { tokensIn: 1, tokensOut: 1 },
        model: "qwen-vl-max",
        provider: "qwen",
      },
    });
    const out = await h.svc.fromVideo({ mediaId: "m-1" });
    expect(out.warnings.length).toBe(2);
    expect(out.warnings.join("\n")).toContain("验收项");
  });
});

describe("fromVideo —— 失败面（都要可解释，不许 200 + 空草稿）", () => {
  it("签不出直链（没配 base/secret）→ 503 语义的可读错误", async () => {
    const h = harness({
      signed: {
        status: "error",
        reason: "no_secret",
        message: "AI_MEDIA_URL_SECRET 未配置",
      },
    });
    await expect(h.svc.fromVideo({ mediaId: "m-1" })).rejects.toThrow(
      /AI_MEDIA_BASE_URL/,
    );
    expect(h.ai.chatMultimodal).not.toHaveBeenCalled();
  });

  it("模型返回空（没配视频模型，fail-open）→ 400 语义", async () => {
    const h = harness({
      chat: { content: "", usage: { tokensIn: 0, tokensOut: 0 }, model: "" },
    });
    await expect(h.svc.fromVideo({ mediaId: "m-1" })).rejects.toThrow(
      /视频理解模型/,
    );
  });

  it("输出不可解析 / 缺 title → 502 语义（可重试）", async () => {
    for (const content of [
      "不是 JSON",
      JSON.stringify({ title: "", bodyMarkdown: "x" }),
      JSON.stringify({ title: "t" }),
    ]) {
      const h = harness({
        chat: { content, usage: { tokensIn: 1, tokensOut: 1 }, model: "m" },
      });
      await expect(h.svc.fromVideo({ mediaId: "m-1" })).rejects.toThrow(
        /可解析的 SOP 草稿/,
      );
    }
  });

  it("front-matter 结构非法（多一个键）→ 502 + 具体原因", async () => {
    const h = harness({
      chat: {
        content: JSON.stringify({
          title: "t",
          slug: "t",
          frontMatter: { acceptance: [], evil: 1 },
          bodyMarkdown: "x",
        }),
        usage: { tokensIn: 1, tokensOut: 1 },
        model: "m",
      },
    });
    await expect(h.svc.fromVideo({ mediaId: "m-1" })).rejects.toThrow(
      /front-matter 不合法/,
    );
  });

  it("媒体不存在 → 404 语义（不进入模型调用）", async () => {
    const h = harness({ media: null });
    h.media.requireById.mockRejectedValueOnce(
      new Error("视频不存在或已被清理"),
    );
    await expect(h.svc.fromVideo({ mediaId: "nope" })).rejects.toThrow(
      /不存在/,
    );
    expect(h.ai.signedVideoUrl).not.toHaveBeenCalled();
  });
});
