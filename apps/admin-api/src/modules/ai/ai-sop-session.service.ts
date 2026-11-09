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
    // 上界与 PageQueryDto / sop.service 同口径（10000）：没有上界时
    // `?page=99999999` 会生成 skip≈5e9 的深 OFFSET，并额外跑一次全量
    // COUNT(*)，足以把连接池钉满。
    const page = Math.min(10000, Math.max(1, Math.floor(opts.page ?? 1)));
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
  /**
   * 抢占本轮（跨实例安全）。**返回本次抢到的 token**（= 写入的 `turnLockedAt` 值）。
   *
   * ## R184：返回值是**释放时的围栏**，必须一路传到 `releaseTurn`
   *
   * ### 病（审计 A-2 的前半）
   * 旧 `releaseTurn` 的谓词只有 `id = :id`、**没有 token** ⇒ 它释放的是**任何持有者**的锁：
   * ① 第 1 轮超过 5 分钟租约（每轮是全量视频推理，几十秒到几分钟很正常）；
   * ② 第 2 轮夺得锁（陈旧锁可抢）；
   * ③ 第 1 轮 `finally` 调 `releaseTurn` ⇒ **把第 2 轮的锁清掉** ⇒
   * ④ 第 3 个请求立刻又能抢到 ⇒ **两轮并发跑、各自用快照写回 ⇒ 后写者静默覆盖**。
   *
   * ### 修法：`RETURNING` 取回**数据库生成**的那个时间戳当 token
   * 用 `now()` 生成（不改成 JS 时间 —— 那会引入实例间**时钟偏移**，让 5 分钟窗口跟着漂）；
   * 再用 `RETURNING "turnLockedAt"` 把它**读回来**，释放时 `WHERE id AND "turnLockedAt" = :token`。
   * ⇒ 只有**当前持有者**能释放自己的锁；过期的旧持有者释放**0 行**，**不碰别人的锁**。
   */
  private async claimTurn(id: string): Promise<Date> {
    const res = await this.repo
      .createQueryBuilder()
      .update(AiSopSession)
      .set({ turnLockedAt: () => "now()" })
      .where(
        `id = :id AND ("turnLockedAt" IS NULL OR "turnLockedAt" < now() - interval '5 minutes')`,
        { id },
      )
      .returning('"turnLockedAt"')
      .execute();
    if (!res.affected) {
      throw new AppError(ErrorCode.AI_SOP_TURN_IN_PROGRESS, { id });
    }
    const token = (res.raw?.[0] as { turnLockedAt?: Date } | undefined)
      ?.turnLockedAt;
    if (!token) {
      // 拿不到 token 就**不能**继续：没有围栏的释放会误清别人的锁（就是本函数要修的病）。
      // ⇒ 结构性问题，直接抛（宁可本轮失败也不要留下「无围栏释放」）。
      throw new AppError(ErrorCode.AI_SOP_TURN_IN_PROGRESS, { id });
    }
    return token;
  }

  /**
   * 释放本轮锁。**必须带 claim 时拿到的 token**（R184 围栏）。
   *
   * 谓词 = `id AND "turnLockedAt" = :token` ⇒ **只释放自己那一把**。
   * 过期的旧持有者（租约已被别人接管）在这里命中 **0 行**，**不会清掉新持有者的锁**
   * —— 这正是旧实现（只有 `id = :id`）的病。
   */
  private async releaseTurn(id: string, token: Date): Promise<void> {
    try {
      await this.repo
        .createQueryBuilder()
        .update(AiSopSession)
        .set({ turnLockedAt: null })
        .where('id = :id AND "turnLockedAt" = :token', { id, token })
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

  /**
   * 归属校验（列表已经按 `createdBy` 隔离，详情/续轮/保存必须同口径）。
   *
   * 判据与 `listMine` 完全一致：`createdBy = 'user:<id>'`。不匹配一律按
   * **不存在**回报（同一个 AI_SOP_SESSION_NOT_FOUND）——返回 403 等于确认
   * 「这个 uuid 存在但属于别人」，把私有会话的存在性泄漏出去。
   *
   * 为什么不留「不传 owner 就跳过」的旁路：那会让新增调用点默认无保护，
   * 而这正是本方法要修的历史形态（列表有闸、三个端点没有）。
   */
  async requireOwned(id: string, owner: string): Promise<AiSopSession> {
    const row = await this.repo.findOne({ where: { id, createdBy: owner } });
    if (!row) {
      throw new AppError(ErrorCode.AI_SOP_SESSION_NOT_FOUND, { id });
    }
    return row;
  }

  async get(id: string, owner: string) {
    return this.view(await this.requireOwned(id, owner));
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
    // R185：`create()` 也 claim（哪怕 id 是刚生成的）—— 为的是让 `runTurn` 的落库
    // **在两条路径上有同一个围栏**。不 claim 的话 `runTurn` 里那两处写就只能退化成
    // 「无谓词整行写」，而那正是审计 A-2 的另一半（见 `runTurn` 的落库注释）。
    const createdToken = await this.claimTurn(row.id);
    try {
      return await this.runTurn(
        row,
        {
          text:
            (input.hint ?? "").trim() ||
            "这是我的一段操作录屏，请帮我转成可执行的 SOP。",
          // 首段视频同样要挂在**这条消息**上：compose 是 append-only，
          // 视频跟着"引入它的那一条"走（否则首段视频在后续轮次里根本不会被带上）
          mediaId: media.id,
        },
        undefined,
        createdToken,
      );
    } finally {
      await this.releaseTurn(row.id, createdToken);
    }
  }

  /** 追加用户一轮（文字和/或一段新视频），然后跑一轮模型。 */
  async turn(
    id: string,
    owner: string,
    input: { text?: string; mediaId?: string },
    onDelta?: (text: string) => void,
  ) {
    const row = await this.requireOwned(id, owner);
    const text = (input.text ?? "").trim();
    if (!text && !input.mediaId) {
      throw new AppError(ErrorCode.AI_SOP_NO_INPUT);
    }
    const turnToken = await this.claimTurn(row.id);
    try {
      return await this.runTurn(
        row,
        {
          text,
          mediaId: input.mediaId ?? null,
        },
        onDelta,
        turnToken,
      );
    } finally {
      await this.releaseTurn(row.id, turnToken);
    }
  }

  /**
   * 标记已保存（前端在 POST /sop 成功后调用；**不改变模型侧任何事实**）。
   *
   * ## R184：从「整行 `save()`」改成「**只写 `status` 一列**的条件 UPDATE」
   *
   * ### 病（审计 A-1，实测可复现的并发序列）
   * 旧实现是 `requireOwned`（读整行）→ `row.status = "saved"` → **`repo.save(row)` 整行写回**。
   * `claimTurn` 只护「turn vs turn」，**markSaved 根本不 claim** ⇒ 于是：
   * ① 用户点「保存」的**同一时刻**有一轮模型在跑（每轮是全量视频推理，几十秒很正常）；
   * ② markSaved 读到的 `messagesJson` / `draftJson` / `questionsAsked` 是**读那一刻的快照**；
   * ③ 模型跑完把新消息写进库；
   * ④ markSaved 的整行 `save()` 用**旧快照**写回 ⇒ **整轮新消息被静默擦掉**。
   * 而且 `AiSopSession` **没有 `@VersionColumn`** ⇒ 覆盖后**连「版本变了」这种痕迹都没有**。
   *
   * ### 修法
   * 只写它**真正要改的那一列**（`status`），其余列一律不碰 ⇒ **结构上不可能擦掉消息**。
   * `affected === 0` 时（行已不存在/已属别人）抛 `not found`，**不静默成功**。
   *
   * ⚠️ **本方法仍然不 claim**（这是刻意的）：它不改模型侧事实、也不该因为「有一轮在跑」
   * 就失败 —— 用户点保存是**幂等**动作。但要注意：若那一轮随后把 `status` 写成
   * `active`/`drafted`，**「已保存」会被覆盖** —— 那属 turn 侧整行写的问题
   * （审计 A-2 的另一半，登记在 `artifacts/autonomy/R183/audit-save-without-predicate.md`）。
   */
  async markSaved(id: string, owner: string) {
    const row = await this.requireOwned(id, owner);
    const res = await this.repo
      .createQueryBuilder()
      .update(AiSopSession)
      .set({ status: "saved" })
      // ADR-026：**状态写必须带前置状态断言**（否则并发/长窗口下会把别人刚写完的状态盖回去）。
      // 这里断「**来源状态仍是未保存**」—— 既是守卫的要求，也是语义上正确的：
      // 「标记已保存」只该作用于**还没保存**的行。
      .where("id = :id AND status IN ('active', 'drafted')", { id })
      .execute();
    if (!res.affected) {
      // `affected === 0` 有两种可能，**必须分开**（不分就是把「已保存」谎报成「不存在」）：
      // ① 行不存在 / 不属本人 ⇒ 抛 not found；
      // ② 行**已经是 saved** ⇒ 本方法是**幂等**的（用户重复点保存 / 前端重发），**不是错误**。
      //    ⚠️ 这里**不再写一次**（写的还是同一个值，纯浪费一次行锁）。
      const fresh = await this.repo.findOne({ where: { id } });
      if (!fresh || fresh.status !== "saved") {
        throw new AppError(ErrorCode.AI_SOP_SESSION_NOT_FOUND, { id });
      }
      row.status = "saved";
      return this.view(fresh as AiSopSession);
    }
    row.status = "saved";
    return this.view(row);
  }

  // ── 内部：真正的"一轮" ─────────────────────────────────────────

  /**
   * 跑一轮（追问或出稿）。
   *
   * @param turnToken **本轮持有的租约 token**（`claimTurn` 的返回值）——
   *   两处落库都用它做**围栏**，见下面两处 `saveTurnOutcome` 的注释。
   */
  /**
   * R185：**本轮结果的落库**（`runTurn` 的唯一写出口）—— 带**租约围栏**的条件 UPDATE。
   *
   * ## 病（审计 A-2 的另一半）
   * `runTurn` 的两处落库此前是**整行 `repo.save(row)`**，谓词只有实体 id 隐含的主键
   * ⇒ 这里写回的是 **claim 那一刻的快照**。若本轮**租约已过期**（每轮是全量视频推理，
   * 超过 5 分钟很常见）且锁已被下一轮抢走，那么：
   * ① 下一轮已经写入了它自己的消息/草稿；
   * ② 本轮跑完仍会**用旧快照整行覆盖** ⇒ **下一轮的结果被静默丢弃**
   *    （而 `AiSopSession` **没有 `@VersionColumn`** ⇒ 连痕迹都没有）。
   *
   * ## 修法：谓词加 `"turnLockedAt" = :token`
   * 「**我还持有本轮租约**」是比 id 更强的语义：租约被抢走 ⇒ `affected === 0`
   * ⇒ 本轮**如实失败**（`AI_SOP_TURN_IN_PROGRESS`），**不静默覆盖别人的结果**。
   *
   * ## 为什么仍写这 4 列（而不是拆成更窄的列）
   * 这 4 列（`messagesJson` / `mediaJson` / `questionsAsked` / `draftJson`）是**一轮的完整结果**
   * —— 它们**必须一起生效**：只写消息不写草稿 = 用户看到「已出稿」但草稿是空的。
   * ⇒ 这里**不该**拆列，该加的是**围栏**（→ 方法学 364 的反面：列面与谓词面是两个维度，
   * 这一处**列面必须宽、谓词面必须强**）。
   */
  private async saveTurnOutcome(
    row: AiSopSession,
    turnToken: Date,
    patch: {
      messagesJson: AiSopSession["messagesJson"];
      mediaJson: AiSopSession["mediaJson"];
      questionsAsked?: number;
      draftJson?: Record<string, unknown> | null;
      status: AiSopSession["status"];
    },
  ): Promise<void> {
    const res = await this.repo
      .createQueryBuilder()
      .update(AiSopSession)
      .set({
        messagesJson: patch.messagesJson,
        mediaJson: patch.mediaJson,
        status: patch.status,
        ...(patch.questionsAsked !== undefined
          ? { questionsAsked: patch.questionsAsked }
          : {}),
        ...(patch.draftJson !== undefined
          ? { draftJson: patch.draftJson }
          : {}),
      })
      .where('id = :id AND "turnLockedAt" = :token', {
        id: row.id,
        token: turnToken,
      })
      .execute();
    if (!res.affected) {
      // 租约已被下一轮抢走 ⇒ **如实失败**，不覆盖别人的结果。
      throw new AppError(ErrorCode.AI_SOP_TURN_IN_PROGRESS, { id: row.id });
    }
  }

  private async runTurn(
    row: AiSopSession,
    input: { text: string; mediaId: string | null },
    onDelta: ((text: string) => void) | undefined,
    turnToken: Date,
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
      // R185：带**租约围栏**落库（见 `saveTurnOutcome` 注释）。
      await this.saveTurnOutcome(row, turnToken, {
        messagesJson: row.messagesJson,
        mediaJson: row.mediaJson,
        questionsAsked: row.questionsAsked,
        status: row.status,
      });
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
    // R185：带**租约围栏**落库（见 `saveTurnOutcome` 注释）。
    await this.saveTurnOutcome(row, turnToken, {
      messagesJson: row.messagesJson,
      mediaJson: row.mediaJson,
      draftJson: row.draftJson,
      status: row.status,
    });

    this.logger.log(
      `SOP session drafted: id=${row.id} questions=${row.questionsAsked} videos=${mediaRefs.length} model=${draft.model}`,
    );
    return { ...this.view(row), lastTurnUsage: usage };
  }
}
