import { Injectable, Logger } from "@nestjs/common";
import { dump as yamlDump } from "js-yaml";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import {
  SopFrontMatterError,
  validateFrontMatter,
  type SopFrontMatter,
} from "../sop/sop-frontmatter";
import { AiMediaService } from "./ai-media.service";
import { AiService } from "./ai.service";
import { extractJsonObject, normalizeSopSlug } from "./ai-json";

/**
 * 视频转 SOP（推理质量轮）：把一段操作录屏转成**可编辑的 SOP 草稿**。
 *
 * ## 为什么是"草稿"而不是直接发布
 * 模型看视频只能看出「点了哪里、填了什么」，看不出**判定标准**（什么算成功、
 * 什么情况该转人工）。SOP 的 acceptance 是发布闸门（`validateFrontMatter`
 * strict 模式必填），让模型猜一个验收项然后自动发布，等于把"没达标"写成
 * "已达标"。所以这里只产出草稿：员工在页面上改完、补上验收项，再走既有
 * `POST /api/sop` 起草 → 发布流程（同一套校验，不新开旁路）。
 *
 * ## 员工视角的输入
 * 不要求写需求文档：给一段录屏 + 一句"你想让系统替你做什么"（可选）。
 * 模型负责把「人怎么操作」翻译成「机器怎么执行」，并把不确定处列进
 * `bodyMarkdown` 末尾的「待确认」——**不编造视频里没有的操作**。
 */

/** 单次生成的产物（前端直接填进 SOP 编辑表单）。 */
export interface SopDraftFromVideoResult {
  title: string;
  slug: string;
  /** 给 `POST /api/sop` 的 frontMatterYaml（已过草稿级校验）。 */
  frontMatterYaml: string;
  bodyMarkdown: string;
  /** 实际使用的 provider/model（成本归因与"为什么这次质量差"的排查依据）。 */
  provider: string;
  model: string;
  /** 需要人复核的点（空数组 = 模型认为没有明显缺口）。 */
  warnings: string[];
}

const SYSTEM_PROMPT = [
  "你是 AutoCodeFlow 的 SOP 编写助手。用户会给你一段「员工手工操作系统」的录屏。",
  "你的任务：把这段录屏转写成平台可执行的 SOP 草稿。",
  "",
  "要求：",
  "1. 只写录屏里**确实发生**的操作；没看清的地方写进 bodyMarkdown 末尾的「待确认」小节，不要编造。",
  "2. bodyMarkdown 用分步编号，每步一句话；涉及界面时写清「在哪个界面做什么、看到什么算这一步成功」。",
  "3. frontMatter.capabilities 只从 browser / gui / filesystem / http 中选**确实需要**的（录屏里只是打开浏览器看信息 → browser；直接操作桌面软件 → gui）。",
  "4. frontMatter.acceptance 是发布前必须补的**机器可判定**项：看不出来就留空数组，不要猜。",
  "5. frontMatter.constraints.allowedDomains 只在确有固定站点时填。",
  "",
  "输出协议：只返回一个 JSON 对象（不要 markdown 代码栅栏，不要解释）：",
  '{"title":"中文标题","slug":"kebab-case-英文标识",',
  ' "frontMatter":{"capabilities":["browser"],"acceptance":[],"constraints":{}},',
  ' "bodyMarkdown":"## 步骤\n1. …"}',
].join("\n");

@Injectable()
export class AiSopDraftService {
  private readonly logger = new Logger(AiSopDraftService.name);

  constructor(
    private readonly ai: AiService,
    private readonly media: AiMediaService,
  ) {}

  async fromVideo(input: {
    mediaId: string;
    providerId?: string;
    hint?: string;
  }): Promise<SopDraftFromVideoResult> {
    const row = await this.media.requireById(input.mediaId);

    // 直链：模型侧只会做普通 GET，签名对它透明；签不出来就如实拒绝
    // （发一条模型取不到的链接会表现为"生成一直转圈"）。
    const signed = await this.ai.signedVideoUrl(row.id, row.name);
    if (signed.status === "error") {
      throw new AppError(ErrorCode.AI_VIDEO_LINK_UNAVAILABLE, {
        reason: signed.message,
      });
    }

    const hint = (input.hint ?? "").trim().slice(0, 2_000);
    const userText = hint
      ? `这是一段操作录屏。用户补充说明：「${hint}」。请把它转写成 SOP 草稿。`
      : "这是一段操作录屏。请把它转写成 SOP 草稿。";

    const res = await this.ai.chatMultimodal({
      purpose: "video",
      ...(input.providerId?.trim()
        ? { provider: input.providerId.trim() }
        : {}),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "video_url", video_url: { url: signed.url } },
          ],
        },
      ],
    });

    if (!res.content.trim()) {
      // fail-open 的空结果在用户侧必须可解释：多半是没配视频模型/没配直链 base
      throw new AppError(ErrorCode.AI_VIDEO_MODEL_UNAVAILABLE, {
        provider: input.providerId ?? "",
      });
    }

    const parsed = extractJsonObject(res.content);
    if (!parsed) {
      throw new AppError(ErrorCode.AI_DRAFT_UNPARSABLE);
    }

    const title =
      typeof parsed.title === "string" ? parsed.title.trim().slice(0, 255) : "";
    const bodyMarkdown =
      typeof parsed.bodyMarkdown === "string" ? parsed.bodyMarkdown.trim() : "";
    if (!title || !bodyMarkdown) {
      throw new AppError(ErrorCode.AI_DRAFT_UNPARSABLE);
    }

    const warnings: string[] = [];
    let frontMatter: SopFrontMatter;
    const rawFrontMatter = {
      ...((parsed.frontMatter as Record<string, unknown> | undefined) ?? {}),
    };
    // 模型极常产出 `"acceptance": []`。front-matter 校验把**空数组**判为非法
    // （"必须是非空数组"），但它和"没填"在语义上是同一件事——草稿允许留空待补。
    // 归一成"未填"（删键）而不是报错：让员工在页面上补，而不是让一次生成白跑。
    if (
      Array.isArray(rawFrontMatter.acceptance) &&
      rawFrontMatter.acceptance.length === 0
    ) {
      delete rawFrontMatter.acceptance;
    }
    try {
      // 草稿级校验（strict=false）：只挡结构性错误，允许 acceptance 留空待补
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

    if (frontMatter.acceptance.length === 0) {
      warnings.push(
        "草稿没有验收项（acceptance）：发布前必须补「怎样算做完了」的机器可判定条件",
      );
    }
    if (!frontMatter.capabilities?.length) {
      warnings.push(
        "模型没有声明能力域（capabilities）：请按实际用到的能力补选",
      );
    }

    const slug =
      normalizeSopSlug(parsed.slug) ||
      normalizeSopSlug(title) ||
      `sop-${Date.now().toString(36)}`;

    this.logger.log(
      `SOP draft from video: media=${row.id} provider=${res.provider ?? "?"} model=${res.model} chars=${bodyMarkdown.length}`,
    );

    return {
      title,
      slug,
      frontMatterYaml: yamlDump(frontMatter, { noRefs: true }).trim(),
      bodyMarkdown,
      provider: res.provider ?? "",
      model: res.model,
      warnings,
    };
  }
}
