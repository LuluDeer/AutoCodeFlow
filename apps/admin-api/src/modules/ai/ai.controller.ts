import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import { AiService } from "./ai.service";
import { SystemConfigService } from "../config/config.service";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
// P3-1（2026-10-26 审计）：AI 配置数值字段保存面校验——非法值此前静默落库，
// 运行时 parseInt 失败回退默认值，管理员被「保存成功」误导（见 saveConfig）。
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
// ARCH-23 / N-12（2026-10-07 A1 批）：AI 配置域响应契约。
import {
  AiConfigResponseDto,
  AiConfigSaveResponseDto,
  AiTestResponseDto,
} from "./dto/ai-response.dto";

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

/**
 * P3-1（2026-10-26 审计）：AI 配置的**数值键白名单**。
 *
 * 缺陷现场：qwenMaxTokens 填 "abc" 也能保存成功——落库后
 * ai.service.getQwenMaxTokens/getQwenTimeoutMs 的 `parseInt 失败 → 静默回退
 * 默认值` 兜底（原语义：>0 的整数才生效，见 ai.service.ts 482-492）让管理员
 * 以为配置已生效，实际跑的是默认值。
 *
 * 修复口径（与运行时语义逐条对齐）：
 *   · 必须是纯十进制数字串（^\d+$，trim 后判定）——"12abc"/"1e3"/"0x10"/
 *     负数一律 400（Number() 会把 "1e3" 当 1000 放行，与管理员「填普通整数」
 *     的意图不符）；
 *   · min=1 —— 运行时判据就是 `n > 0`，这里不额外加政策性下限；
 *   · qwenMaxTokens 上限 65536（默认 4096，DashScope 输出上限宽裕覆盖）；
 *   · qwenTimeoutMs 上限 3,600,000（1 小时；默认 120000，视频理解场景上限）；
 *   · 空串/缺省放行 —— ai.service.getAiConfig 把空值当「未配置」走 env/默认
 *     回退，前端清空输入框 = 恢复默认，是合法操作。
 */
const AI_CONFIG_NUMERIC_FIELDS: Record<
  string,
  { min: number; max: number; label: string }
> = {
  qwenMaxTokens: { min: 1, max: 65_536, label: "qwenMaxTokens" },
  qwenTimeoutMs: { min: 1, max: 3_600_000, label: "qwenTimeoutMs" },
};

/** 新增/更新一个 provider 条目（设置页"接入端点"）。 */
export class SaveAiProviderDto {
  /** 引用名；会进配置键名，形态必须封闭。 */
  @ApiProperty({ description: "引用名（进配置键名，形态封闭）", example: "qwen-vl" })
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._-]{0,63}$/, {
    message: "id 只能用小写字母/数字/点/下划线/连字符，且不能以符号开头",
  })
  id: string;

  @ApiPropertyOptional({ description: "展示名", maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional({ enum: ["openai", "ollama"], description: "协议形态，默认 openai" })
  @IsOptional()
  @IsIn(["openai", "ollama"])
  transport?: "openai" | "ollama";

  @ApiProperty({ description: "OpenAI 兼容端点基址（须 http(s)）", example: "https://dashscope.aliyuncs.com/compatible-mode/v1" })
  @IsString()
  @MaxLength(512)
  @Matches(/^https?:\/\//i, { message: "baseUrl 必须是 http(s) 地址" })
  baseUrl: string;

  @ApiProperty({ description: "模型名", example: "qwen-vl-max" })
  @IsString()
  @MaxLength(120)
  model: string;

  @ApiPropertyOptional({ description: "单次最大输出 token", minimum: 1, maximum: 131072 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(131_072)
  maxTokens?: number;

  @ApiPropertyOptional({ description: "请求超时（毫秒）", minimum: 1000, maximum: 600000 })
  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(600_000)
  timeoutMs?: number;

  /** 勾选后该模型才能被"视频理解"用途选中（能力位，不是厂商判断）。 */
  @ApiPropertyOptional({ description: "是否支持视频理解（能力位）" })
  @IsOptional()
  @IsBoolean()
  supportsVideo?: boolean;

  @ApiPropertyOptional({ description: "是否启用" })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** 不传或传 `***` = 保持原值；传空串 = 清除。 */
  @ApiPropertyOptional({ description: "API Key；不传或传 *** 保持原值，空串表示清除", maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  apiKey?: string;
}

/** 把某个用途指向某个 provider（空 providerId = 跟随全局）。 */
export class AssignAiRouteDto {
  @ApiProperty({ enum: ["analysis", "agent", "video"], description: "用途" })
  @IsIn(["analysis", "agent", "video"])
  purpose: "analysis" | "agent" | "video";

  @ApiPropertyOptional({ description: "目标 provider；空 = 跟随全局" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  providerId?: string;

  @ApiPropertyOptional({ description: "覆盖模型名（可选）" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;
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
  @ApiOperation({ summary: "获取当前 AI 配置" })
  @ApiOkResponse({ type: AiConfigResponseDto })
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
  @ApiOperation({ summary: "将 AI 配置保存到系统配置存储" })
  @ApiOkResponse({ type: AiConfigSaveResponseDto })
  async saveConfig(@Body() dto: SaveAiConfigDto) {
    // P3-1: 数值键白名单校验（非法 400 可读，不再静默落库）。
    // 形态闸用纯十进制数字串（^\d+$）而非 Number()——"1e3"/"0x10" 会被
    // Number 当作合法数值放行，与「表单里填的是普通整数」的管理员意图不符。
    for (const [field, range] of Object.entries(AI_CONFIG_NUMERIC_FIELDS)) {
      const raw = (dto as unknown as Record<string, string | undefined>)[field];
      const trimmed = raw?.trim() ?? "";
      if (trimmed === "") continue;
      const n = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
      if (Number.isNaN(n) || n < range.min || n > range.max) {
        throw new AppError(ErrorCode.AI_CONFIG_NUMBER_INVALID, {
          field: range.label,
          min: range.min,
          max: range.max,
        });
      }
    }
    const items: Array<{
      key: string;
      value: string;
      isSecret?: boolean;
      description?: string;
    }> = [
      {
        key: "ai.provider",
        value: dto.provider,
        description: "AI 提供方：disabled | openai | ollama | qwen",
      },
      {
        key: "ai.openaiModel",
        value: dto.openaiModel ?? "gpt-4o-mini",
        description: "OpenAI 模型名称",
      },
      {
        key: "ai.openaiBaseUrl",
        value: dto.openaiBaseUrl ?? "https://api.openai.com/v1",
        description: "OpenAI 兼容 API 基础 URL",
      },
      {
        key: "ai.ollamaHost",
        value: dto.ollamaHost ?? "http://localhost:11434",
        description: "Ollama 主机 URL",
      },
      {
        key: "ai.ollamaModel",
        value: dto.ollamaModel ?? "llama3",
        description: "Ollama 模型名称",
      },
      // P1: Qwen / DashScope 多模态配置
      {
        key: "ai.qwenModel",
        value: dto.qwenModel ?? "qwen-vl-max",
        description: "Qwen 模型名称（多模态：文本 + 图像 + 视频）",
      },
      {
        key: "ai.qwenBaseUrl",
        value:
          dto.qwenBaseUrl ??
          "https://dashscope.aliyuncs.com/compatible-mode/v1",
        description: "Qwen / DashScope 的 OpenAI 兼容基础 URL",
      },
      {
        key: "ai.qwenMaxTokens",
        value: dto.qwenMaxTokens ?? "4096",
        description: "Qwen max_tokens（与 OpenAI 的 500 相互独立）",
      },
      {
        key: "ai.qwenTimeoutMs",
        value: dto.qwenTimeoutMs ?? "120000",
        description: "Qwen 请求超时毫秒数（视频理解较慢）",
      },
    ];

    // Only update API key if a new value was provided
    if (dto.openaiApiKey && dto.openaiApiKey.trim() !== "") {
      items.push({
        key: "ai.openaiApiKey",
        value: dto.openaiApiKey,
        isSecret: true,
        description: "OpenAI API 密钥（敏感）",
      });
    }

    // P1: qwen 密钥同样「仅在传非空值时更新」，语义与 openai 一致。
    if (dto.qwenApiKey && dto.qwenApiKey.trim() !== "") {
      items.push({
        key: "ai.qwenApiKey",
        value: dto.qwenApiKey,
        isSecret: true,
        description: "Qwen / DashScope API 密钥（敏感）",
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
  @ApiOperation({ summary: "用示例提示词测试当前 AI 配置" })
  @ApiOkResponse({ type: AiTestResponseDto })
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

  // ── 模型接入与分配（推理质量轮）───────────────────────────────────
  // 读面回显 baseUrl/model 等拓扑信息、写面能改出站目标（API Key 会被当作
  // Bearer 发往调用方指定的公网主机）——两者都 ADMIN-only，与 /ai/config 同姿态。

  @Get("providers")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "模型接入注册表 + 各用途当前指向" })
  async listProviders() {
    return this.aiService.providerAdminView();
  }

  @Put("providers")
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "新增/更新一个模型接入（密钥 `***` = 不改）" })
  async saveProvider(@Body() dto: SaveAiProviderDto) {
    await this.aiService.saveProvider(dto);
    return this.aiService.providerAdminView();
  }

  @Delete("providers/:id")
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "删除一个模型接入（连同其密钥）" })
  async deleteProvider(@Param("id") id: string) {
    await this.aiService.deleteProvider(id);
    return this.aiService.providerAdminView();
  }

  @Put("routes")
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "设置某个用途使用的模型（空 = 跟随全局）" })
  async assignRoute(@Body() dto: AssignAiRouteDto) {
    await this.aiService.assignRoute(
      dto.purpose,
      dto.providerId ?? "",
      dto.model ?? "",
    );
    return this.aiService.providerAdminView();
  }
}
