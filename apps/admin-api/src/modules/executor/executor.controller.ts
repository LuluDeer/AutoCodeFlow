import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  UnauthorizedException,
  Headers,
  Param,
  Patch,
  Query,
  Delete,
  HttpCode,
  HttpStatus,
  Res,
  NotFoundException,
} from "@nestjs/common";
import { Response } from "express";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiParam,
  ApiBody,
  ApiQuery,
} from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ExecutorService } from "./executor.service";
import { UserRole } from "../users/entities/user.entity";
import { INSTALL_SCRIPT } from "./install-script.content";
import { SystemConfigService } from "../config/config.service";
import axios from "axios";
import { PaginationDto } from "../../common/dto/pagination.dto";
import { verifyExecutorToken } from "../../common/utils/verify-executor-token.util";
import { assertSafeExecutorUrl } from "../../common/utils/safe-http.util";

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
  constructor(
    private readonly svc: ExecutorService,
    private readonly configService: ConfigService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  @Public()
  @Post("register")
  @ApiOperation({
    summary: "Register executor",
    description:
      "Called when executor starts to register with admin. Requires shared token for auth.",
  })
  @ApiBody({
    description: "Registration info",
    schema: {
      example: {
        address: "192.168.1.100:3002",
        appName: "executor-node",
        groupName: "production",
        tags: ["nodejs", "prod"],
        description: "Production Node.js executor",
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: "Registered successfully",
    schema: {
      example: {
        code: 200,
        message: "success",
        data: {
          id: "exec-uuid",
          address: "192.168.1.100:3002",
          appName: "executor-node",
          status: "online",
        },
      },
    },
  })
  async register(
    @Body()
    body: {
      appName: string;
      address: string;
      type?: string;
      version?: string;
      capabilities?: string[];
      runtime?: string[];
      maxConcurrentTasks?: number;
      maxConcurrent?: number;
      groupName?: string | null;
      tags?: string[] | null;
      description?: string | null;
      restartedAt?: string | null;
      startupId?: string | null;
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
      capabilities: body.capabilities,
      runtime: body.runtime,
      maxConcurrentTasks: body.maxConcurrentTasks,
      maxConcurrent: body.maxConcurrent,
      groupName: body.groupName,
      tags: body.tags,
      description: body.description,
      restartedAt: body.restartedAt,
      startupId: body.startupId,
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
    const tokenHash = await this.svc.getCallbackSecretByAddress(
      executor.address,
    );
    return { ...executor, perExecutorToken, tokenHash };
  }

  @Public()
  @Post("heartbeat")
  @ApiOperation({
    summary: "Heartbeat report",
    description:
      "Executor calls this periodically to report status including CPU, memory, and running task count.",
  })
  @ApiBody({
    description: "Heartbeat data",
    schema: {
      example: {
        address: "192.168.1.100:3002",
        cpuUsage: 45.5,
        memUsage: 62.3,
        runningTaskCount: 3,
      },
    },
  })
  @ApiResponse({ status: 200, description: "Heartbeat updated" })
  @ApiResponse({ status: 401, description: "Invalid executor token" })
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
      deadLetterCount?: number;
      // E9: 执行器热更新容量后随心跳上报（可选；范围校验在 service 侧，
      // 非法/缺失不改 DB 值）。
      maxConcurrentTasks?: number;
    },
    @Headers("authorization") auth: string,
  ) {
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
    const isValid = await this.svc.validateTokenByAddress(body.address, token);
    if (!isValid) {
      throw new UnauthorizedException("Invalid executor token");
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
      deadLetterCount: body.deadLetterCount,
      // E9: 转发容量热更新值，正整数 1..10000 校验在 service 侧完成。
      maxConcurrentTasks: body.maxConcurrentTasks,
    };
    const saved = await this.svc.heartbeat(body.address, metrics);
    // R9 (round-8 P1 closure, W3): echo the CURRENT stored tokenHash with
    // every heartbeat (same posture as register, which already returns it —
    // the caller proved possession of a valid per-executor/shared token).
    // executor-node adopts it in scheduler.sendHeartbeat so the N26
    // per-execution callback HMAC secret follows admin-side rotations
    // (admin-UI rotate-token, register-time issuance) without a re-register.
    const tokenHash = await this.svc.getCallbackSecretByAddress(body.address);
    return { ...saved, tokenHash };
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Get()
  // N11 复核后不对列表做 ADMIN 收紧：任务 CRUD 对普通用户开放，且 executions
  // 列表/过滤（executorAddress）本就向所有登录用户暴露执行器地址——单独锁住
  // 列表既挡不住信息（可经 executions 侧信道获得）又会打断 TaskFormPage 的
  // 执行器下拉。凭证类面（notification/ai config）仍为 ADMIN。
  @ApiOperation({
    summary: "List executors",
    description:
      "Get list of all executors including online status, group, and tags.",
  })
  @ApiResponse({
    status: 200,
    description: "Executor list",
    schema: {
      example: {
        code: 200,
        message: "success",
        data: [],
      },
    },
  })
  findAll() {
    return this.svc.findAll();
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Get("groups")
  @ApiOperation({
    summary: "Get all executor groups",
    description: "Get all executor groups and their executor count statistics.",
  })
  @ApiResponse({
    status: 200,
    description: "Group list",
    schema: {
      example: {
        code: 200,
        message: "success",
        data: [
          { name: "production", count: 5, onlineCount: 4 },
          { name: "staging", count: 2, onlineCount: 2 },
        ],
      },
    },
  })
  getGroups() {
    return this.svc.getGroups();
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Get("tags")
  @ApiOperation({
    summary: "Get all executor tags",
    description: "Get all tags used by executors and their statistics.",
  })
  @ApiResponse({
    status: 200,
    description: "Tag list",
    schema: {
      example: {
        code: 200,
        message: "success",
        data: [
          { name: "nodejs", count: 3 },
          { name: "python", count: 2 },
        ],
      },
    },
  })
  getTags() {
    return this.svc.getTags();
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Get("install-cmd")
  // DR-01: the command contains the shared machine credential, not just a URL.
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "Get executor install command",
    description:
      "Returns the shell command to install and start the executor on the target machine.",
  })
  @ApiResponse({
    status: 200,
    description: "Install command",
    schema: {
      example: {
        code: 200,
        message: "success",
        data: {
          cmd: "curl -fsSL 'http://localhost:3002/api/executors/install.sh' | bash -s -- --api-url 'http://localhost:3002' --secret 'shared-token'",
          token: "shared-token",
          adminApiUrl: "http://localhost:3002",
        },
      },
    },
  })
  @ApiResponse({
    status: 503,
    description:
      "ADMIN_API_URL is not configured on the server — no usable install command can be generated",
  })
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
  @ApiOperation({
    summary: "Download executor install script",
    description:
      "Returns the one-click installer as plain text (curl -fsSL <url>/api/executors/install.sh | bash -s -- --api-url ... --secret ...). Not sensitive: the shared secret is supplied by the caller as a bash argument.",
  })
  @ApiResponse({ status: 200, description: "Shell script (text/plain)" })
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
  @ApiOperation({
    summary: "Download executor-node install artifact (tar.gz)",
    description:
      "Serves the executor-node install bundle (dist + production node_modules) used by install.sh's remote channel. Requires the executor shared token (Authorization: Bearer <token> or ?token=<token>). Returns 404 until an operator generates the artifact via scripts/bundle-executor-artifact.sh into EXECUTOR_ARTIFACT_DIR.",
  })
  @ApiQuery({
    name: "token",
    required: false,
    description:
      "Executor shared token (alternative to the Authorization Bearer header)",
  })
  @ApiResponse({
    status: 200,
    description: "tar.gz artifact (application/gzip)",
  })
  @ApiResponse({ status: 401, description: "Missing / invalid shared token" })
  @ApiResponse({
    status: 404,
    description: "Artifact not generated / not found",
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
      throw new NotFoundException(
        "executor-node.tar.gz not found; run scripts/bundle-executor-artifact.sh and place the artifact under EXECUTOR_ARTIFACT_DIR (default <cwd>/artifacts)",
      );
    }
    const buffer = readFileSync(file);
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="executor-node.tar.gz"',
    );
    res.setHeader("Content-Length", String(buffer.length));
    res.end(buffer);
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Get(":id")
  @ApiOperation({
    summary: "Get single executor details",
    description:
      "Get detailed info for a specific executor including config, status, and performance metrics.",
  })
  @ApiParam({ name: "id", description: "Executor ID" })
  @ApiResponse({ status: 200, description: "Executor details" })
  @ApiResponse({ status: 404, description: "Executor not found" })
  findOne(@Param("id") id: string) {
    return this.svc.findOne(id);
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Patch(":id")
  // W2: executor management writes are ADMIN-only (same posture as
  // install-cmd DR-01) — the global RolesGuard enforces the metadata.
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "Update executor metadata",
    description:
      "Update executor group, tags, description, and max concurrent tasks.",
  })
  @ApiParam({ name: "id", description: "Executor ID" })
  @ApiResponse({ status: 200, description: "Updated successfully" })
  @ApiBody({
    description: "Update parameters",
    schema: {
      example: {
        groupName: "production",
        tags: ["nodejs", "prod"],
        description: "Production executor",
        maxConcurrentTasks: 10,
      },
    },
  })
  @ApiResponse({ status: 404, description: "Executor not found" })
  update(
    @Param("id") id: string,
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
  // W2: ADMIN-only config hot-update push (carries the executor token).
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "Push config hot-update to executor",
    description:
      "Dynamically update executor config without restart. Executor must be online.",
  })
  @ApiParam({ name: "id", description: "Executor ID" })
  @ApiBody({
    description: "Config parameters",
    schema: {
      example: {
        maxConcurrentTasks: 10,
        taskTimeoutSeconds: 300,
        heartbeatIntervalSeconds: 30,
        adminApiUrl: "http://admin-api:3105",
      },
    },
  })
  @ApiResponse({ status: 200, description: "Config pushed successfully" })
  @ApiResponse({ status: 400, description: "Executor offline" })
  @ApiResponse({ status: 404, description: "Executor not found" })
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
   */
  async reloadConfig(
    @Param("id") id: string,
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
    if (executor.status !== "online") {
      throw new UnauthorizedException("Executor is offline");
    }
    const issued = await this.svc.issueToken({
      address: executor.address,
      appName: executor.appName,
      startupId: executor.executorStartupId ?? null,
    });
    const url = this.svc.getExecutorUrl(executor.address, "api/config/reload");
    // F-3: SSRF guard — never send the per-executor token to a
    // metadata/loopback/link-local target. With idempotent reuse a blocked
    // address normally costs the executor nothing (no rotation happened);
    // only the legacy/cold-cache path above may have rotated once.
    await assertSafeExecutorUrl(url);
    try {
      const resp = await axios.post(url, body, {
        headers: { Authorization: `Bearer ${issued.token}` },
        timeout: 10_000,
      });
      return resp.data;
    } catch (firstErr) {
      if (!isUnauthorizedPushError(firstErr)) {
        // F-8: fixed message — do not echo axios err.message (leaks internal
        // topology / provides a blind SSRF oracle via connect-error text).
        throw new UnauthorizedException("Failed to reach executor");
      }
      // 401 fallback (legacy rows / cold issuance cache): re-issue once and
      // retry the push once. The second issueToken() may return the same
      // cached plaintext (then the retry fails identically and we throw) or,
      // if cache state moved, a token the executor can accept.
      const retry = await this.svc.issueToken({
        address: executor.address,
        appName: executor.appName,
        startupId: executor.executorStartupId ?? null,
      });
      try {
        const resp = await axios.post(url, body, {
          headers: { Authorization: `Bearer ${retry.token}` },
          timeout: 10_000,
        });
        return resp.data;
      } catch {
        // F-8: same fixed message; the original 401 error is not echoed.
        throw new UnauthorizedException("Failed to reach executor");
      }
    }
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Post(":id/rotate-token")
  // W2: ADMIN-only — the response contains the plaintext executor token.
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "Rotate executor token",
    description:
      "Generate a new executor auth token. The new token is shown only once in this response.",
  })
  @ApiParam({ name: "id", description: "Executor ID" })
  @ApiResponse({
    status: 200,
    description: "Token rotated successfully",
    schema: {
      example: {
        code: 200,
        message: "success",
        data: {
          token: "new-token-value",
          expiresAt: "2024-01-01T12:00:00Z",
        },
      },
    },
  })
  rotateToken(@Param("id") id: string) {
    return this.svc.rotateToken(id);
  }

  @Public()
  @Post("token")
  @ApiOperation({
    summary: "Get dynamic token",
    description:
      "Executor calls this to get a dynamic token. Uses shared token for initial auth. R9 (round-8 P1): idempotent per (address, startupId) — a same-process re-fetch returns the CURRENT token instead of rotating; rotation happens on first issuance, a new startupId (restart), a legacy startupId-less fetch outside the short reuse window, or when the previously issued token no longer matches the stored hash.",
  })
  @ApiBody({
    description: "Get token parameters",
    schema: {
      example: {
        address: "192.168.1.100:3002",
        appName: "executor-node",
        startupId: "uuid-of-this-executor-process-life",
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: "Token obtained (or reused) successfully",
    schema: {
      example: {
        token: "dynamic-token-value",
        tokenHash: "$2b$12$bcrypt-hash-of-the-token",
      },
    },
  })
  @ApiResponse({ status: 401, description: "Invalid shared token" })
  async getToken(
    @Body()
    body: { address: string; appName?: string; startupId?: string | null },
    @Headers("authorization") auth: string,
  ) {
    await verifyExecutorToken(
      auth,
      this.configService,
      this.systemConfigService,
    );

    // R9 (round-8 P1 closure, W2): issueToken() replaces the old
    // register()+rotateToken() pair that rotated on EVERY call — the root of
    // the ~30s tokenHash rotation cycle that broke the N26 per-execution
    // callback-token invariant (docs/VERIFY-round8-e2e.md §1.5).
    return this.svc.issueToken({
      address: body.address,
      appName: body.appName || "executor",
      startupId: body.startupId,
    });
  }

  @Public()
  @Post("offline")
  @ApiOperation({
    summary: "Executor offline notification",
    description:
      "Called during graceful executor shutdown to notify admin and mark executor as offline.",
  })
  @ApiBody({
    description: "Offline parameters",
    schema: {
      example: {
        address: "192.168.1.100:3002",
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: "Offline notification successful",
    schema: { example: { success: true } },
  })
  @ApiResponse({ status: 401, description: "Invalid executor token" })
  async offline(
    @Body() body: { address: string },
    @Headers("authorization") auth: string,
  ) {
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
    const isValid = await this.svc.validateTokenByAddress(body.address, token);
    if (!isValid) {
      throw new UnauthorizedException("Invalid executor token");
    }

    await this.svc.markOffline(body.address);
    return { success: true };
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Post(":id/set-offline")
  // W2: ADMIN-only executor lifecycle mutation.
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "Mark executor offline",
    description:
      "Admin: mark a specific executor as offline by ID (does not interrupt running tasks; use for stale records after crash).",
  })
  @ApiParam({ name: "id", description: "Executor ID" })
  @ApiResponse({ status: 200, description: "Updated executor entity" })
  @ApiResponse({ status: 404, description: "Executor not found" })
  setOffline(@Param("id") id: string) {
    return this.svc.setOfflineById(id);
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  // W2: ADMIN-only destructive removal.
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "Delete executor record",
    description:
      "Admin: permanently delete an executor record by ID. Use when executor is offline and no longer needed.",
  })
  @ApiParam({ name: "id", description: "Executor ID" })
  @ApiResponse({ status: 204, description: "Executor deleted" })
  @ApiResponse({ status: 404, description: "Executor not found" })
  async removeExecutor(@Param("id") id: string): Promise<void> {
    return this.svc.removeById(id);
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Get(":id/executions")
  @ApiOperation({
    summary: "Get executor task execution history",
    description:
      "Get all task execution records for a specific executor with pagination.",
  })
  @ApiParam({ name: "id", description: "Executor ID" })
  @ApiQuery({ name: "page", required: false, description: "Page number" })
  // U13: 与实现对齐——本端点收 PaginationDto（page/pageSize），而非 `limit`。
  @ApiQuery({ name: "pageSize", required: false, description: "Page size" })
  @ApiResponse({ status: 200, description: "Execution record list" })
  getExecutorExecutions(@Param("id") id: string, @Query() p: PaginationDto) {
    return this.svc.getExecutorExecutions(id, p);
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Get(":id/metrics")
  @ApiOperation({
    summary: "Get executor performance metrics",
    description:
      "Get executor performance metrics for the last 7 days including total executions, success rate, and avg time.",
  })
  @ApiParam({ name: "id", description: "Executor ID" })
  @ApiResponse({
    status: 200,
    description: "Performance metrics",
    schema: {
      example: {
        code: 200,
        message: "success",
        data: {
          totalExecutions: 1000,
          successRate: 98.5,
          avgDurationMs: 1250,
          maxDurationMs: 5000,
          minDurationMs: 100,
          dateRange: "2024-01-01 to 2024-01-07",
        },
      },
    },
  })
  getExecutorMetrics(@Param("id") id: string) {
    return this.svc.getExecutorMetrics(id);
  }
}
