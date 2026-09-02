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
  @IsIn(["disabled", "openai", "ollama"])
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
    // Check if an API key is stored in DB (we return a boolean, never the value)
    let hasApiKey = false;
    try {
      const rec = await this.systemConfig.findOne("ai.openaiApiKey");
      hasApiKey = !!rec?.value;
    } catch {
      hasApiKey = false;
    }
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
        description: "AI provider: disabled | openai | ollama",
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

    await this.systemConfig.batchUpsert(
      items.map((i) => ({ ...i, valueType: "string" as const })),
    );
    return { ok: true };
  }

  @Post("test")
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
