import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AiService } from "./ai.service";
// ARCH-30: AI 分析服务化（封装 AiService + 重试 + 落库率指标）
import { AiAnalysisService } from "./ai-analysis.service";
import { AiController } from "./ai.controller";
import { SystemConfigModule } from "../config/config.module";
// 视频转 SOP（推理质量轮）：媒体落盘 + 签名直链 + 草稿生成
import { AiMedia } from "./entities/ai-media.entity";
import { AiMediaService } from "./ai-media.service";
import { AiMediaController } from "./ai-media.controller";
import { AiSopDraftService } from "./ai-sop-draft.service";
import { AiSopDraftController } from "./ai-sop-draft.controller";
import { AiSopSession } from "./entities/ai-sop-session.entity";
import { AiSopSessionService } from "./ai-sop-session.service";
import { AiSopSessionController } from "./ai-sop-session.controller";
import { AiMediaRetentionService } from "./ai-media-retention.service";

@Module({
  imports: [
    SystemConfigModule,
    TypeOrmModule.forFeature([AiMedia, AiSopSession]),
  ],
  controllers: [
    AiController,
    AiMediaController,
    AiSopDraftController,
    AiSopSessionController,
  ],
  providers: [
    AiService,
    AiAnalysisService,
    AiMediaService,
    AiSopDraftService,
    AiSopSessionService,
    AiMediaRetentionService,
  ],
  exports: [
    AiService,
    AiAnalysisService,
    AiMediaService,
    AiSopDraftService,
    AiSopSessionService,
  ],
})
export class AiModule {}
