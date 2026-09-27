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
// ARCH-23 / N-12：响应体类型标注。此前本控制器 11 个 2xx 全部只有
// `{ description: "" }`、**没有 schema**，前端 `gen:api-types` 无从生成类型，
// 只能手写 `apps/admin-web/src/api/config.ts` 里的 SystemConfig/ConfigHistory
// （且已实测漂移：手写的 `tag` 字段后端根本没有、`userId` 仍是 string 而
// 后端自迁移 1790000000023 起已是 integer）。用专用响应 DTO——实体类没有
// `@ApiProperty`，直接标 `type: SystemConfig` 会 emit 空壳 schema
// （`properties:{}`），前端生成 `Record<string, never>`，且被 CI 的 PK-15
// 空 schema 闸打红（本仓在 Application 上实测踩过）。
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  getSchemaPath,
} from "@nestjs/swagger";
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
// ARCH-23 / N-12：本模块响应体 DTO（详见 dto/config-response.dto.ts 头注——
// 为什么不能标实体、掩码语义、以及本批查出的前端手写类型漂移）。
import {
  ConfigDeleteResultDto,
  ConfigHistoryPageDto,
  ExecutorSharedTokenDto,
  ExecutorSharedTokenStatusDto,
  RuntimeVersionContractDto,
  SystemConfigResponseDto,
} from "./dto/config-response.dto";
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
  @ApiResponse({
    status: 200,
    description:
      "Config rows sorted by key (optionally filtered by prefix/tag). " +
      "Secret rows have value replaced by the mask '***'.",
    type: [SystemConfigResponseDto],
  })
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
  @ApiResponse({
    status: 200,
    description:
      "Paged history, newest first. Rows whose persisted isSecret=true (or whose " +
      "key is currently secret) have oldValue/newValue masked as '***'; null stays null.",
    type: ConfigHistoryPageDto,
  })
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
  @ApiResponse({
    status: 200,
    description:
      "Paged history for one key. Rows whose persisted isSecret=true (or this key " +
      "is currently secret) have oldValue/newValue masked as '***'; null stays null.",
    type: ConfigHistoryPageDto,
  })
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
  // ARCH-23 / N-12：本端点**真的有两种成功形态**（ConfigService.rollback）：
  //   ① 普通回滚（update/delete 历史）→ 返回写回后的 SystemConfig 实体；
  //   ② 回滚一条 action='create' 的历史（= 撤销创建）→ 返回 {deleted:true}。
  // 只标一种就是"文档按想象写"（前端会照它写代码然后拿到另一种形状），故用
  // oneOf 如实表达。注意这里不能写 `type: SystemConfig`（实体无 @ApiProperty
  // → 空壳 schema → PK-15 闸红），必须 $ref 响应 DTO。
  @ApiResponse({
    status: 201,
    description:
      "Rolled-back config row, or {deleted:true} when the target history row was " +
      "the creation of that key (rollback = undo the creation)",
    schema: {
      oneOf: [
        { $ref: getSchemaPath(SystemConfigResponseDto) },
        { $ref: getSchemaPath(ConfigDeleteResultDto) },
      ],
    },
  })
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
  @ApiResponse({
    status: 201,
    description:
      "Newly generated 64-hex token, returned once. The store keeps it with " +
      "isSecret=true, so later GET /config returns '***' for it.",
    type: ExecutorSharedTokenDto,
  })
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
  @ApiResponse({
    status: 200,
    description:
      "Current token in plaintext. A missing key is NOT a 404: it degrades to " +
      "{token:null, hasToken:false} (admin-web relies on that to render the " +
      "'not configured yet' state).",
    type: ExecutorSharedTokenStatusDto,
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
  @ApiResponse({
    status: 200,
    description:
      "Effective contract constants only (no config-store values, no secrets). " +
      "Deliberately NOT ADMIN-gated — every user who can create a task needs the " +
      "correct range in the form.",
    type: RuntimeVersionContractDto,
  })
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
  @ApiResponse({
    status: 200,
    description:
      "The config row for this key. A secret key has value replaced by '***'. " +
      "A missing key is a 404.",
    type: SystemConfigResponseDto,
  })
  async findOne(@Param("key") key: string) {
    const c = await this.configService.findOne(key);
    return c.isSecret ? { ...c, value: "***" } : c;
  }

  @Put()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Create or update a config entry" })
  // ARCH-23 / N-12：写面回显**真实值**（不做掩码）——S3 的 '***' 哨兵只在
  // isSecret 且行已存在时表示"保持原值"，读回来的仍是库中真值。
  @ApiResponse({
    status: 200,
    description:
      "The persisted config row after upsert (real value, not masked — a " +
      "submitted '***' on an existing secret key means 'keep stored value')",
    type: SystemConfigResponseDto,
  })
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
  // ARCH-23 / N-12：整批包在单事务内，返回**与入参同序**的结果数组。
  @ApiResponse({
    status: 201,
    description:
      "Persisted rows in the same order as the submitted items (transactional: " +
      "any failure rolls the whole batch back). Real values, not masked.",
    type: [SystemConfigResponseDto],
  })
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
  @ApiResponse({
    status: 200,
    description:
      "Always {deleted:true} on success; a missing key is a 404 (there is no " +
      "{deleted:false} branch).",
    type: ConfigDeleteResultDto,
  })
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
