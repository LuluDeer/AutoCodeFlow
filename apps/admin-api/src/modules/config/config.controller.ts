import {
  Controller,
  Get,
  Put,
  Delete,
  Post,
  Param,
  Body,
  UseGuards,
  Req,
  Query,
  ParseIntPipe,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { Request } from "express";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
import { UserRole } from "../users/entities/user.entity";
import { SystemConfigService, UpsertConfig } from "./config.service";
import { UpsertConfigDto } from "./dto/upsert-config.dto";
import { ConfigHistoryQueryDto } from "./dto/config-history-query.dto";
import { PaginationDto } from "../../common/dto/pagination.dto";
// G-1：版本契约的权威源（无 DI 纯函数模块，跨模块引用同 safe-http.util 先例）
import { getSupportedRange } from "../task/runtime-version.util";
import { LEGACY_DEFAULT_INTERPRETERS } from "../executor/interpreter-match.util";

@ApiTags("System Config")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Controller("config")
export class ConfigController {
  constructor(private readonly configService: SystemConfigService) {}

  // SEC-CFG-01（本轮审计）：本控制器所有写路由与 executor-shared-token 读路由
  // 都带 @Roles(ADMIN)，但系统配置的**通用读路由**此前没有——任何已认证用户
  // （含最低权限 USER）可直接 GET /config、/config/:key、/config/history 拉取
  // 整个配置存储。唯一的屏障是逐键 opt-in 的 isSecret 掩码
  // （create 时 isSecret ?? false），而 ai.openaiBaseUrl / ai.ollamaHost 这类
  // 记录内部拓扑的键并非以 isSecret 写入，等于对普通用户明文暴露内网地址；
  // 任何未来新增的敏感键在忘记标 secret 时也会一律泄露。
  // 配置读面与写面同属管理面，一并收敛为 ADMIN。
  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "List all config entries" })
  async findAll(@Query("prefix") prefix?: string, @Query("tag") tag?: string) {
    let configs: import("./entities/system-config.entity").SystemConfig[];
    if (prefix) {
      configs = await this.configService.getByPrefix(prefix);
    } else if (tag) {
      configs = await this.configService.getByTag(tag);
    } else {
      configs = await this.configService.findAll();
    }
    return configs.map((c) => (c.isSecret ? { ...c, value: "***" } : c));
  }

  // NOTE: static routes ('history', 'history/:key', 'history/:id/rollback') must
  // be declared BEFORE the dynamic ':key' route to avoid NestJS matching 'history'
  // as the key parameter.

  @Get("history")
  // SEC-CFG-01: 同 findAll——历史读面会暴露非 secret 键的 old/new 值。
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Get config change history" })
  async getHistory(@Query() query?: ConfigHistoryQueryDto) {
    const page = query?.page ?? 1;
    const limit = query?.pageSize ?? 20;
    const result = await this.configService.getHistory(query?.key, page, limit);
    // Mask secret values in history records.
    // WIKI-OPT-2: 行级保密优先——历史行持久化的 isSecret=true（迁移
    // 1790000000018）时无论该键当前是否仍标记 secret 都掩码，防配置被
    // 删除或取消 secret 标记后历史读面暴露旧机密值；存量旧行（isSecret
    // 为 NULL=元数据不可知）沿用既有「按当前配置行 isSecret」的键级推断，
    // 行为不回归。
    const secretKeys = await this.configService.getSecretKeys();
    result.data = result.data.map((h) =>
      h.isSecret === true || secretKeys.has(h.configKey)
        ? {
            ...h,
            oldValue: h.oldValue != null ? "***" : null,
            newValue: h.newValue != null ? "***" : null,
          }
        : h,
    );
    return result;
  }

  @Get("history/:key")
  // SEC-CFG-01: 同上。
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Get history for a specific config key" })
  async getHistoryByKey(
    @Param("key") key: string,
    @Query() pagination?: PaginationDto,
  ) {
    const page = pagination?.page ?? 1;
    const limit = pagination?.pageSize ?? 20;
    const result = await this.configService.getHistory(key, page, limit);
    // Check if this key is marked secret and mask values accordingly.
    // WIKI-OPT-2: 同 getHistory 的行级保密语义——历史行 isSecret=true 逐行
    // 掩码（与键级推断取并集），存量 NULL 行沿用键级推断。
    const secretKeys = await this.configService.getSecretKeys();
    result.data = result.data.map((h) =>
      h.isSecret === true || secretKeys.has(key)
        ? {
            ...h,
            oldValue: h.oldValue != null ? "***" : null,
            newValue: h.newValue != null ? "***" : null,
          }
        : h,
    );
    return result;
  }

  @Post("history/:id/rollback")
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Rollback config to a historical version" })
  async rollback(
    // S15: validate the path param as an integer — a non-numeric id must map
    // to 400 (ValidationPipe) instead of reaching TypeORM/PG and surfacing
    // as a 500.
    @Param("id", ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.configService.rollback(id, {
      userId: user?.id != null ? user.id : undefined, // PK-21（DEEP_REVIEW 0ef3bbe）：直传 integer，不再 String()
      username: user?.username,
      ipAddress: req.ip,
    });
  }

  @Post("executor-shared-token/generate")
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Generate or rotate executor shared token" })
  async generateExecutorSharedToken(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const { randomBytes } = await import("crypto");
    const token = randomBytes(32).toString("hex");
    await this.configService.upsert(
      {
        key: "executor.sharedToken",
        value: token,
        description:
          "Executor shared token (auto-generated by admin, sensitive)",
        valueType: "string",
        isSecret: true,
      },
      {
        userId: user?.id != null ? user.id : undefined, // PK-21（DEEP_REVIEW 0ef3bbe）：直传 integer，不再 String()
        username: user?.username,
        ipAddress: req.ip,
      },
    );
    return { token };
  }

  // R4 F-1: returns the executor shared token in plaintext — admin only.
  @Get("executor-shared-token")
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "Get current executor shared token (plaintext, admin only)",
  })
  async getExecutorSharedToken() {
    try {
      const cfg = await this.configService.findOne("executor.sharedToken");
      return { token: cfg.value ?? null, hasToken: !!cfg.value };
    } catch {
      return { token: null, hasToken: false };
    }
  }

  // G-1（admin-web 深度审查）：Python 版本契约的**权威下发端点**。
  //
  // 此前前端 apps/admin-web/src/pages/executor-mode.ts 硬编码
  // min/max/onlineMin/legacyDefault 并注释「与后端同值，改动需两侧同步」。而
  // min/max 支持 PYTHON_RUNTIME_VERSION_MIN/MAX env 覆盖（runtime-version.util.ts
  // 的 getSupportedRange()），运维一改，前端的区间提示与舰队能力咨询就静默漂移。
  // 本端点把后端**当前生效**的契约值下发给前端，消除这份人工同步。
  //
  // 返回的是**契约常量**（不含系统配置存储里的任何键值），故不适用 SEC-CFG-01
  // 的 ADMIN 收敛：任何能建任务的用户都需要在表单里读到正确区间，且此处无
  // secrets 可泄。
  //
  // NOTE: 静态路由必须声明在下方动态 ':key' 路由之前，否则会被 ':key' 抢先匹配。
  @ApiOperation({
    summary: "Get the authoritative Python runtime version contract",
    description:
      "Returns the currently effective declareable range (min/max, overridable via " +
      "PYTHON_RUNTIME_VERSION_MIN/MAX), the online-download floor (onlineMin) and the " +
      "legacy fallback interpreter for executors that do not report interpreters. " +
      "The frontend injects these into its version helpers instead of hardcoding them. " +
      "Returns contract constants only — no config-store values, no secrets.",
  })
  @Get("runtime-version")
  async getRuntimeVersion() {
    const range = getSupportedRange();
    return {
      min: range.min,
      max: range.max,
      onlineMin: range.onlineMin,
      legacyDefaultInterpreter: LEGACY_DEFAULT_INTERPRETERS[0] ?? "3.12",
    };
  }

  @Get(":key")
  // SEC-CFG-01: 同上——单键读面是「按名取任意配置」的直接入口。
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Get a single config entry" })
  async findOne(@Param("key") key: string) {
    const c = await this.configService.findOne(key);
    return c.isSecret ? { ...c, value: "***" } : c;
  }

  @Put()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Create or update a config entry" })
  async upsert(
    @Body() dto: UpsertConfigDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.configService.upsert(dto, {
      userId: user?.id != null ? user.id : undefined, // PK-21（DEEP_REVIEW 0ef3bbe）：直传 integer，不再 String()
      username: user?.username,
      ipAddress: req.ip,
    });
  }

  @Post("batch")
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Batch create or update config entries" })
  async batchUpsert(
    @Body() items: UpsertConfig[],
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.configService.batchUpsert(items, {
      userId: user?.id != null ? user.id : undefined, // PK-21（DEEP_REVIEW 0ef3bbe）：直传 integer，不再 String()
      username: user?.username,
      ipAddress: req.ip,
    });
  }

  @Delete(":key")
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Delete a config entry" })
  async remove(
    @Param("key") key: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.configService.remove(key, {
      userId: user?.id != null ? user.id : undefined, // PK-21（DEEP_REVIEW 0ef3bbe）：直传 integer，不再 String()
      username: user?.username,
      ipAddress: req.ip,
    });
  }
}
