import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { dump as yamlDump } from "js-yaml";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import {
  SopFrontMatterError,
  validateFrontMatter,
  type SopFrontMatter,
} from "../sop/sop-frontmatter";
import { AiService } from "./ai.service";
import { AiMediaService } from "./ai-media.service";
import { normalizeSopSlug } from "./ai-json";
import { AiSopSession } from "./entities/ai-sop-session.entity";
import {
  MAX_SESSION_QUESTIONS,
  MAX_SESSION_VIDEOS,
  buildAuthoringSystemPrompt,
  composeTurnMessages,
  parseAuthoringReply,
  type SopSessionDraft,
  type SopSessionMediaRef,
  type SopSessionMessage,
} from "./ai-sop-session.protocol";

/**
 * 视频转 SOP（交互式）：会话的每一步都在这里。
 *
 * ## 一轮 = 一次模型调用（无状态重放）
 * 每轮都把「system + 全部视频 + 完整历史」重发：视频理解 API 没有跨轮记忆，
 * 只发新增那一段会让模型丢失前因（于是反复问已经答过的事）。代价是每轮都
 * 重新推理全部视频——这正是 `MAX_SESSION_VIDEOS` / `MAX_SESSION_QUESTIONS`
 * 存在的理由。成本换取正确性，阈值在协议模块里统一。
 *
 * ## 谁能停下来
 * 只有两个终态来源：模型出稿（`draft`）或用户保存（前端调 `sopsApi.draft`
 * 后标记 `saved`）。**平台不自动发布**：acceptance 必须由人补，否则等于把
 * "没达标"写成"已达标"。
 */
/**
 * 直链复用门槛：离过期不足 5 分钟就重签。
 *
 * 为什么不每轮重签：签名含 `exp`，每轮变一次就让 provider 的前缀缓存**必然
 * miss**（同一段视频在 prompt 里成了不同字符串）。复用是缓存命中的前提，
 * 但也不能用到最后一秒——模型侧拉流可能排队，留 5 分钟余量。
 */
const MEDIA_URL_REUSE_SKEW_MS = 5 * 60 * 1000;

@Injectable()
export class AiSopSessionService {
  private readonly logger = new Logger(AiSopSessionService.name);

  constructor(
    @InjectRepository(AiSopSession)
    private readonly repo: Repository<AiSopSession>,
    private readonly ai: AiService,
    private readonly media: AiMediaService,
  ) {}

  private messages(row: AiSopSession): SopSessionMessage[] {
    return Array.isArray(row.messagesJson)
      ? (row.messagesJson as SopSessionMessage[])
      : [];
  }

  private mediaRefs(row: AiSopSession): SopSessionMediaRef[] {
    return Array.isArray(row.mediaJson)
      ? (row.mediaJson as SopSessionMediaRef[])
      : [];
  }

  private view(row: AiSopSession) {
    return {
      id: row.id,
      status: row.status,
      messages: this.messages(row),
      media: this.mediaRefs(row),
      draft: (row.draftJson as unknown as SopSessionDraft | null) ?? null,
      provider: row.provider,
      questionsAsked: row.questionsAsked,
      remainingQuestions: Math.max(
        0,
        MAX_SESSION_QUESTIONS - row.questionsAsked,
      ),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * 列出会话（只列**本人**的：会话里有录屏与业务细节，跨用户可见是越权）。
   *
   * 返回精简视图（不含 messages——列表页只要"能认出是哪一次"，消息在详情里取）：
   * 状态、最近更新时间、视频段数、草稿标题。
   */
  async listMine(
    createdBy: string,
    opts: { page?: number; pageSize?: number } = {},
  ): Promise<{
    items: Array<{
      id: string;
      status: string;
      createdAt: Date;
      updatedAt: Date;
      mediaCount: number;
      title: string | null;
    }>;
    total: number;
  }> {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const pageSize = Math.min(50, Math.max(1, Math.floor(opts.pageSize ?? 20)));
    const [rows, total] = await this.repo.findAndCount({
      where: { createdBy },
      order: { updatedAt: "DESC" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        mediaCount: this.mediaRefs(row).length,
        title:
          (row.draftJson as { title?: unknown } | null)?.title &&
          typeof (row.draftJson as { title?: unknown }).title === "string"
            ? String((row.draftJson as { title?: string }).title)
            : null,
      })),
      total,
    };
  }

  /**
   * 抢占本轮（跨实例安全）。
   *
   * 判据是**单条条件 UPDATE**：只有"没锁"或"陈旧锁（>5 分钟）"才抢得到，
   * 命中 0 行即别人正在跑 → 409。用 DB 而不是进程内 Set，是因为本仓支持多副本
   * （内存锁在多实例下等于没有）；5 分钟自动过期则保证进程崩溃不会留下死锁。
   */
  private async claimTurn(id: string): Promise<void> {
    const res = await this.repo
      .createQueryBuilder()
      .update(AiSopSession)
      .set({ turnLockedAt: () => "now()" })
      .where(
        `id = :id AND ("turnLockedAt" IS NULL OR "turnLockedAt" < now() - interval '5 minutes')`,
        { id },
      )
      .execute();
    if (!res.affected) {
      throw new AppError(ErrorCode.AI_SOP_TURN_IN_PROGRESS, { id });
    }
  }

  private async releaseTurn(id: string): Promise<void> {
    try {
      await this.repo
        .createQueryBuilder()
        .update(AiSopSession)
        .set({ turnLockedAt: null })
        .where("id = :id", { id })
        .execute();
    } catch (err) {
      // 释放失败不改变已发生的事实；陈旧锁会在 5 分钟后自然失效
      this.logger.warn(
        `SOP session unlock failed: id=${id} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async requireById(id: string): Promise<AiSopSession> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) {
      throw new AppError(ErrorCode.AI_SOP_SESSION_NOT_FOUND, { id });
    }
    return row;
  }

  async get(id: string) {
    return this.view(await this.requireById(id));
  }

  /** 建会话并立刻跑第一轮（模型可能追问，也可能直接出稿）。 */
  async create(input: {
    mediaId: string;
    hint?: string;
    providerId?: string;
    createdBy: string;
  }) {
    const media = await this.media.requireById(input.mediaId);
    const row = await this.repo.save(
      this.repo.create({
        status: "active",
        messagesJson: [],
        mediaJson: [{ mediaId: media.id, name: media.name }],
        draftJson: null,
        provider: input.providerId?.trim() || null,
        questionsAsked: 0,
        createdBy: input.createdBy,
      }),
    );
    return this.runTurn(row, {
      text:
        (input.hint ?? "").trim() ||
        "这是我的一段操作录屏，请帮我转成可执行的 SOP。",
      // 首段视频同样要挂在**这条消息**上：compose 是 append-only，
      // 视频跟着"引入它的那一条"走（否则首段视频在后续轮次里根本不会被带上）
      mediaId: media.id,
    });
  }

  /** 追加用户一轮（文字和/或一段新视频），然后跑一轮模型。 */
  async turn(
    id: string,
    input: { text?: string; mediaId?: string },
    onDelta?: (text: string) => void,
  ) {
    const row = await this.requireById(id);
    const text = (input.text ?? "").trim();
    if (!text && !input.mediaId) {
      throw new AppError(ErrorCode.AI_SOP_NO_INPUT);
    }
    await this.claimTurn(row.id);
    try {
      return await this.runTurn(
        row,
        {
          text,
          mediaId: input.mediaId ?? null,
        },
        onDelta,
      );
    } finally {
      await this.releaseTurn(row.id);
    }
  }

  /** 标记已保存（前端在 POST /sop 成功后调用；不改变模型侧任何事实）。 */
  async markSaved(id: string) {
    const row = await this.requireById(id);
    row.status = "saved";
    await this.repo.save(row);
    return this.view(row);
  }

  // ── 内部：真正的"一轮" ─────────────────────────────────────────

  private async runTurn(
    row: AiSopSession,
    input: { text: string; mediaId: string | null },
    onDelta?: (text: string) => void,
  ) {
    const messages = this.messages(row);
    let mediaRefs = [...this.mediaRefs(row)];

    // 保留期错配（媒体 7 天 / 会话 30 天）：老会话引用的录屏可能已被清理。
    // 逐条确认存在性——缺的从本轮剔除（其余视频与文字照常推理），全缺才报错。
    // 不静默：模型看不到视频却"继续编"比直接失败更糟。
    const alive: typeof mediaRefs = [];
    let missing = 0;
    for (const ref of mediaRefs) {
      try {
        await this.media.requireById(ref.mediaId);
        alive.push(ref);
      } catch {
        missing += 1;
        this.logger.warn(
          `SOP session ${row.id}: 录屏 ${ref.mediaId} 已过保留期，本轮跳过`,
        );
      }
    }
    if (missing > 0) {
      mediaRefs = alive;
      if (mediaRefs.length === 0 && !input.mediaId) {
        throw new AppError(ErrorCode.AI_MEDIA_NOT_FOUND, {
          mediaId: "（本会话的录屏均已过保留期）",
        });
      }
      messages.push({
        role: "user",
        text: `（提示：${missing} 段录屏已过保留期，已从本轮剔除；如需重新分析请补录。）`,
        at: new Date().toISOString(),
      });
    }

    if (input.mediaId) {
      const media = await this.media.requireById(input.mediaId);
      if (!mediaRefs.some((m) => m.mediaId === media.id)) {
        if (mediaRefs.length >= MAX_SESSION_VIDEOS) {
          throw new AppError(ErrorCode.AI_SOP_VIDEO_LIMIT, {
            max: MAX_SESSION_VIDEOS,
          });
        }
        mediaRefs.push({ mediaId: media.id, name: media.name });
      }
    }

    messages.push({
      role: "user",
      text: input.text || "（补充了一段录屏）",
      ...(input.mediaId ? { mediaIds: [input.mediaId] } : {}),
      at: new Date().toISOString(),
    });

    const remaining = Math.max(0, MAX_SESSION_QUESTIONS - row.questionsAsked);
    const systemPrompt = buildAuthoringSystemPrompt(remaining);

    // 直链：**会话内复用**（缓存友好、少一次签名），仅在临近过期/缺失时重签
    const mediaUrls: Record<string, string> = {};
    const nowMs = Date.now();
    for (const ref of mediaRefs) {
      const reusable =
        typeof ref.url === "string" &&
        ref.url.length > 0 &&
        typeof ref.expiresAt === "number" &&
        ref.expiresAt - nowMs > MEDIA_URL_REUSE_SKEW_MS;
      if (reusable) {
        mediaUrls[ref.mediaId] = ref.url as string;
        continue;
      }
      const signed = await this.ai.signedVideoUrl(ref.mediaId, ref.name);
      if (signed.status === "error") {
        throw new AppError(ErrorCode.AI_VIDEO_LINK_UNAVAILABLE, {
          reason: signed.message,
        });
      }
      ref.url = signed.url;
      ref.expiresAt = signed.expEpochSec * 1000;
      mediaUrls[ref.mediaId] = signed.url;
    }

    const request = {
      purpose: "video" as const,
      ...(row.provider ? { provider: row.provider } : {}),
      messages: composeTurnMessages({
        systemPrompt,
        history: messages,
        mediaUrls,
      }) as never,
    };
    // 有 onDelta 就走流式（慢轮次先给人看字）；协议解析与落库完全一致
    const res = onDelta
      ? await this.ai.chatMultimodalStream(request, { onDelta })
      : await this.ai.chatMultimodal(request);

    const usage = res.usage;
    this.logger.log(
      `SOP session turn: id=${row.id} provider=${res.provider ?? "?"} model=${res.model} ` +
        `promptTokens=${usage.tokensIn} cachedTokens=${usage.cachedTokens ?? 0}`,
    );

    if (!res.content.trim()) {
      throw new AppError(ErrorCode.AI_VIDEO_MODEL_UNAVAILABLE, {
        provider: row.provider ?? "",
      });
    }

    const parsed = parseAuthoringReply(res.content);

    if (parsed.kind === "invalid") {
      throw new AppError(ErrorCode.AI_DRAFT_UNPARSABLE);
    }

    if (parsed.kind === "ask") {
      if (row.questionsAsked >= MAX_SESSION_QUESTIONS) {
        // 硬闸：继续问 = 每轮重算全部视频。让用户补信息或换更强的模型。
        throw new AppError(ErrorCode.AI_SOP_QUESTIONS_EXHAUSTED, {
          max: MAX_SESSION_QUESTIONS,
        });
      }
      messages.push({
        role: "assistant",
        text: parsed.question,
        action: "ask",
        at: new Date().toISOString(),
      });
      row.messagesJson = messages;
      row.mediaJson = mediaRefs;
      row.questionsAsked += 1;
      row.status = "active";
      await this.repo.save(row);
      return {
        ...this.view(row),
        needsVideo: parsed.needsVideo,
        lastTurnUsage: usage,
      };
    }

    // ── 出稿 ────────────────────────────────────────────────────
    const rawFrontMatter = { ...parsed.frontMatter };
    if (
      Array.isArray(rawFrontMatter.acceptance) &&
      rawFrontMatter.acceptance.length === 0
    ) {
      // 空数组 ≡ 未填（草稿级校验不允许空数组），归一成"留空待补"
      delete rawFrontMatter.acceptance;
    }
    let frontMatter: SopFrontMatter;
    try {
      frontMatter = validateFrontMatter(rawFrontMatter, { strict: false });
    } catch (err) {
      const detail =
        err instanceof SopFrontMatterError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      throw new AppError(ErrorCode.AI_DRAFT_FRONTMATTER_INVALID, { detail });
    }

    const title = (parsed.title ?? "").slice(0, 255).trim();
    if (!title) throw new AppError(ErrorCode.AI_DRAFT_UNPARSABLE);

    const draft: SopSessionDraft = {
      title,
      slug:
        normalizeSopSlug(parsed.slug) ||
        normalizeSopSlug(title) ||
        `sop-${Date.now().toString(36)}`,
      frontMatterYaml: yamlDump(frontMatter, { noRefs: true }).trim(),
      bodyMarkdown: parsed.bodyMarkdown,
      assumptions: parsed.assumptions,
      provider: res.provider ?? "",
      model: res.model,
    };

    messages.push({
      role: "assistant",
      text: `已生成草稿：${draft.title}`,
      action: "draft",
      at: new Date().toISOString(),
    });

    row.messagesJson = messages;
    row.mediaJson = mediaRefs;
    row.draftJson = draft as unknown as Record<string, unknown>;
    row.status = "drafted";
    await this.repo.save(row);

    this.logger.log(
      `SOP session drafted: id=${row.id} questions=${row.questionsAsked} videos=${mediaRefs.length} model=${draft.model}`,
    );
    return { ...this.view(row), lastTurnUsage: usage };
  }
}
