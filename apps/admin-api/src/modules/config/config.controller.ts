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
import { ConfigService as NestConfigService } from "@nestjs/config";
import { getExecutorSharedToken } from "../../common/utils/verify-executor-token.util";
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
  constructor(
    private readonly configService: SystemConfigService,
    private readonly nestConfigService: NestConfigService,
  ) {}

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
  @ApiOperation({ summary: "列出所有配置项" })
  @ApiResponse({
    status: 200,
    description:
      "按 key 排序的配置行（可选按前缀/标签过滤）。敏感行的值替换为掩码 '***'。",
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
  @ApiOperation({ summary: "获取配置变更历史" })
  @ApiResponse({
    status: 200,
    description:
      "分页历史，最新在前。持久化 isSecret=true 的行（或该 key 当前为敏感配置）其 oldValue/newValue 会掩码为 '***'；null 仍为 null。",
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
  @ApiOperation({ summary: "获取指定配置 key 的历史" })
  @ApiResponse({
    status: 200,
    description:
      "单个 key 的分页历史。持久化 isSecret=true 的行（或该 key 当前为敏感配置）其 oldValue/newValue 会掩码为 '***'；null 仍为 null。",
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
  @ApiOperation({ summary: "将配置回滚到历史版本" })
  // ARCH-23 / N-12：本端点**真的有两种成功形态**（ConfigService.rollback）：
  //   ① 普通回滚（update/delete 历史）→ 返回写回后的 SystemConfig 实体；
  //   ② 回滚一条 action='create' 的历史（= 撤销创建）→ 返回 {deleted:true}。
  // 只标一种就是"文档按想象写"（前端会照它写代码然后拿到另一种形状），故用
  // oneOf 如实表达。注意这里不能写 `type: SystemConfig`（实体无 @ApiProperty
  // → 空壳 schema → PK-15 闸红），必须 $ref 响应 DTO。
  @ApiResponse({
    status: 201,
    description:
      "回滚后的配置行；若目标历史行是该 key 的创建记录，则返回 {deleted:true}（回滚 = 撤销创建）",
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
  @ApiOperation({ summary: "生成或轮换执行器共享令牌" })
  @ApiResponse({
    status: 201,
    description:
      "新生成的 64 位十六进制令牌，仅返回一次。存储时 isSecret=true，因此之后 GET /config 对它返回 '***'。",
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
        description: "执行器共享令牌（由中台自动生成，敏感）",
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
  @ApiOperation({ summary: "获取当前执行器共享令牌（明文，仅管理员）" })
  @ApiResponse({
    status: 200,
    description:
      "以明文返回当前令牌。key 不存在并不是 404：会降级为 {token:null, hasToken:false}（admin-web 依赖该形态渲染「尚未配置」状态）。",
    type: ExecutorSharedTokenStatusDto,
  })
  async getExecutorSharedToken() {
    // P1-1（UIAUDIT4）：与 verifyExecutorToken **同一解析顺序**（DB 优先、
    // env executor.sharedToken/EXECUTOR_SECRET 兜底）。此前本端点只读 DB——
    // env 配置形态（demo 栈/compose 部署）下执行器认证全部走 env 兜底且
    // 一直可用，而向导的 Token 卡片却显示「尚未配置」：同一设置两个视角
    // 不一致，还诱导了「生成一个 DB token」的危险操作（DB token 一旦写入，
    // 校验基准切换，仍持 env 密钥的执行器全体 401——demo 实测踩中）。
    const token = await getExecutorSharedToken(
      this.nestConfigService,
      this.configService,
    );
    return { token, hasToken: !!token };
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
    description:
      "返回当前生效的可声明范围（min/max，可用 PYTHON_RUNTIME_VERSION_MIN/MAX 覆盖）、在线下载下限（onlineMin），以及未上报解释器的执行器所使用的历史回退解释器。前端把这些值注入版本辅助函数，而不是硬编码。仅返回契约常量——不含配置存储的值，也不含任何密钥。",
    summary: "获取权威的 Python 运行时版本契约",
  })
  @Get("runtime-version")
  @ApiResponse({
    status: 200,
    description:
      "仅返回生效的契约常量（不含配置存储的值，也不含密钥）。刻意不做 ADMIN 限制——每个能创建任务的用户都需要表单里有正确的范围。",
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
  @ApiOperation({ summary: "获取单个配置项" })
  @ApiResponse({
    status: 200,
    description:
      "该 key 的配置行。敏感配置的 value 替换为 '***'。key 不存在时返回 404。",
    type: SystemConfigResponseDto,
  })
  async findOne(@Param("key") key: string) {
    const c = await this.configService.findOne(key);
    return c.isSecret ? { ...c, value: "***" } : c;
  }

  @Put()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "创建或更新配置项" })
  // ARCH-23 / N-12：写面回显**真实值**（不做掩码）——S3 的 '***' 哨兵只在
  // isSecret 且行已存在时表示"保持原值"，读回来的仍是库中真值。
  @ApiResponse({
    status: 200,
    description:
      "upsert 后已持久化的配置行（真实值，未掩码——对已存在的敏感 key 提交 '***' 表示「保留已存储的值」）",
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
  @ApiOperation({ summary: "批量创建或更新配置项" })
  // ARCH-23 / N-12：整批包在单事务内，返回**与入参同序**的结果数组。
  @ApiResponse({
    status: 201,
    description:
      "按提交顺序持久化的行（事务性：任一条失败整批回滚）。真实值，未掩码。",
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
  @ApiOperation({ summary: "删除配置项" })
  @ApiResponse({
    status: 200,
    description:
      "成功时始终返回 {deleted:true}；key 不存在时返回 404（没有 {deleted:false} 分支）。",
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
