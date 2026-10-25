import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Headers,
  Param,
  Patch,
  Query,
  Delete,
  HttpCode,
  HttpStatus,
  Res,
  Logger,
  Optional,
  Inject,
} from "@nestjs/common";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染）。AppError 按状态码挂到对应内置异常原型上，故既有按异常类
// 断言的 spec 不受影响。
import { AppError } from "../../common/errors/app-error";
import { Response } from "express";
import { existsSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { join, resolve } from "path";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiParam,
  ApiBody,
  ApiQuery,
  ApiOkResponse,
  ApiCreatedResponse,
} from "@nestjs/swagger";
// ARCH-23 / N-12（2026-10-07 批）：执行器域响应契约。
import {
  ExecutorCommandResultResponseDto,
  ExecutorConfigPayloadResponseDto,
  ExecutorExecutionsResponseDto,
  ExecutorHeartbeatResponseDto,
  ExecutorPickerResponseDto,
  ExecutorPullResponseDto,
  ExecutorRemovalImpactResponseDto,
  ExecutorReloadConfigResponseDto,
  ExecutorRegisterResponseDto,
  ExecutorResponseDto,
  ExecutorTokenResponseDto,
} from "./dto/executor-response.dto";
import { ConfigService } from "@nestjs/config";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
// E-5：API-Key 主体判定（机器凭据不得借属主身份过项目角色判定）。
import {
  ApiKeyUser,
  isApiKeyUser,
} from "../../common/interfaces/auth-user.interface";
import { ProjectAccessService } from "../project/project-access.service";
// A2/A2-B：写端点授权形态声明 + 运行时证据落证（ownership scope 强制要求）。
// WriteGuard 装饰器本文件已 import（register 的 token 形态在用）。
import { recordOwnershipAssertion } from "../../common/guards/ownership-assertion.store";
import { ExecutorService } from "./executor.service";
import { UserRole } from "../users/entities/user.entity";
import { INSTALL_SCRIPT } from "./install-script.content";
import { SystemConfigService } from "../config/config.service";
import axios from "axios";
import { PaginationDto } from "../../common/dto/pagination.dto";
// PK-19: pull 端点请求体 Swagger 文档 DTO（运行时 @Body() 仍为内联类型）。
import { ExecutorPullDto } from "./dto/executor-pull.dto";
// PK-03（DEEP_REVIEW 0ef3bbe）: register/heartbeat 请求体具名 DTO（文档型，
// 运行时 @Body() 仍为内联类型——避免 forbidNonWhitelisted 误杀 executor 协议字段）。
import { ExecutorRegisterDto } from "./dto/executor-register.dto";
import { ExecutorHeartbeatDto } from "./dto/executor-heartbeat.dto";
// P2-4（2026-10-26 第三轮审计）：command-result 请求体 class DTO——这个端点
// **运行时**也换 class（白名单校验生效），与 register/heartbeat 的文档型豁免
// 不同（本端点字段集合是执行器上报面的闭集，见 DTO 头注）。
import { ExecutorCommandResultDto } from "./dto/executor-command-result.dto";
// F-53（UIAUDIT P2-2）：rotate-token / DELETE 的人操作面可选 reason class DTO
// （机器协议内联体仍是 PK-19 有意豁免，见各端点头注）。
import { ExecutorActionReasonDto } from "./dto/executor-action-reason.dto";
import { verifyExecutorToken } from "../../common/utils/verify-executor-token.util";
import {
  assertAndPinExecutorUrl,
  pinnedAxiosConfig,
} from "../../common/utils/safe-http.util";
// EXE-VER-1: heartbeat 响应回显版本合规态（EXECUTOR_MIN_VERSION）
import { isVersionCompliant } from "./version-compare.util";
// PROTOCOL-VER（B-3/U-2）：协议版本兼容矩阵（register 回显 protocolCompliant）。
import {
  PROTOCOL_SUPPORTED_MIN,
  isProtocolCompliant,
  // ARCH-33（ADR-016）：控制面命令通道的协议门禁（>= 2 才下发 commands）。
  supportsControlPlane,
} from "./protocol-compat.util";
// ARCH-32: pull 派发长轮询端点（ADR-015）
import { ExecutorPullService } from "./executor-pull.service";

/**
 * P2-4：命令元数据形态（acf:cmdmeta 读面）——直接复用 ExecutorPullService
 * 的返回类型（单一事实源，meta 形状演进时本文件零改动）。
 */
type ExecutorCommandMeta = Awaited<
  ReturnType<ExecutorPullService["getCommandMeta"]>
>;
// E-1（中台↔执行器深度审查）：pull 配置热更新——configVersion 指纹 + 配置拉取端点。
import {
  buildExecutorConfigPayload,
  computeExecutorConfigFingerprint,
} from "./executor-config-fingerprint.util";
// BUG-01：401 重签重试可观测计数——走 runtime-metrics 模块级入口（与
// TaskService / NotificationService 的埋点方式一致，无模块环、零 DI 接线），
// 由 PrometheusMetricsService 的 render 快照模式渲染为
// autoflow_push_auth_retry_total{result} series。
import { recordRuntime } from "../metrics/runtime-metrics-entry";
import { WriteGuard } from "../../common/decorators/write-guard.decorator";
// A6（DEEP_REVIEW §七）: 死信对账端点的响应契约 + 窗口上界常量。
// F-41（UIUX 审计 P1-2）：详情路由参数 ID 形态校验（/executors/not-exist 旧实现 500）。
import { ParseUuidShapePipe } from "../../common/pipes/parse-uuid-shape.pipe";
import { TerminalStatesResponseDto } from "./dto/executor-terminal-states.dto";
import {
  TERMINAL_STATES_MAX_LOOKBACK_MS,
  TERMINAL_STATES_DEFAULT_LOOKBACK_MS,
} from "./executor.service";
// python_task_multiversion（WS2 · CONTRACT §2.2）：上报面解释器清单条目的
// 结构类型（与 service / 实体同一份定义，避免内联字面量漂移）。
import type { ExecutorInterpreter } from "./interpreter-match.util";
// R3-A（部署模型评审 §4.3）：设备级应用版本事实/已安装包清单（结构校验在
// service 侧 deployed-apps.util.ts，controller 只做 F-7 白名单转发）。
import type {
  DeployedAppReport,
  InstalledPackageReport,
} from "./deployed-apps.util";
import {
  ExecutorGroupsDto,
  ExecutorInstallCmdDto,
  ExecutorMetricsDto,
  ExecutorOfflineDto,
  ExecutorRotateTokenDto,
  ExecutorRuntimeConfigDto,
  ExecutorTagsDto,
} from "../../common/dto/misc-2xx-response.dto";

/**
 * P3-2（2026-10-26 第三轮审计）：pull 长轮询等待窗口的**硬帽**（55s）。
 *
 * `executor.pullWaitMs` 是运维可调配置，此前只按它钳位——一个 >60s 的配置会
 * 让长轮询打穿反代通用 60s 读超时（请求被 504/断流，执行器侧表现为随机失败）。
 * 55s 与 dto/executor-pull.dto.ts `waitMs` 的 Swagger 承诺（「上限 55s」）及
 * sop-collab 控制器的 POLL_MAX_WAIT_MS=25s 同一纪律：服务端阻塞窗口必须 <
 * 反代读超时。Math.min 三钳：min(请求值, 配置值, 55s)。
 */
const PULL_WAIT_HARD_CAP_MS = 55_000;

/**
 * R11: true when the executor answered a reload-config push with an HTTP 401
 * AUTH VERDICT (as opposed to a connect/timeout failure, which must not
 * trigger the token re-issue retry). Both executor implementations answer
 * 401 with `{ error: 'Invalid or missing executor token' }`; the status is
 * checked first and the body text only as a fallback for proxies that strip
 * the status.
 */
function isUnauthorizedPushError(err: unknown): boolean {
  const response = (
    err as { response?: { status?: number; data?: unknown } } | undefined
  )?.response;
  if (response?.status === 401) return true;
  const data = response?.data;
  if (data === undefined || data === null) return false;
  let text: string;
  try {
    text = typeof data === "string" ? data : JSON.stringify(data);
  } catch {
    return false;
  }
  return /\b401\b|unauthorized|invalid or missing executor token/i.test(text);
}

@ApiTags("Executors")
@Controller("executors")
export class ExecutorController {
  /** BUG-01：401 重签重试路径的 warn 日志（首发 401 / 重试结果）。 */
  private readonly logger = new Logger(ExecutorController.name);

  constructor(
    private readonly svc: ExecutorService,
    private readonly configService: ConfigService,
    private readonly systemConfigService: SystemConfigService,
    // ARCH-32: @Optional + 默认值同 eventBus/audit 先例——存量单测三参
    // 构造不破，pull 端点运行时显式守卫。
    @Optional()
    @Inject(ExecutorPullService)
    private readonly pullService: ExecutorPullService | null = null,
    // N-02③（ADR-013 2026-10-02 温和下放）：项目角色判定。@Optional + 缺席
    // 退化「仅 ADMIN」（assertCanManageMetadata fail-closed：projectAccess 为
    // null 时非 ADMIN 恒 403——与 application.service 先例同型，且比下放更严，
    // 不存在"缺席=全放行"的软失败面）。生产装配由 executor.module 的
    // ProjectsModule import 提供。置尾：存量四参手工构造（…, pullService）
    // 位次不破。
    @Optional()
    private readonly projectAccess: ProjectAccessService | null = null,
  ) {}

  /**
   * N-02③（ADR-013 2026-10-02 温和下放）：元数据面写权限判定——ADMIN 短路；
   * 否则须为该执行器所属项目的 editor 及以上。projectId 为 null 的执行器
   * （存量/平台级）维持仅 ADMIN（不进 hasProjectRole：resolveRole 对 null
   * 会落 DEFAULT_PROJECT_ID，语义不同）。viewer/非成员 403；projectAccess
   * 缺席（极简装配）退化为仅 ADMIN——fail-closed。
   *
   * E-5（2026-10-26 执行器域审计）：API-Key 主体**显式拒绝**。ApiKeyUser 无
   * role 字段（auth-user.interface.ts:30-36；jwt-auth.guard.ts 头注自证
   * 「RolesGuard 补偿不了：ApiKeyUser 没有 role 字段」），而本判定对非 ADMIN
   * 主体会拿 `user.id` 查项目角色——API-Key 的 userId 是 key 属主的**用户 id**，
   * 把机器凭据映射到属主的项目身份 = 凭据提权（key 属主是 editor ⇒ 任何持 key
   * 的进程都能改执行器元数据、影响标签亲和派发）。机器凭据的授权边界由
   * api-key-scope.util 的 method×path 矩阵承载，项目身份只属于人类会话。
   */
  private async assertCanManageMetadata(
    executor: { projectId?: string | null },
    user: AuthUser | ApiKeyUser | undefined,
  ): Promise<void> {
    if (isApiKeyUser(user)) {
      throw new AppError("EXECUTOR_METADATA_FORBIDDEN");
    }
    if (user?.role === UserRole.ADMIN) {
      recordOwnershipAssertion("executor", "write");
      return;
    }
    const projectId = executor.projectId ?? null;
    const allowed =
      !!user?.id &&
      !!projectId &&
      !!this.projectAccess &&
      (await this.projectAccess.hasProjectRole(user.id, projectId, "editor"));
    if (!allowed) {
      throw new AppError("EXECUTOR_METADATA_FORBIDDEN");
    }
    recordOwnershipAssertion("executor", "write");
  }

  @Public()
  @WriteGuard("executor", {
    scope: "token",
    reason: "执行器持静态共享令牌注册（机器面，非用户会话）",
  })
  @Post("register")
  @ApiOperation({
    description: "执行器启动时调用，用于向中台注册。鉴权需要共享令牌。",
    summary: "注册执行器",
  })
  // PK-03（DEEP_REVIEW 0ef3bbe）: 从 example-only 改为具名 DTO $ref。
  @ApiBody({
    description: "注册信息",
    type: ExecutorRegisterDto,
  })
  // R7: register 实际 201（POST 无 @HttpCode），example-only 200 是伪覆盖。
  @ApiCreatedResponse({
    type: ExecutorRegisterResponseDto,
    description:
      "Registered；含 perExecutorToken/tokenHash 回调凭据与 protocolCompliant 协议门禁读数",
  })
  async register(
    @Body()
    body: {
      appName: string;
      address: string;
      type?: string;
      version?: string;
      // PROTOCOL-VER（B-3/U-2）：执行器上报的协议版本（可选，整数）；
      // 白名单转发 + service 侧兼容性分支（低于下限 warn + 兜底，不拒绝）。
      protocolVersion?: number;
      capabilities?: string[];
      runtime?: string[];
      maxConcurrentTasks?: number;
      maxConcurrent?: number;
      groupName?: string | null;
      tags?: string[] | null;
      description?: string | null;
      restartedAt?: string | null;
      startupId?: string | null;
      // ARCH-32: 派发模式自报（'push' | 'pull'，缺省 push；白名单校验在
      // service 侧——枚举外值一律落回 push）。
      dispatchMode?: string;
      // python_task_multiversion（WS2 · CONTRACT §2.3）：解释器缓存池清单
      // （可选；结构校验与采纳规则在 service 侧——非法即整字段拒绝采纳）。
      interpreters?: ExecutorInterpreter[];
      // ARCH-36（ADR-017 阶段 2/3）：稳定设备指纹（可选；规范化与采纳规则在
      // service 侧——缺省/非法一律不动 DB 值）。阶段 3 起它是 register 的**行
      // 定位键**（指纹优先、address 兜底），见 executor.service.register 注释。
      deviceFingerprint?: string | null;
      // R3-A（部署模型评审 §4.3）：设备级应用版本事实/已安装包清单（可选；
      // 语义与心跳完全一致——执行器重启后随注册先报一份，缺省 → 不动 DB）。
      deployedApps?: DeployedAppReport[];
      installedPackages?: InstalledPackageReport[];
    },
    @Headers("authorization") auth: string,
  ) {
    await verifyExecutorToken(
      auth,
      this.configService,
      this.systemConfigService,
    );
    // F-7: build the payload explicitly — the inline type above is compile-time
    // only, so a raw `body` would carry client-supplied `id` / `tokenHash` /
    // `status` / `runningTaskCount` / optimistic-lock `version` straight into
    // repo.create() and let a caller hijack or overwrite arbitrary columns.
    const payload = {
      appName: body.appName,
      address: body.address,
      type: body.type,
      version: body.version,
      // PROTOCOL-VER（B-3/U-2）：协议版本经 F-7 白名单转发（漏了这行 =
      // 上报被静默丢弃，兼容矩阵无从分支）。
      protocolVersion: body.protocolVersion,
      capabilities: body.capabilities,
      runtime: body.runtime,
      maxConcurrentTasks: body.maxConcurrentTasks,
      maxConcurrent: body.maxConcurrent,
      groupName: body.groupName,
      tags: body.tags,
      description: body.description,
      restartedAt: body.restartedAt,
      startupId: body.startupId,
      dispatchMode: body.dispatchMode,
      // python_task_multiversion（WS2）：转发解释器清单——F-7 显式白名单是
      // 唯一入站通道（内联 @Body() 类型是编译期的，运行时不裁剪），漏了这行
      // 会让上报被静默丢弃且无任何报错。
      interpreters: body.interpreters,
      // ARCH-36（ADR-017 阶段 2）：转发设备指纹（同一 F-7 白名单纪律——
      // 漏这行 = 上报被静默丢弃，冲突观测拿不到数据）。
      deviceFingerprint: body.deviceFingerprint,
      // R3-A（§4.3）：转发设备级应用版本事实与已安装包清单（同一 F-7 白名单
      // 纪律；落库语义与心跳共用同一实现）。
      deployedApps: body.deployedApps,
      installedPackages: body.installedPackages,
    };
    // N4: register + token issuance is idempotent per (address, startupId) —
    // a duplicate register from the SAME process life (same startupId, no
    // restart) returns perExecutorToken=null instead of rotating, so residual
    // processes retrying register every 30s can no longer invalidate the live
    // executor's token. Rotation still happens on first registration, on a
    // genuine restart, and for legacy executors that report no startupId.
    const { executor, perExecutorToken } =
      await this.svc.registerExecutor(payload);
    // N26 (round-8): return the stored tokenHash alongside the registration.
    // The executor uses it as the HMAC source secret for per-execution
    // callback tokens (AUTOFLOW_CALLBACK_TOKEN), which lets admin-api verify
    // those tokens statelessly against the same value it already holds.
    // This grants nothing new to the caller: it authenticated with the raw
    // per-executor/shared token, from which the hash is derived, and the
    // bcrypt hash is not a preimage leak.
    // ADR-017 阶段 3：按 id 取（pull 同地址多行时按 address 取会有歧义）。
    const tokenHash = await this.svc.getCallbackSecretById(executor.id);
    // PROTOCOL-VER（B-3/U-2）：回显协议合规态（与 heartbeat 的
    // versionCompliant 同款加法字段，旧消费方无感）。compat 判定在 service 侧
    // 完成（PROTOCOL_SUPPORTED_MIN），此处只回显结论供执行器/运维观测。
    return {
      ...executor,
      perExecutorToken,
      tokenHash,
      protocolCompliant: isProtocolCompliant(
        executor.protocolVersion,
        PROTOCOL_SUPPORTED_MIN,
      ),
    };
  }

  @Public()
  // SEC-09: 机器心跳面豁免分域档位——心跳节奏由 EXECUTOR_HEARTBEAT_INTERVAL
  // 决定（默认 30s = 2/min/执行器），多执行器共享出口 IP 时按 IP 计数的
  // strict/ops 档位会误杀心跳；本路由保持全局默认档兜底（分域矩阵见
  // src/config/throttle-profiles.ts 头注）。
  @WriteGuard("executor", {
    scope: "token",
    reason: "执行器持 per-executor 令牌上报心跳",
  })
  @Post("heartbeat")
  @ApiOperation({
    description:
      "执行器周期性调用本接口上报状态，包括 CPU、内存与运行中任务数。",
    summary: "心跳上报",
  })
  // PK-03（DEEP_REVIEW 0ef3bbe）: 从 example-only 改为具名 DTO $ref。
  @ApiBody({
    description: "心跳数据",
    type: ExecutorHeartbeatDto,
  })
  @ApiCreatedResponse({
    type: ExecutorHeartbeatResponseDto,
    description:
      "已保存的执行器 + 回调鉴权密钥 + 版本闸门读数（POST 默认 201）",
  })
  @ApiResponse({ status: 401, description: "执行器令牌无效" })
  async heartbeat(
    @Body()
    body: {
      address: string;
      cpuUsage?: number;
      memUsage?: number;
      diskUsage?: number;
      networkLatency?: number;
      runningTaskCount?: number;
      totalTaskCount?: number;
      failedTaskCount?: number;
      restartedAt?: string | null;
      startupId?: string | null;
      // CONSISTENCY-02: executor-node 活性上报（可选，旧版执行器缺省即不传）。
      runningExecutionIds?: string[];
      // E-01-RPT（生产实证：RPA5「当前运行任务 1/10、活性上报 0 条」）：
      // pull 长轮询「已预留但尚未认领」的槽位数（可选，旧版执行器缺省即不传）。
      // 只用于展示/告警换算（实际运行 = runningTaskCount − reservedSlots），
      // **不参与派发闸门**。
      reservedSlots?: number;
      deadLetterCount?: number;
      // E9: 执行器热更新容量后随心跳上报（可选；范围校验在 service 侧，
      // 非法/缺失不改 DB 值）。
      maxConcurrentTasks?: number;
      // EXE-VER-1: 执行器版本随心跳上报（可选；不落库，仅用于
      // EXECUTOR_MIN_VERSION 门禁开启时在响应中回显合规态）。
      version?: string;
      // python_task_multiversion（WS2 · CONTRACT §2.3）：解释器缓存池清单
      // （可选；缺省即保留 DB 旧值，结构校验在 service 侧）。
      interpreters?: ExecutorInterpreter[];
      // ARCH-36（ADR-017 阶段 2）：稳定设备指纹（可选；缺省/非法即保留 DB
      // 旧值，规范化在 service 侧）。
      deviceFingerprint?: string | null;
      // R3-A（部署模型评审 §4.3）：设备级应用版本事实（可选；缺省 → 中台
      // 完全不动 executor_app_versions 既有行——旧执行器零影响）。
      deployedApps?: DeployedAppReport[];
      // R3-A（§4.3/P10）：已安装执行器包清单（可选；三态语义同 interpreters）。
      installedPackages?: InstalledPackageReport[];
    },
    @Headers("authorization") auth: string,
  ) {
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
    // ADR-017 阶段 3：指纹优先认证——pull 同地址多行并存时按指纹命中自己的行，
    // 换 IP 后注册未到（竞态）时心跳仍能通过（legacy 执行器不传指纹，行为不变）。
    const isValid = await this.svc.validateTokenByAddress(
      body.address,
      token,
      body.deviceFingerprint,
    );
    if (!isValid) {
      throw new AppError("INVALID_EXECUTOR_TOKEN");
    }
    // F-2: forward only the whitelisted metric fields. A raw `body` would let
    // an authenticated executor overwrite server-owned columns such as
    // tokenHash (persistent auth backdoor surviving shared-token rotation),
    // runningTaskCount (scheduling manipulation) or the optimistic-lock
    // version. The service applies a second whitelist of its own.
    const metrics = {
      cpuUsage: body.cpuUsage,
      memUsage: body.memUsage,
      diskUsage: body.diskUsage,
      networkLatency: body.networkLatency,
      runningTaskCount: body.runningTaskCount,
      totalTaskCount: body.totalTaskCount,
      failedTaskCount: body.failedTaskCount,
      restartedAt: body.restartedAt,
      startupId: body.startupId,
      // CONSISTENCY-02: 转发活性上报，字段级校验与裁剪在 service 侧完成。
      runningExecutionIds: body.runningExecutionIds,
      // E-01-RPT: 转发 pull 预留槽位数（F-2 显式白名单，漏转发 = 上报被静默
      // 丢弃，UI 会一直显示「1/10 + 不一致」）。范围校验在 service 侧。
      reservedSlots: body.reservedSlots,
      deadLetterCount: body.deadLetterCount,
      // E9: 转发容量热更新值，正整数 1..10000 校验在 service 侧完成。
      maxConcurrentTasks: body.maxConcurrentTasks,
      // python_task_multiversion（WS2）：转发解释器清单（F-2 显式白名单，
      // 漏转发 = 上报被静默丢弃）。
      interpreters: body.interpreters,
      // ARCH-36（ADR-017 阶段 2）：转发设备指纹（心跳是主要重复观测点——
      // 两台机器并存时各自 30s 一次的心跳都会走到 service 的观测器）。
      deviceFingerprint: body.deviceFingerprint,
      // R3-A（§4.3）：转发设备级应用版本事实与已安装包清单（F-7 显式白名单，
      // 漏转发 = 上报被静默丢弃，中台事实源从此缺数据）。落库语义/结构校验
      // 在 service 侧（applyReportedAppVersions / deployed-apps.util.ts）。
      deployedApps: body.deployedApps,
      installedPackages: body.installedPackages,
    };
    const saved = await this.svc.heartbeat(body.address, metrics);
    // R9 (round-8 P1 closure, W3): echo the CURRENT stored tokenHash with
    // every heartbeat (same posture as register, which already returns it —
    // the caller proved possession of a valid per-executor/shared token).
    // executor-node adopts it in scheduler.sendHeartbeat so the N26
    // per-execution callback HMAC secret follows admin-side rotations
    // (admin-UI rotate-token, register-time issuance) without a re-register.
    //
    // G3（R32-A3）：按 **id** 取，不按地址。pull 同址多行（ADR-017 §5）下
    // resolveExecutorRow 对「裸地址」是 fail-closed 的（多行 → null），于是
    // 按地址取必然得到 null：心跳响应 tokenHash 恒为 null，执行器永远学不到
    // 轮换后的回调密钥，N26 的 per-execution 回调令牌在下次重注册前全部 401。
    // register 路径早已是这个修法（见上方 register 的 getCallbackSecretById
    // 与「按 id 取是无歧义的」注释），heartbeat 此前漏改。
    // 代价是绕开 callbackSecretCache（每台每 30s 一次索引查），与 register 同量级。
    const tokenHash = await this.svc.getCallbackSecretById(saved.id);
    // EXE-VER-1: 回显版本合规态。门禁关（EXECUTOR_MIN_VERSION 空）时
    // minVersion=null / versionCompliant=true（加法字段，旧消费方无感）；
    // 门禁开时执行器侧据此打版本漂移告警。version 不落库。
    const minVersion =
      this.configService.get<string>("executor.minVersion") || "";
    return {
      ...saved,
      tokenHash,
      minVersion: minVersion || null,
      versionCompliant: isVersionCompliant(body.version, minVersion),
    };
  }

  @Public()
  // ARCH-32: 机器拉取面与 heartbeat 同理豁免分域档位——长轮询空闲态
  // ~2.4/min/执行器（25s 窗口阻塞在服务端），全局默认档兜底即可
  // （分域矩阵见 src/config/throttle-profiles.ts 头注）。
  @WriteGuard("executor", {
    scope: "token",
    reason: "执行器持 per-executor 令牌长轮询取件（ARCH-32）",
  })
  @Post("pull")
  // ARCH-32：这是「取件」语义（长轮询读载荷），不是资源创建——Nest 的 @Post
  // 默认回 201，会让客户端把它当新建处理，也与本端点的 @ApiResponse({status:200})
  // 自相矛盾。显式 200（e2e 用例 45 按 200 判定取件成功）。
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    description:
      "ARCH-32：pull 模式执行器（位于 NAT 后、无入站可达性）通过长轮询本端点接收派发载荷。最多阻塞 waitMs（服务端会做上限钳制），返回 { task }——队列为空时为 null。",
    summary: "拉取派发载荷（长轮询）",
  })
  @ApiOkResponse({
    type: ExecutorPullResponseDto,
    description: "waitMs 内无任务入队时 task=null",
  })
  @ApiResponse({ status: 401, description: "执行器令牌无效" })
  // PK-19（DEEP_REVIEW 0ef3bbe）: 此前 pull 端点用内联类型无 @ApiBody，openapi
  // 缺 requestBody。补 @ApiBody({ type: ExecutorPullDto })（运行时 @Body() 类型
  // 不变，纯文档）。
  @ApiBody({ type: ExecutorPullDto, description: "Pull 长轮询请求体" })
  async pullDispatch(
    @Body()
    body: {
      address: string;
      // 客户端期望的等待窗口；服务端按 EXECUTOR_PULL_WAIT_MS 钳位，并有
      // 55s 硬帽（P3-2，见 PULL_WAIT_HARD_CAP_MS）。
      waitMs?: number;
      // ARCH-33（ADR-016）：执行器当前空闲槽位数。缺省 = 未上报（旧执行器）
      // → 按「有空槽」处理，任务照常出队，行为与今日逐字节一致。
      //
      // 为什么需要它：pull 循环原本只在有空闲槽位时才长轮询（E-01 预留槽位
      // 方案）。若沿用，**执行器满载时控制命令永远送不到**——部署、停止、
      // 热更新全部静默失效。带上 freeSlots 后执行器始终长轮询，服务端据此
      // 决定是否出队任务（`freeSlots <= 0` 时**不出队**，见 pullWork）。
      freeSlots?: number;
      // ADR-017 阶段 3：稳定设备指纹（可选；旧执行器不传）。传入即用于
      // **唯一定位本行**——pull 模式允许同地址多行并存（ADR-017 §5），不传
      // 就只能按地址取，会同到别人的行、去拉别人的 Redis 队列。
      deviceFingerprint?: string | null;
      // 工单 11：执行器自报的**行 id**（注册响应下发、执行器持久化后回传）。
      // 仅在「同址多行 + 无指纹」的歧义态下作为**候选行提示**使用，且必须
      // 该行的 per-executor 令牌校验通过（共享令牌不采纳）。
      executorId?: string | null;
    },
    @Headers("authorization") auth: string,
    // P3-1（2026-10-26 第三轮审计）：passthrough Res——只挂 close 监听做断连
    // 探针，响应仍由框架按返回值序列化（passthrough 语义）。此前长轮询不感知
    // 断连：执行器断开后服务端仍每 500ms RPOP 到 waitMs 耗尽，窗口末端弹出的
    // 任务投给死 socket 必然丢失，还把队列里本可活到下一轮的载荷提前吞掉。
    @Res({ passthrough: true }) res?: Response,
  ) {
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
    // 工单 11（ADR-017 决策 §3 补全）：认证与行定位一次成型。
    // 差异之处只在「同址多行 + 无指纹」这一态：若执行器自报了**自己那行的 id**
    // 且该行的 per-executor 令牌校验通过，就按行定位（而不是 fail-closed 404）；
    // 共享令牌路径照旧不采纳自报 id（见 service 的安全边界注释）。
    const authz = await this.svc.authenticateMachineRequest(
      body.address,
      token,
      {
        deviceFingerprint: body.deviceFingerprint,
        reportedExecutorId: body.executorId,
      },
    );
    if (!authz.ok) {
      throw new AppError("INVALID_EXECUTOR_TOKEN");
    }
    if (!this.pullService) {
      throw new AppError("EXECUTOR_PULL_UNAVAILABLE");
    }
    const executor = authz.executor;
    if (!executor) {
      // 保留既有语义：认证通过但行仍无法唯一判定 → 404（执行器据此重注册/升级）。
      throw new AppError("EXECUTOR_NOT_FOUND");
    }
    // P3-1：断连探针。'close' 在连接提前断开（执行器超时放弃/网络抖动）时触发；
    // destroyed/writableEnded 兜住「监听挂上前就已断」与「框架已写完响应」两态。
    // res 缺省（直接 new Controller 的单测不经 HTTP）→ 探针恒 false = 不感知
    // 断连，行为与引入前一致。
    let clientGone = false;
    res?.on("close", () => {
      clientGone = true;
    });
    const isClientGone = () =>
      clientGone || (res ? res.destroyed || res.writableEnded : false);
    const maxWait =
      this.configService.get<number>("executor.pullWaitMs") ?? 25000;
    // SEC-PULL-01：原实现是 Math.max(0, Math.min(Number(body.waitMs ?? maxWait), maxWait))。
    // body.waitMs 来自 @Public()+token 的机器面且 DTO 无校验装饰器（内联类型，
    // ValidationPipe 不生效），因此 Number("abc") / Number({}) / Number("NaN")
    // 都会得到 NaN；NaN 会穿透 Math.min/max。NaN 传进 pull() 后
    // `deadline = Date.now() + NaN`，而 `Date.now() >= NaN` 恒为 false，
    // while(true) 永不 break —— 请求被永久挂住（每次还占一个 Redis 往返），
    // 属可远程触发的资源耗尽。此处显式做有限性校验，非法值回落到 maxWait。
    //
    // P3-2：55s **硬帽**（PULL_WAIT_HARD_CAP_MS）——executor.pullWaitMs 是运维
    // 可调配置，仅按它钳位时一个 >60s 的配置会打穿反代 60s 读超时（长轮询被
    // 反代 504/断流）。硬帽与 dto/executor-pull.dto.ts 的 Swagger 承诺
    // （「上限 55s」）对齐，Math.min 双钳：min(请求值, 配置值, 55s)。
    const requestedWait = Number(body.waitMs ?? maxWait);
    const waitMs = Number.isFinite(requestedWait)
      ? Math.max(0, Math.min(requestedWait, maxWait, PULL_WAIT_HARD_CAP_MS))
      : Math.min(maxWait, PULL_WAIT_HARD_CAP_MS);
    // ARCH-33: 任务出队门禁。缺省（未上报）按「有槽位」放行——存量旧执行器
    // 不发该字段，行为必须与今日一致。显式上报 0/负数 = 满载：只发命令。
    const wantTask =
      body.freeSlots === undefined || body.freeSlots === null
        ? true
        : Number(body.freeSlots) > 0;
    const isPull = executor.dispatchMode === "pull";
    // ARCH-33: 只有支持控制面协议的 pull 执行器才拿命令——协议 < 2 的执行器
    // 会忽略 commands 字段（中台侧 resolveExecutorTransport 已按同一判据回退
    // push，此处再守一道：响应体绝不携带对端不认识的语义字段）。
    const wantCommands =
      isPull && supportsControlPlane(executor.protocolVersion);
    const { task: payload, commands } = isPull
      ? await this.pullService.pullWork(executor.id, waitMs, {
          wantTask,
          // P3-1：断连探针下沉到取件循环（弹出任务前检查，断连即停）。
          isConnected: isClientGone,
        })
      : { task: null, commands: [] };
    return {
      task: payload ?? null,
      dispatchMode: executor.dispatchMode,
      // ARCH-33: 控制面命令（deploy / app-stop / app-uninstall /
      // config-reload / kill-execution / update-package）。空数组而非省略
      // 字段——执行器侧据此判定「中台是否支持命令通道」，省略会让 v2 执行器
      // 无法区分「没有命令」与「中台太旧」。
      ...(wantCommands ? { commands } : {}),
      // E-1（中台↔执行器深度审查）：附带配置指纹——pull 执行器检测到与本地
      // 已应用版本不一致时，主动 GET /api/executors/config 拉取全量配置热更新
      // （push 执行器仍走 admin 主动 POST /api/config/reload）。
      configVersion: computeExecutorConfigFingerprint(
        this.configService,
        executor,
      ),
    };
  }

  @Public()
  // ARCH-33（ADR-016）：命令执行结果上报。与 heartbeat 同属执行器出站机器面，
  // 鉴权同款（per-executor 令牌 + address 身份键）。best-effort 语义：中台侧
  // 只记日志 + 写短期结果键（排障读面），**不是**业务终态的事实源——deploy 由
  // /app-deployments/heartbeat 收敛，update-package 由 push-result 收敛。
  // P2-4（2026-10-26 第三轮审计）：内联 body 换 class DTO（ExecutorCommandResultDto
  // ——error ≤2000 / commandId UUID 形态，恢复全局管道白名单）+ cmdmeta 归属绑定。
  @WriteGuard("executor", {
    scope: "token",
    reason: "执行器上报 pull 控制命令的执行结果（ARCH-33，机器面非用户会话）",
  })
  @Post("command-result")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    description:
      "ARCH-33：pull 模式执行器上报其从 pull 响应中领取的控制命令（deploy / app-stop / app-uninstall / config-reload / kill-execution / update-package）的执行结果。属尽力而为——业务的终态仍通过各自的回调收敛。",
    summary: "上报 pull 控制命令的执行结果",
  })
  @ApiBody({ type: ExecutorCommandResultDto })
  @ApiOkResponse({ type: ExecutorCommandResultResponseDto })
  @ApiResponse({ status: 400, description: "载荷形态非法（DTO 白名单校验）" })
  @ApiResponse({ status: 401, description: "执行器令牌无效" })
  @ApiResponse({ status: 403, description: "命令不属于该执行器（跨行回报）" })
  async reportCommandResult(
    @Body()
    body: ExecutorCommandResultDto,
    @Headers("authorization") auth: string,
  ) {
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
    // P2-4：认证与行定位一次成型——authenticateMachineRequest 是
    // validateTokenByAddress 的超集（auth 判定语义逐字节一致，额外返回按
    // 指纹/地址定位到的行），归属比对需要「回报行」的身份。
    // 共享令牌 + 同址多行歧义时 executor 为 null（ok 仍可为 true）——该形态
    // 在下方归属比对里 fail-closed。
    const authz = await this.svc.authenticateMachineRequest(
      body.address,
      token,
      { deviceFingerprint: body.deviceFingerprint },
    );
    if (!authz.ok) {
      throw new AppError("INVALID_EXECUTOR_TOKEN");
    }
    if (!body.commandId || !body.type) {
      throw new AppError("EXECUTOR_COMMAND_RESULT_INVALID");
    }
    // P2-4（纵深缺口收口）：归属比对——cmdmeta 记录了命令的目标行（P2-4 起
    // 入队时增记 executorId）。任意执行器可对任意 commandId 回报的旧缺口在
    // 此关上：一条伪造的 ok=false 能把别人的部署行收成 FAILED。
    // 兼容：meta 缺失（存量命令 / Redis 抖动）→ 放行 + warn（升级窗口内
    // 30min TTL 的存量 meta 无 executorId，同走放行分支——语义一致）。
    let meta: ExecutorCommandMeta | null = null;
    try {
      meta = (await this.pullService?.getCommandMeta(body.commandId)) ?? null;
    } catch (err) {
      this.logger.warn(
        `Failed to resolve command meta for ${body.commandId} (ownership check skipped; the deployment row will ` +
          `converge through the stuck sweep): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (meta && meta.executorId) {
      const reporter = authz.executor;
      if (!reporter || reporter.id !== meta.executorId) {
        this.logger.warn(
          `Command result for ${body.commandId} (${body.type}) reported by ` +
            `${reporter?.id ?? "<unresolved row>"} @ ${body.address} but targeted at executor ` +
            `${meta.executorId} — rejecting cross-row report`,
        );
        throw new AppError("EXECUTOR_COMMAND_RESULT_NOT_OWNED", {
          commandId: body.commandId,
        });
      }
    } else if (!meta) {
      this.logger.warn(
        `Command result for ${body.commandId} (${body.type}) has no command meta ` +
          `(legacy command issued before ownership binding, or Redis hiccup) — ` +
          `accepting without ownership check`,
      );
    }
    if (body.ok) {
      this.logger.log(
        `Pull command ${body.type} (${body.commandId}) succeeded on ${body.address}` +
          (body.durationMs !== undefined ? ` in ${body.durationMs}ms` : ""),
      );
    } else {
      this.logger.warn(
        `Pull command ${body.type} (${body.commandId}) FAILED on ${body.address}` +
          `${body.status !== undefined ? ` (HTTP ${body.status})` : ""}: ${body.error ?? "unknown error"}`,
      );
    }
    await this.pullService?.recordCommandResult(body.commandId, {
      commandId: body.commandId,
      type: body.type,
      address: body.address,
      ok: body.ok === true,
      status: body.status ?? null,
      error: body.error ?? null,
      durationMs: body.durationMs ?? null,
      reportedAt: new Date().toISOString(),
    });
    // P0-4（生产报告 2026-10-22 §4.4）：失败结果必须**推进业务行**，不能只写
    // 日志 + 600s 的 Redis 结果键。执行器上报里只有 commandId，部署行 id 来自
    // 入队时记的旁路元数据（acf:cmdmeta:{id}）——上方归属比对已取回，此处
    // 直接复用（省一次 Redis GET）。best-effort：元数据缺失时静默跳过，收敛
    // 退回到既有的卡死扫描（与引入本机制前一致）。
    if (body.ok !== true) {
      if (meta && meta.type === "deploy" && meta.deploymentId) {
        this.svc.publishControlCommandFailure({
          commandId: body.commandId,
          type: meta.type,
          address: body.address,
          deploymentId: meta.deploymentId,
          error: body.error ?? null,
        });
      }
    }
    return { ok: true };
  }

  @Public()
  // E-1: 执行器机器面配置拉取端点（pull 模式热更新用；token 校验与 pull 同款）。
  @WriteGuard("executor", {
    scope: "token",
    reason: "执行器持 per-executor 令牌拉取生效配置（E-1 pull 配置热更新）",
  })
  @Get("config")
  @ApiOperation({
    description:
      "E-1: pull 执行器在长轮询响应中发现 configVersion 与本地不一致时调用，拉取与 admin 主动推送 /api/config/reload 同形的配置载荷（执行器侧走与 /api/config/reload 完全相同的校验与应用路径）。per-executor 令牌认证，address 走查询参数（与 register/heartbeat 同源）。",
    summary: "获取面向执行器的配置（pull 模式热更新）",
  })
  @ApiResponse({ status: 401, description: "执行器令牌无效" })
  @ApiOkResponse({ type: ExecutorConfigPayloadResponseDto })
  async pullExecutorConfig(
    @Query("address") address: string,
    @Headers("authorization") auth: string,
    // ADR-017 阶段 3：稳定设备指纹（可选查询参数；旧执行器不传）——pull
    // 同地址多行并存时用于唯一定位本行（ADR-017 §5）。
    @Query("deviceFingerprint") deviceFingerprint?: string,
    // 工单 11：执行器自报的行 id（歧义态下的候选行提示，见 pull 端点同款注释）。
    @Query("executorId") executorId?: string,
  ) {
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
    // 工单 11：认证 + 行定位一次成型（自报 id 只在「同址多行 + 无指纹」时
    // 作为候选提示，且必须该行的 per-executor 令牌校验通过）。
    const authz = await this.svc.authenticateMachineRequest(address, token, {
      deviceFingerprint,
      reportedExecutorId: executorId,
    });
    if (!authz.ok) {
      throw new AppError("INVALID_EXECUTOR_TOKEN");
    }
    if (!authz.executor) {
      throw new AppError("EXECUTOR_NOT_FOUND");
    }
    return buildExecutorConfigPayload(this.configService, authz.executor);
  }

  @Public()
  // A6: 与 heartbeat/pull 同属执行器机器面——对账由执行器后台循环按固定间隔
  // 拉取（默认 10 分钟级，且本地无死信时完全不发请求），多执行器共享出口 IP
  // 时按 IP 计数的 strict/ops 档位同样会误杀，故沿用全局默认档兜底。
  @WriteGuard("executor", {
    scope: "token",
    reason: "执行器持 per-executor 令牌对账本地死信回调（A6），非用户会话面",
  })
  @Get(":address/terminal-states")
  @ApiOperation({
    description:
      "A6（DEEP_REVIEW）：针对执行器本地回调死信目录的只读对账视图。返回该执行器上已进入终态（success/failed/timeout/killed/cancelled）的执行记录，按终态时间升序排列，便于调用方当作水位线流消费。执行器用它给死信分级处理：执行已终态的死信回调已无意义（直接删除）；执行仍未结束且死信原因是重试预算耗尽的，值得重新入队；毒载荷（超大/损坏）保留待人工排查。严格只读——不改任何状态、不释放名额、不写审计；所有状态变更仍走既有的回调/终态路径。",
    summary: "对账终态执行记录（只读）",
  })
  @ApiParam({
    name: "address",
    description: "执行器注册地址（与心跳使用同一个值）",
  })
  @ApiQuery({
    name: "since",
    required: false,
    description:
      "ISO-8601 水位线；仅返回终态时间（COALESCE(endTime, createdAt)）>= since 的执行记录。默认最近 24 小时；最多钳制到 30 天。",
    example: "2026-09-14T08:00:00.000Z",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description:
      "每页条数（1..2000，默认 500）。hasMore=true 表示还有更多数据。",
    example: 500,
  })
  @ApiResponse({
    status: 200,
    description: "终态记录分页",
    type: TerminalStatesResponseDto,
  })
  @ApiResponse({ status: 401, description: "执行器令牌无效" })
  async getTerminalStates(
    @Param("address") address: string,
    @Query("since") since?: string,
    @Query("limit") limit?: string,
    @Headers("authorization") auth?: string,
    // ADR-017 阶段 3：稳定设备指纹（可选查询参数；旧执行器不传）——pull
    // 同地址多行并存时用于唯一定位本行（ADR-017 §5）。
    @Query("deviceFingerprint") deviceFingerprint?: string,
    // 工单 11：执行器自报的行 id（歧义态下的候选行提示）。
    @Query("executorId") reportedExecutorId?: string,
  ) {
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
    const authz = await this.svc.authenticateMachineRequest(address, token, {
      deviceFingerprint,
      reportedExecutorId,
    });
    if (!authz.ok) {
      throw new AppError("INVALID_EXECUTOR_TOKEN");
    }
    // ADR-017 阶段 3（决策 §7 读面富化）+ 工单 11：行身份直接取认证结果。
    // 阶段 3 起同址多行并存（ADR-017 §5），service 内无法从地址推出是哪一行；
    // authenticateMachineRequest 已经把「令牌绑定的那行」算出来了（指纹 → 地址
    // → 自报 id 三级，最后一级只在按行令牌校验通过时采纳），故不再二次解析。
    // 解析不到唯一行时传 null，service 回落地址判据，行为与引入前逐字节一致。
    const resolved = authz.executor;
    const parsedLimit = Number(limit);
    return this.svc.getTerminalStates(address, {
      since: this.parseTerminalSince(since),
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      executorId: resolved?.id ?? null,
    });
  }

  /** since 解析：非法/缺失回退 24h，过老钳到 30 天上界（理由见 service 常量注释）。 */
  private parseTerminalSince(since?: string): Date {
    const now = Date.now();
    if (since) {
      const parsed = Date.parse(since);
      if (!Number.isNaN(parsed)) {
        return new Date(
          Math.max(parsed, now - TERMINAL_STATES_MAX_LOOKBACK_MS),
        );
      }
    }
    return new Date(now - TERMINAL_STATES_DEFAULT_LOOKBACK_MS);
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Get()
  // N11 复核后不对列表做 ADMIN 收紧：任务 CRUD 对普通用户开放，且 executions
  // 列表/过滤（executorAddress）本就向所有登录用户暴露执行器地址——单独锁住
  // 列表既挡不住信息（可经 executions 侧信道获得）又会打断 TaskFormPage 的
  // 执行器下拉。凭证类面（notification/ai config）仍为 ADMIN。
  @ApiOperation({
    // F-55（UIAUDIT 后端轮 P3-2）：契约如实化——本端点**不支持分页**，此前
    // live 实测 `?page=99999999&pageSize=50` 被**静默忽略**（收下参数不生效，
    // API-07 同型「参数收下不生效」缺陷）：调用方以为在翻页，执行器数超过
    // 截断上限时第 2 页返回与第 1 页完全相同的前缀行。真分页（PageQueryDto
    // 下推 DB + 分页元数据）会改响应形状（数组 → {items,total,…} 信封），
    // 打断 admin-web / acf-cli / mcp-server 四端消费方——登记 fix-b1 报告
    // 「待拍板」，本轮只把截断行为写进契约（OpenAPI 如实描述）。
    description:
      "获取执行器列表（按 createdAt 降序），包含在线状态、分组与标签。" +
      "**不支持分页**：page/pageSize 等查询参数不被接受（忽略而非报错）；" +
      "服务端按创建时间只返回最新 EXECUTOR_LIST_LIMIT（500）台，超出部分被截断。" +
      "截断信号：GET /executors/runtime-config 的 listLimit/executorTotal 字段，" +
      "调用方在 total > listLimit 时须呈现「仅显示前 N / 共 M 台」类告警，" +
      "不得把截断结果当作全量。",
    summary: "列出执行器（截断上限见描述；不支持分页）",
  })
  @ApiOkResponse({ type: [ExecutorResponseDto] })
  findAll() {
    return this.svc.findAll();
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Get("groups")
  @ApiOkResponse({ type: ExecutorGroupsDto })
  @ApiOperation({
    description: "获取全部执行器分组及其执行器数量统计。",
    summary: "获取全部执行器分组",
  })
  getGroups() {
    return this.svc.getGroups();
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Get("tags")
  @ApiOkResponse({ type: ExecutorTagsDto })
  @ApiOperation({
    description: "获取执行器使用的全部标签及其统计。",
    summary: "获取全部执行器标签",
  })
  getTags() {
    return this.svc.getTags();
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  // 路由声明顺序：固定段必须位于 @Get(":id")（line ~670）之前，否则被参数
  // 路由吞掉（与 groups/tags/install-cmd 同理）。
  @Get("runtime-config")
  @ApiOperation({
    description:
      "后端实际生效的存活阈值（heartbeatTimeoutMs = heartbeatIntervalMs × timeoutMultiplier；静默超过该时长后，过期扫描会把执行器标记为 OFFLINE），以及 findAll() 的列表上限与执行器总数，便于管理台让「过期」着色与后端对齐，并在列表被截断时告警（listLimit < executorTotal）。",
    summary: "获取生效的执行器运行配置",
  })
  @ApiOkResponse({ type: ExecutorRuntimeConfigDto })
  getRuntimeConfig() {
    return this.svc.getRuntimeConfig();
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  // 路由声明顺序：固定段必须位于 @Get(":id")（line ~943）之前，否则被参数
  // 路由吞掉（与 runtime-config/groups/tags 同理）。
  @Get("picker")
  // RBAC 与 GET /executors 对齐（N11 复核结论同样适用）：任务 CRUD 对普通
  // 用户开放，且 picker 读面是 list 的严格子集——不放宽，也不额外收紧。
  @ApiOkResponse({
    type: ExecutorPickerResponseDto,
    description: "truncated=true 时 items 是前缀、total 是真实总数",
  })
  @ApiOperation({
    description:
      "供执行器选择器下拉（部署弹窗）使用的最小读取面：仅 id/appName/address/status/runningTaskCount/maxConcurrentTasks，而不是 GET /executors 的完整实体投影。最多返回 EXECUTOR_PICKER_LIMIT 行（createdAt DESC）；当 total > items.length 时响应带 truncated=true，便于界面明确告警——不像上限 500 的完整列表那样静默截断。",
    summary: "列出执行器选择器选项（轻量）",
  })
  @ApiResponse({
    status: 200,
    description: "带显式截断标记的执行器选择器选项",
  })
  findPickerOptions() {
    return this.svc.findPickerOptions();
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Get("install-cmd")
  // DR-01: the command contains the shared machine credential, not just a URL.
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    description: "返回在目标机器上安装并启动执行器的 shell 命令。",
    summary: "获取执行器安装命令",
  })
  @ApiResponse({
    status: 503,
    description: "服务端未配置 ADMIN_API_URL——无法生成可用的安装命令",
  })
  @ApiOkResponse({ type: ExecutorInstallCmdDto })
  async getInstallCmd() {
    return await this.svc.getInstallCmd();
  }

  /**
   * 以 text/plain 下发一键安装脚本（install.sh 的单一事实源见
   * install-script.content.ts，与仓库根 scripts/install.sh 互为拷贝）。
   * 脚本本体不含任何密钥（secret 由用户 curl|bash 时经 -- 参数传入），故
   * @Public() + 空 @Roles() 即可——空 @Roles() 同时防御未来给本控制器加
   * 类级 @Roles 时把该公开下载路由一并锁死。
   * 注意：必须走 @Res()（library mode，同 executor-package :id/download）——
   * 全局 ResponseInterceptor 会把返回值包成 {code,message,data} JSON，
   * 直接 return 字符串会破坏 curl|bash 的纯文本语义。
   * 路由声明顺序：必须位于 @Get(":id") 之前，否则被参数路由吞掉。
   */
  @Public()
  @Roles()
  @Get("install.sh")
  @ApiOkResponse({
    description: "shell 脚本文本（Res 直传）",
    content: { "text/x-shellscript": { schema: { type: "string" } } },
  })
  @ApiOperation({
    description:
      "以纯文本返回一键安装脚本（curl -fsSL <url>/api/executors/install.sh | bash -s -- --api-url ... --secret ...）。不含敏感信息：共享密钥由调用方以 bash 参数传入。",
    summary: "下载执行器安装脚本",
  })
  getInstallScript(@Res() res: Response): void {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(INSTALL_SCRIPT);
  }

  /**
   * R8（N24 根治）：执行器安装 artifact 通道。install.sh 的远程下载分支指向
   * 本端点——真实承载 executor-node.tar.gz（dist + package.json + 生产
   * node_modules，由仓库根 scripts/bundle-executor-artifact.sh 生成），
   * 从 EXECUTOR_ARTIFACT_DIR（默认 <cwd>/artifacts）读取固定文件名，
   * 裸机 curl|bash 安装不再依赖项目 checkout。
   * 鉴权姿态：@Public() + 共享 token（Bearer 头优先，?token= 兜底），与
   * register/getToken 同一 verifyExecutorToken（未配置共享 token 时 fail
   * closed）。空 @Roles() 防御未来类级 @Roles 把公开安装路由一并锁死。
   * 路由声明顺序：必须位于 @Get(":id") 之前，否则被参数路由吞掉。
   */
  @Public()
  @Roles()
  @Get("artifact/executor-node.tar.gz")
  @ApiOkResponse({
    description: "tar.gz 二进制内容（Res 直传）",
    content: {
      "application/gzip": { schema: { type: "string", format: "binary" } },
    },
  })
  @ApiOperation({
    description:
      "提供 install.sh 远程通道所使用的 executor-node 安装包（dist + 生产环境 node_modules）。需要执行器共享令牌（Authorization: Bearer <token> 或 ?token=<token>）。在运维人员用 scripts/bundle-executor-artifact.sh 把产物生成到 EXECUTOR_ARTIFACT_DIR 之前返回 404。",
    summary: "下载 executor-node 安装产物（tar.gz）",
  })
  @ApiQuery({
    name: "token",
    required: false,
    description: "执行器共享令牌（Authorization Bearer 请求头的替代方式）",
  })
  @ApiResponse({
    status: 200,
    description: "tar.gz 产物（application/gzip）",
  })
  @ApiResponse({ status: 401, description: "共享令牌缺失或无效" })
  @ApiResponse({
    status: 404,
    description: "产物未生成 / 不存在",
  })
  async getExecutorArtifact(
    @Headers("authorization") auth: string | undefined,
    @Query("token") token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    await verifyExecutorToken(
      auth ?? (token ? `Bearer ${token}` : undefined),
      this.configService,
      this.systemConfigService,
    );
    const artifactDir =
      this.configService.get<string>("EXECUTOR_ARTIFACT_DIR") ||
      resolve(process.cwd(), "artifacts");
    // 文件名固定，无用户可控成分——不存在路径穿越面。
    const file = join(artifactDir, "executor-node.tar.gz");
    if (!existsSync(file)) {
      throw new AppError("EXECUTOR_ARTIFACT_MISSING");
    }
    const buffer = readFileSync(file);
    // E-P2-P6 收尾：与 c308b988 execution-artifacts 下载路由同一套约定——
    // 下发实际字节 sha256 到 X-SHA256 响应头，供 install.sh 解压前完整性核对。
    // 此路由已把整包读入 buffer，直接对 buffer 求摘要（不额外读盘）。
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="executor-node.tar.gz"',
    );
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("X-SHA256", sha256);
    res.end(buffer);
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Get(":id")
  @ApiOperation({
    description: "获取指定执行器的详细信息，包括配置、状态与性能指标。",
    summary: "获取单个执行器详情",
  })
  @ApiParam({ name: "id", description: "执行器 ID" })
  @ApiOkResponse({ type: ExecutorResponseDto })
  @ApiResponse({ status: 404, description: "执行器不存在" })
  findOne(@Param("id", ParseUuidShapePipe) id: string) {
    return this.svc.findOne(id);
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Patch(":id")
  @ApiOkResponse({ type: ExecutorResponseDto })
  // N-02③（ADR-013 2026-10-02 温和下放）：ADMIN 或所属项目 editor+ 可改元
  // 数据——RolesGuard 元数据退场，判定下沉 assertCanManageMetadata（rotate-
  // token / set-offline / DELETE 仍 @Roles(ADMIN) 不变）。授权形态按 A2 纪律
  // 显式声明为 ownership（write 证据由 assertCanManageMetadata 落证）。
  @WriteGuard("executor", { scope: "ownership" })
  @ApiOperation({
    description:
      "更新执行器的分组、标签、描述与最大并发任务数。需要 ADMIN 角色，或该执行器所属项目的 editor 及以上角色。",
    summary: "更新执行器元数据",
  })
  @ApiParam({ name: "id", description: "执行器 ID" })
  @ApiBody({
    description: "更新参数",
    schema: {
      example: {
        groupName: "production",
        tags: ["nodejs", "prod"],
        description: "生产环境执行器",
        maxConcurrentTasks: 10,
      },
    },
  })
  @ApiResponse({ status: 404, description: "执行器不存在" })
  @ApiResponse({
    status: 403,
    description: "既不是 ADMIN，也没有该执行器所属项目的 editor 及以上角色",
  })
  async update(
    @Param("id") id: string,
    // E-5：运行时可能是 ApiKeyUser（JwtAuthGuard 的 acf_ 分支）——类型放宽到
    // 联合，判定收敛在 assertCanManageMetadata（isApiKeyUser 显式 403）。
    @CurrentUser() user: AuthUser | ApiKeyUser,
    @Body()
    body: {
      groupName?: string | null;
      tags?: string[] | null;
      description?: string | null;
      maxConcurrentTasks?: number | null;
    },
  ) {
    // F-2 family: pick only the metadata fields — the inline type does not
    // strip extra runtime properties, and service.update must never receive
    // arbitrary entity columns (tokenHash, version, status, ...) from the wire.
    const executor = await this.svc.findOne(id);
    await this.assertCanManageMetadata(executor, user);
    return this.svc.update(id, {
      groupName: body.groupName,
      tags: body.tags,
      description: body.description,
      maxConcurrentTasks: body.maxConcurrentTasks,
    });
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Post(":id/reload-config")
  // N-02③（ADR-013 2026-10-02 温和下放）：ADMIN 或所属项目 editor+ 可推配置
  // 热更（载荷携带执行器令牌，但 push 载荷不新增暴露面——token 经 issueToken
  // 幂等重发，非轮换）——RolesGuard 元数据退场，判定下沉
  // assertCanManageMetadata（rotate-token / set-offline / DELETE 仍 @Roles(ADMIN)）。
  @WriteGuard("executor", { scope: "ownership" })
  @ApiOperation({
    description:
      "无需重启即动态更新执行器配置。执行器必须在线。需要 ADMIN 角色，或该执行器所属项目的 editor 及以上角色。",
    summary: "向执行器推送配置热更新",
  })
  @ApiCreatedResponse({
    type: ExecutorReloadConfigResponseDto,
    description:
      "pull 模式 = {queued,commandId,message}；push 模式 = 执行器自身响应原样透传（additionalProperties）",
  })
  @ApiParam({ name: "id", description: "执行器 ID" })
  @ApiBody({
    description: "配置参数",
    schema: {
      example: {
        maxConcurrentTasks: 10,
        taskTimeoutSeconds: 300,
        heartbeatIntervalSeconds: 30,
        adminApiUrl: "http://admin-api:3105",
      },
    },
  })
  // 503/502 而非 401：这些是「执行器不可达 / 拒收推送」的**投递**失败，不是
  // 调用方的会话失效。回 401 会让 admin-web 的拦截器登出管理员（见下方
  // reloadConfig 内的注释）。
  @ApiResponse({
    status: 503,
    description: "执行器离线或不可达（配置推送未能送达）",
  })
  @ApiResponse({
    status: 502,
    description: "执行器拒收了配置推送（其持有的令牌与签发的令牌不一致）",
  })
  @ApiResponse({ status: 404, description: "执行器不存在" })
  /**
   * R11 (round-11 P1): idempotent token REUSE, not rotation.
   *
   * The executor validates this INBOUND push against the token it currently
   * holds (executor-node auth.ts / executor-python auth.py:
   * validTokens = [dynamicToken, staticToken]). The old code called
   * rotateToken() here, which minted a NEW secret the executor had never
   * seen — verifyToken rejected it with 401 and the push always failed
   * ("Failed to reach executor"). R10's 401 self-heal only covers the
   * executor's OUTBOUND requests, not this inbound path.
   *
   * issueToken() (R8/R9 idempotent-issuance infra) returns the cached
   * PLAINTEXT for a same-(address, startupId) caller — exactly the token the
   * live executor holds — so verifyToken passes and NOTHING is rotated or
   * invalidated (the F-3 "rotate before the SSRF guard" cost note below is
   * obsolete for the normal path).
   *
   * Cold-cache/legacy edge (N51): a row without executorStartupId, or a
   * cold admin-api issuance cache after a restart, cannot prove same-process
   * life, so issueToken() falls through to a real rotation and the push
   * still 401s once — this applies to ANY executor after an admin-api
   * restart (its held plaintext predates the restart), not just legacy
   * rows. The catch below re-issues and retries the push EXACTLY ONCE
   * (same storm posture as R10's outbound heal: one auth retry per
   * request). NOTE (N50): the retry cannot rescue the rotation case —
   * issueToken is an unlocked check-then-act, so the retry's re-issue
   * deterministically reuses the same just-rotated token the executor has
   * not adopted yet; it only rescues transient non-auth blips. Real
   * convergence is executor-side: outbound 401 self-heal re-aligns within
   * one heartbeat (node: one request; python: request_with_self_heal since
   * R11), after which the next push succeeds. If the retry still fails we
   * surface the original fixed error. Trade-off accepted: the first
   * reload-config attempt after an admin-api restart reports one failure.
   *
   * BUG-01 (N51 收口) supersedes the "original fixed error" sentence above
   * for the auth classes only: a retry that still gets an auth-rejection
   * verdict throws the precise (b) message — executor address + "after a
   * token re-issue retry" + both remedies (one-heartbeat self-heal or
   * rotate-token); a retry failing with a non-auth error throws the (a)
   * first-attempt message (首发 401, cold-cache wording, heartbeat advice).
   * Every retry outcome also increments
   * autoflow_push_auth_retry_total{result="reissued_success"|
   * "still_unauthorized"} via runtime-metrics-entry, with warn logs on all
   * three transitions. F-8 holds everywhere: axios error text is never
   * echoed; the non-auth first-failure message below stays generic.
   */
  async reloadConfig(
    @Param("id") id: string,
    // E-5：同 update——主体类型放宽，判定收敛在 assertCanManageMetadata。
    @CurrentUser() user: AuthUser | ApiKeyUser,
    @Body()
    body: {
      maxConcurrentTasks?: number;
      taskTimeoutSeconds?: number;
      heartbeatIntervalSeconds?: number;
      adminApiUrl?: string;
      adminApiUrlInternal?: string;
      adminApiUrlExternal?: string;
    },
  ) {
    const executor = await this.svc.findOne(id);
    // 权限判定先于状态检查：未授权者不应借 503/502 探测执行器在线状态。
    await this.assertCanManageMetadata(executor, user);
    if (executor.status !== "online") {
      // 不能用 401 表达「执行器离线」——admin-web 的 axios 拦截器把任何 401
      // 当成**会话失效**：先试刷新令牌，失败即 logout() + 跳登录页（见
      // api/client.ts:124-138）。于是一次普通的配置推送失败会把管理员的整个
      // 会话清空并踢到登录页，提示「登录状态已过期」——与真实原因完全无关。
      // 503 语义正确（依赖不可用）且前端只会 toast 一条可读提示。
      throw new AppError("EXECUTOR_OFFLINE_CONFIG_PUSH");
    }
    const issued = await this.svc.issueToken({
      address: executor.address,
      appName: executor.appName,
      startupId: executor.executorStartupId ?? null,
      // ADR-017 阶段 3：行已被 id 解析（findOne(id)），指纹让它走同一条
      // 无歧义定位路径（同址多行时不会被地址回落取错行）。
      deviceFingerprint: executor.deviceFingerprint,
    });
    // ARCH-33（ADR-016）：pull 执行器走命令队列。
    //
    // 语义损失**如实声明**：push 返回执行器的响应体（「已应用」），pull 只能
    // 返回「已入队」。返回体因此带 `queued: true` + `commandId`，UI 据此区分，
    // **不谎报成功**。终态由执行器经 /executors/command-result 上报。
    //
    // UI-18 此前把 pull 执行器的这个入口在管理台上**禁用**了（入站 POST 对
    // NAT 执行器必然失败）——本改动让那个禁用理由消失，见 admin-web 同批改动。
    const routed = await this.svc.deliverControlCommand({
      executorId: executor.id,
      address: executor.address,
      type: "config-reload",
      payload: body as Record<string, unknown>,
    });
    if (routed.delivered === "unresolved") {
      // 行在 findOne(id) 之后被删除（极小窗口）。不存在"推送回退"——直接报不可用。
      throw new AppError("EXECUTOR_NOT_FOUND");
    }
    if (routed.delivered === "pull") {
      return {
        queued: true,
        commandId: routed.commandId,
        message:
          "Config update queued for the pull-mode executor; it applies the change on its next pull (within ~1s).",
      };
    }
    const url = this.svc.getExecutorUrl(executor.address, "api/config/reload");
    // F-3: SSRF guard — never send the per-executor token to a
    // metadata/loopback/link-local target. With idempotent reuse a blocked
    // address normally costs the executor nothing (no rotation happened);
    // only the legacy/cold-cache path above may have rotated once.
    // F-3 (SEC-NEW): pin the connection to the validated IP (Host/SNI kept).
    const pinned = await assertAndPinExecutorUrl(url);
    const pinCfg = pinnedAxiosConfig(pinned);
    try {
      const resp = await axios.post(url, body, {
        headers: { Authorization: `Bearer ${issued.token}` },
        timeout: 10_000,
        maxRedirects: 0, // R3 parity
        ...pinCfg,
      });
      return resp.data;
    } catch (firstErr) {
      if (!isUnauthorizedPushError(firstErr)) {
        // F-8: fixed message — do not echo axios err.message (leaks internal
        // topology / provides a blind SSRF oracle via connect-error text).
        //
        // 503 而非 401：这是**投递失败**（执行器不可达/超时），不是鉴权裁定。
        // 用 401 会被 admin-web 的拦截器当成会话失效 → logout + 跳登录页，
        // 管理员在 NAT/防火墙/执行器刚重启时点一次推送就被踢出系统。
        throw new AppError("EXECUTOR_CONFIG_PUSH_UNREACHABLE");
      }
      // 401 fallback (legacy rows / cold issuance cache): re-issue once and
      // retry the push once. The second issueToken() may return the same
      // cached plaintext (then the retry fails identically and we throw) or,
      // if cache state moved, a token the executor can accept.
      // BUG-01: both outcomes are now observable — recordRuntime increments
      // autoflow_push_auth_retry_total{result=...} — and the failure message
      // distinguishes the two 401 classes instead of the generic one-liner.
      this.logger.warn(
        `Push auth retry: executor ${executor.address} rejected reload-config with 401 on first attempt (token re-issued once)`,
      );
      const retry = await this.svc.issueToken({
        address: executor.address,
        appName: executor.appName,
        startupId: executor.executorStartupId ?? null,
        // ADR-017 阶段 3：同上——重试与首次同口径，行身份由指纹钉住。
        deviceFingerprint: executor.deviceFingerprint,
      });
      try {
        const resp = await axios.post(url, body, {
          headers: { Authorization: `Bearer ${retry.token}` },
          timeout: 10_000,
          // A-3（执行器域审计 P2）：重试必须与首次请求（上方）携带同一份安全
          // 配置——pinnedAxiosConfig 展开把连接钉在已校验 IP 上（防 DNS 重绑定
          // 在重试路径复活），maxRedirects: 0 保证首跳是唯一经 SSRF 校验的
          // 地址（R3 parity）。此前重试丢了这两项：带 token 的重试可能被 30x
          // 重定向到任意地址、或经 DNS 重解析落与他人选定的 IP。
          maxRedirects: 0,
          ...pinCfg,
        });
        recordRuntime("autoflow_push_auth_retry_total", {
          result: "reissued_success",
        });
        this.logger.warn(
          `Push auth retry accepted: executor ${executor.address} approved reload-config with the re-issued token (2xx after the first-attempt 401)`,
        );
        return resp.data;
      } catch (retryErr) {
        if (isUnauthorizedPushError(retryErr)) {
          // BUG-01 (b) 重签重试后仍 401：执行器顽固失配，需人工 rotate。
          recordRuntime("autoflow_push_auth_retry_total", {
            result: "still_unauthorized",
          });
          this.logger.warn(
            `Push auth retry still 401 for executor ${executor.address}: token mismatch persists after re-issue; manual rotate-token required (executor-side outbound self-heal may also converge within one heartbeat)`,
          );
          // F-8: fixed message — the original 401 error is not echoed (no
          // internal-topology / SSRF-oracle leak). BUG-01: the message now
          // identifies the executor address, states this is AFTER the one
          // re-issue retry (vs the first-attempt class below), and names the
          // operator action. Address is pre-validated by the SSRF guard.
          //
          // 502 而非 401：这里的 401 是**执行器拒收我们的推送**（它持有的
          // token 与 admin 签发的不一致），不是管理员会话失效。回 401 会被
          // admin-web 拦截器当成会话过期 → 清空登录态并跳登录页，把一个
          // 「等一个心跳自愈」的可自愈问题升级成「管理员被踢出系统」。
          throw new AppError("EXECUTOR_CONFIG_PUSH_REJECTED", {
            address: executor.address,
            executorId: id,
          });
        }
        // BUG-01 (a) 首发 401：执行器拒收首发推送（其持有 token 与 admin 签发
        // 不一致，如 admin 重启后签发缓存冷），随后的一次重签重试未产生鉴权
        // 裁定（非 401 失败）。文案如实指向首发拒收 + 等待一个心跳自愈。该
        // 分支不写入 push_auth_retry 计数（无认证结果，标签集保持任务定义的
        // 两值闭合）；F-8：不回显 axios 错误文本。
        // 502 而非 401：同上一分支——这是执行器侧的拒收，不是管理员会话失效。
        throw new AppError("EXECUTOR_CONFIG_PUSH_REJECTED_FIRST", {
          address: executor.address,
          executorId: id,
        });
      }
    }
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Post(":id/rotate-token")
  // W2: ADMIN-only — the response contains the plaintext executor token.
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    description: "生成新的执行器鉴权令牌。新令牌仅在本响应中展示一次。",
    summary: "轮换执行器令牌",
  })
  @ApiParam({ name: "id", description: "执行器 ID" })
  @ApiBody({
    description:
      "AUTH-05：可选的轮换原因（≤200 字符，ExecutorActionReasonDto），会记入审计日志详情（该端点保持向后兼容——请求体为空也可以）。",
    type: ExecutorActionReasonDto,
    required: false,
  })
  @ApiOkResponse({
    type: ExecutorRotateTokenDto,
    description: "新凭据一次性回显",
  })
  // F-53（UIAUDIT P2-2）：body 换 class DTO——此前内联 { reason?: string } 使
  // 全局 whitelist+forbidNonWhitelisted 对本面失效；reason 现有 ≤200 上限
  // （对齐 AUTH-05 前端契约与 DEP-04 ApprovalActionDto 先例）。
  rotateToken(@Param("id") id: string, @Body() body?: ExecutorActionReasonDto) {
    return this.svc.rotateToken(id, body?.reason);
  }

  @Public()
  @WriteGuard("executor", {
    scope: "token",
    reason: "执行器持静态共享令牌换取 per-executor 令牌",
  })
  @Post("token")
  @ApiOperation({
    description:
      "执行器调用本接口获取动态令牌。首次鉴权使用共享令牌。R9（第八轮 P1）：按 (address, startupId) 幂等——同进程重复获取会返回当前令牌而不是轮换；以下情况才会轮换：首次签发、startupId 变化（重启）、无 startupId 的历史方式获取且超出短暂复用窗口，或此前签发的令牌与已存储哈希不再匹配。",
    summary: "获取动态令牌",
  })
  @ApiBody({
    description: "获取令牌参数",
    schema: {
      example: {
        address: "192.168.1.100:3002",
        appName: "executor-node",
        startupId: "uuid-of-this-executor-process-life",
        deviceFingerprint: "64-lowercase-hex-from-the-executor",
      },
    },
  })
  @ApiCreatedResponse({
    type: ExecutorTokenResponseDto,
    description: "令牌获取（或复用）成功——R9 幂等签发",
  })
  @ApiResponse({ status: 401, description: "共享令牌无效" })
  async getToken(
    @Body()
    body: {
      address: string;
      appName?: string;
      startupId?: string | null;
      // ADR-017 阶段 3（复查补口）：稳定设备指纹——**行定位键**。两端
      // `/executors/token` 均已随载荷上报（node middleware/auth.ts::fetchToken、
      // python auth.py::_fetch_token）。
      //
      // 漏转发的后果：issueToken → register 的指纹入口拿到 null → 回落
      // `findOne({where:{address}})` → pull 同址多行时**任取一行** → 轮换
      // **别人的** token。这正是本补口要修的缺陷（F-7 显式白名单是唯一入站
      // 通道——内联 @Body() 类型是编译期的，运行时不裁剪）。
      deviceFingerprint?: string | null;
    },
    @Headers("authorization") auth: string,
  ) {
    await verifyExecutorToken(
      auth,
      this.configService,
      this.systemConfigService,
    );

    // E-6（2026-10-26 执行器域审计）：缺 appName 不再兜底 "executor"——那会让
    // 持有共享令牌的调用方反复以不同 address 制造无主行（appName 是行的身份列，
    // "executor" 兜底让这些行在管理台无法归属）。仓内三个执行器来源（node
    // middleware/auth.ts、python auth.py、install.sh 生成的 APP_NAME）恒带
    // 非空 appName，收紧无存量兼容风险；语义见 EXECUTOR_TOKEN_APP_NAME_REQUIRED。
    if (!body.appName || !body.appName.trim()) {
      throw new AppError("EXECUTOR_TOKEN_APP_NAME_REQUIRED");
    }

    // R9 (round-8 P1 closure, W2): issueToken() replaces the old
    // register()+rotateToken() pair that rotated on EVERY call — the root of
    // the ~30s tokenHash rotation cycle that broke the N26 per-execution
    // callback-token invariant (docs/archive/verifies/verify-round8-e2e.md §1.5).
    return this.svc.issueToken({
      address: body.address,
      appName: body.appName,
      startupId: body.startupId,
      // ADR-017 阶段 3（复查补口）：指纹必须转发——issueToken 依赖它把
      // register 的行解析收敛到**调用方自己那一行**（缺省即同址多行时任取
      // 一行 → 轮换他人 token）。
      deviceFingerprint: body.deviceFingerprint,
    });
  }

  @Public()
  @WriteGuard("executor", {
    scope: "token",
    reason: "执行器持 per-executor 令牌上报下线",
  })
  @Post("offline")
  @ApiOperation({
    description: "执行器优雅停机时调用，用于通知中台并将该执行器标记为离线。",
    summary: "执行器下线通知",
  })
  @ApiBody({
    description: "下线参数",
    schema: {
      example: {
        address: "192.168.1.100:3002",
      },
    },
  })
  @ApiResponse({ status: 401, description: "执行器令牌无效" })
  @ApiOkResponse({ type: ExecutorOfflineDto })
  async offline(
    @Body()
    body: {
      address: string;
      // ADR-017 阶段 3：稳定设备指纹（可选；旧执行器不传）——pull 同地址
      // 多行并存时用于唯一定位本行，避免把**别人的**行一起置离线（§5）。
      deviceFingerprint?: string | null;
    },
    @Headers("authorization") auth: string,
  ) {
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
    const isValid = await this.svc.validateTokenByAddress(
      body.address,
      token,
      body.deviceFingerprint,
    );
    if (!isValid) {
      throw new AppError("INVALID_EXECUTOR_TOKEN");
    }

    // ADR-017 阶段 3：精确下线**自己那一行**（见 markOffline 头注——按地址
    // 无界 UPDATE 会把同地址的另一台也置离线）。
    await this.svc.markOffline(body.address, body.deviceFingerprint);
    return { success: true };
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Post(":id/set-offline")
  // W2: ADMIN-only executor lifecycle mutation.
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    description:
      "管理员操作：按 ID 将指定执行器标记为离线（不会中断正在运行的任务；用于崩溃后残留的过期记录）。",
    summary: "将执行器标记为离线",
  })
  @ApiCreatedResponse({
    type: ExecutorResponseDto,
    description: "offlineReason=manual 的执行器行（POST 默认 201）",
  })
  @ApiParam({ name: "id", description: "执行器 ID" })
  @ApiResponse({ status: 404, description: "执行器不存在" })
  setOffline(@Param("id") id: string) {
    return this.svc.setOfflineById(id);
  }

  /**
   * DEEP-AUDIT B·1.1：执行器删除影响面预览（对齐应用域 GET /:id/removal-impact
   * 先例）。ADMIN-only 与 DELETE 同权限面——能看影响面的人就是能删的人。
   */
  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Get(":id/removal-impact")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    description:
      "统计通过 task.executorId / task.executorAppName 绑定到该执行器的任务数（删除后派发会失败），以及待处理的 pull 队列深度。",
    summary: "预览删除该执行器会破坏什么",
  })
  @ApiParam({ name: "id", description: "执行器 ID" })
  @ApiResponse({ status: 404, description: "执行器不存在" })
  @ApiOkResponse({ type: ExecutorRemovalImpactResponseDto })
  removalImpact(@Param("id") id: string) {
    return this.svc.describeRemovalImpact(id);
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Delete(":id")
  @ApiResponse({ status: 204, description: "已移除（无内容）" })
  @HttpCode(HttpStatus.NO_CONTENT)
  // W2: ADMIN-only destructive removal.
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    description:
      "管理员操作：按 ID 永久删除执行器记录。适用于执行器已离线且不再需要的场景。",
    summary: "删除执行器记录",
  })
  @ApiParam({ name: "id", description: "执行器 ID" })
  @ApiBody({
    description:
      "AUTH-05：可选的删除原因（≤200 字符，ExecutorActionReasonDto），会记入审计日志详情（该端点保持向后兼容——请求体为空也可以）。",
    type: ExecutorActionReasonDto,
    required: false,
  })
  @ApiResponse({ status: 204, description: "执行器已删除" })
  @ApiResponse({ status: 404, description: "执行器不存在" })
  // F-53（UIAUDIT P2-2）：同 rotate-token，内联 reason body 换 class DTO。
  async removeExecutor(
    @Param("id") id: string,
    @Body() body?: ExecutorActionReasonDto,
  ): Promise<void> {
    return this.svc.removeById(id, body?.reason);
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Get(":id/executions")
  @ApiOkResponse({
    type: ExecutorExecutionsResponseDto,
    description: "裸 {total,items} 分页",
  })
  @ApiOperation({
    description: "分页获取指定执行器的全部任务执行记录。",
    summary: "获取执行器的任务执行历史",
  })
  @ApiParam({ name: "id", description: "执行器 ID" })
  @ApiQuery({ name: "page", required: false, description: "页码" })
  // U13: 与实现对齐——本端点收 PaginationDto（page/pageSize），而非 `limit`。
  @ApiQuery({ name: "pageSize", required: false, description: "每页条数" })
  getExecutorExecutions(@Param("id") id: string, @Query() p: PaginationDto) {
    return this.svc.getExecutorExecutions(id, p);
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Get(":id/metrics")
  @ApiOperation({
    // FEAT-04 (append-only): response now also carries `history`.,
    description:
      "获取执行器最近 7 天的性能指标，包括总执行次数、成功率与平均耗时。FEAT-04：响应还带 `history`——最近 24 小时的 executor_metrics_history 采样按固定 15 分钟 AVG 桶聚合（≤96 个点，升序；每个点为 {timestamp, cpuUsage, memUsage, runningTaskCount}；某个桶没有上报值时 cpuUsage/memUsage 为 null）。该执行器没有任何历史采样时返回空数组——管理台据此渲染空状态。",
    summary: "获取执行器性能指标",
  })
  @ApiParam({ name: "id", description: "执行器 ID" })
  // FEAT-04 (append-only): example updated to the real response shape —
  // executor + sevenDayStats + current + history (24h bucketed samples).
  @ApiOkResponse({ type: ExecutorMetricsDto })
  getExecutorMetrics(@Param("id") id: string) {
    return this.svc.getExecutorMetrics(id);
  }
}
