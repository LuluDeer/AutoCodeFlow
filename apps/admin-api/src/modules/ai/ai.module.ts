import { Module } from "@nestjs/common";
import { AiService } from "./ai.service";
// ARCH-30: AI 分析服务化（封装 AiService + 重试 + 落库率指标）
import { AiAnalysisService } from "./ai-analysis.service";
import { AiController } from "./ai.controller";
import { SystemConfigModule } from "../config/config.module";

@Module({
  imports: [SystemConfigModule],
  controllers: [AiController],
  providers: [AiService, AiAnalysisService],
  exports: [AiService, AiAnalysisService],
})
export class AiModule {}
