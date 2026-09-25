import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import { AiService } from "./ai.service";
import { SystemConfigService } from "../config/config.service";
import { IsString, IsIn, IsOptional } from "class-validator";

export class SaveAiConfigDto {
  @IsString()
  @IsIn(["disabled", "openai", "ollama", "qwen"])
  provider: string;

  @IsOptional()
  @IsString()
  openaiApiKey?: string;

  @IsOptional()
  @IsString()
  openaiModel?: string;

  @IsOptional()
  @IsString()
  openaiBaseUrl?: string;

  @IsOptional()
  @IsString()
  ollamaHost?: string;

  @IsOptional()
  @IsString()
  ollamaModel?: string;

  // P1: Qwen / DashScope 多模态配置
  @IsOptional()
  @IsString()
  qwenApiKey?: string;

  @IsOptional()
  @IsString()
  qwenModel?: string;

  @IsOptional()
  @IsString()
  qwenBaseUrl?: string;

  @IsOptional()
  @IsString()
  qwenMaxTokens?: string;

  @IsOptional()
  @IsString()
  qwenTimeoutMs?: string;
}

@ApiTags("AI Config")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Controller("ai")
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  // N11: AI config exposes internal baseUrl/host topology on read, and a
  // write lets the caller redirect outbound calls (API key would be sent as
  // Bearer to an attacker-chosen public host) — admin only. The global
  // RolesGuard reads this metadata; no extra @UseGuards entry is needed.
  @Get("config")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Get current AI configuration" })
  async getConfig() {
    const effective = await this.aiService.getEffectiveConfig();
    // P1: 按 provider 判定密钥就绪状态（此前硬编码查 ai.openaiApiKey，
    // 导致「选了 qwen 却显示未配置 API Key」——见 ai.service.hasApiKeyForProvider）。
    // 仍然只回布尔，永不回传密钥值。
    const hasApiKey = await this.aiService.hasApiKeyForProvider();
    return { ...effective, hasApiKey };
  }

  @Post("config")
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Save AI configuration to system config store" })
  async saveConfig(@Body() dto: SaveAiConfigDto) {
    const items: Array<{
      key: string;
      value: string;
      isSecret?: boolean;
      description?: string;
    }> = [
      {
        key: "ai.provider",
        value: dto.provider,
        description: "AI provider: disabled | openai | ollama | qwen",
      },
      {
        key: "ai.openaiModel",
        value: dto.openaiModel ?? "gpt-4o-mini",
        description: "OpenAI model name",
      },
      {
        key: "ai.openaiBaseUrl",
        value: dto.openaiBaseUrl ?? "https://api.openai.com/v1",
        description: "OpenAI-compatible API base URL",
      },
      {
        key: "ai.ollamaHost",
        value: dto.ollamaHost ?? "http://localhost:11434",
        description: "Ollama host URL",
      },
      {
        key: "ai.ollamaModel",
        value: dto.ollamaModel ?? "llama3",
        description: "Ollama model name",
      },
      // P1: Qwen / DashScope 多模态配置
      {
        key: "ai.qwenModel",
        value: dto.qwenModel ?? "qwen-vl-max",
        description: "Qwen model name (multimodal: text + image + video)",
      },
      {
        key: "ai.qwenBaseUrl",
        value:
          dto.qwenBaseUrl ??
          "https://dashscope.aliyuncs.com/compatible-mode/v1",
        description: "Qwen / DashScope OpenAI-compatible base URL",
      },
      {
        key: "ai.qwenMaxTokens",
        value: dto.qwenMaxTokens ?? "4096",
        description: "Qwen max_tokens (independent of openai's 500)",
      },
      {
        key: "ai.qwenTimeoutMs",
        value: dto.qwenTimeoutMs ?? "120000",
        description: "Qwen request timeout ms (video understanding is slow)",
      },
    ];

    // Only update API key if a new value was provided
    if (dto.openaiApiKey && dto.openaiApiKey.trim() !== "") {
      items.push({
        key: "ai.openaiApiKey",
        value: dto.openaiApiKey,
        isSecret: true,
        description: "OpenAI API key (sensitive)",
      });
    }

    // P1: qwen 密钥同样「仅在传非空值时更新」，语义与 openai 一致。
    if (dto.qwenApiKey && dto.qwenApiKey.trim() !== "") {
      items.push({
        key: "ai.qwenApiKey",
        value: dto.qwenApiKey,
        isSecret: true,
        description: "Qwen / DashScope API key (sensitive)",
      });
    }

    await this.systemConfig.batchUpsert(
      items.map((i) => ({ ...i, valueType: "string" as const })),
    );
    return { ok: true };
  }

  // R11: POST /ai/test performs a real outbound AI call with the saved
  // config (same posture as GET/POST /ai/config above, N11) — a plain user
  // could use it to probe the configured provider, burn API quota, and read
  // back provider responses through the message field. Admin only.
  @Post("test")
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Test current AI configuration with a sample prompt",
  })
  async testConfig() {
    const result = await this.aiService.analyzeFailure(
      { name: "test-task", runtime: "node" },
      "Error: Cannot find module 'express'\n    at Function.Module._resolveFilename (internal/modules/cjs/loader.js:880:15)",
    );
    if (!result) {
      return {
        ok: false,
        message: "AI provider is disabled or returned empty response",
      };
    }
    return { ok: true, message: result };
  }
}
