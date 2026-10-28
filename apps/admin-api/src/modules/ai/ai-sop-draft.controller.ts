import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { UserRole } from "../users/entities/user.entity";
import { AiSopDraftService } from "./ai-sop-draft.service";

/** 视频转 SOP 的请求体。 */
export class SopDraftFromVideoDto {
  /** 上传接口返回的 mediaId。 */
  @IsUUID()
  mediaId: string;

  /**
   * 指定 provider（设置页"用这个模型做视频分析"）。
   * 不传 = 用 `ai.routes.video.provider`；该条目必须勾选了「支持视频」。
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  providerId?: string;

  /** 员工的一句话补充（"我想让它每天早上自动跑一遍"这类意图）。 */
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  hint?: string;
}

/**
 * 视频转 SOP（推理质量轮）：**只产草稿，不落库**。
 *
 * 为什么不直接建 SOP：模型看视频看不出「什么算成功」（acceptance 是发布闸门），
 * 由它猜一个验收项再自动发布，等于把"没达标"写成"已达标"。草稿交回页面，
 * 员工补完验收项后走既有 `POST /api/sop` → 发布流程（同一套校验）。
 */
@ApiTags("AI · SOP Draft")
@ApiBearerAuth("JWT")
@Controller("ai/sop-draft")
@UseGuards(JwtAuthGuard)
export class AiSopDraftController {
  constructor(private readonly drafts: AiSopDraftService) {}

  @Post("from-video")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "把一段操作录屏转成 SOP 草稿（返回可编辑内容，不落库）",
  })
  async fromVideo(
    @Body() dto: SopDraftFromVideoDto,
    @CurrentUser() user?: { id: number | string; username?: string },
  ) {
    const draft = await this.drafts.fromVideo({
      mediaId: dto.mediaId,
      providerId: dto.providerId,
      hint: dto.hint,
    });
    return { ...draft, requestedBy: `user:${user?.id ?? "unknown"}` };
  }
}
