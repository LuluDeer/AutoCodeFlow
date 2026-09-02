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
} from "@nestjs/common";
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
import { ExecutorService } from "./executor.service";
import { SystemConfigService } from "../config/config.service";
import axios from "axios";
import { PaginationDto } from "../../common/dto/pagination.dto";
import { verifyExecutorToken } from "../../common/utils/verify-executor-token.util";
import { assertSafeExecutorUrl } from "../../common/utils/safe-http.util";

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
    const executor = await this.svc.register(payload);
    // Issue a fresh per-executor token on every registration so the executor
    // can authenticate future heartbeats without the shared token.
    const { token } = await this.svc.rotateToken(executor.id);
    return { ...executor, perExecutorToken: token };
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
    };
    return this.svc.heartbeat(body.address, metrics);
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Get()
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
          cmd: "npx autoflow-executor --admin-url http://... --token ...",
          token: "shared-token",
          adminApiUrl: "http://localhost:3002",
        },
      },
    },
  })
  getInstallCmd() {
    return this.svc.getInstallCmd();
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
    const token = await this.svc.rotateToken(id);
    const headers = { Authorization: `Bearer ${token.token}` };
    const url = this.svc.getExecutorUrl(executor.address, "api/config/reload");
    // F-3: SSRF guard — never send the freshly rotated (per-executor) token to
    // a metadata/loopback/link-local target. Note the rotateToken() call above
    // invalidates the previous token, so a blocked address still costs the
    // executor one re-login; that is preferable to exfiltrating the token.
    await assertSafeExecutorUrl(url);
    try {
      const resp = await axios.post(url, body, { headers, timeout: 10_000 });
      return resp.data;
    } catch {
      // F-8: fixed message — do not echo axios err.message (leaks internal
      // topology / provides a blind SSRF oracle via connect-error text).
      throw new UnauthorizedException("Failed to reach executor");
    }
  }

  @ApiBearerAuth("JWT")
  @UseGuards(JwtAuthGuard)
  @Post(":id/rotate-token")
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
      "Executor calls this to get a dynamic token. Uses shared token for initial auth, returns periodically expiring token.",
  })
  @ApiBody({
    description: "Get token parameters",
    schema: {
      example: {
        address: "192.168.1.100:3002",
        appName: "executor-node",
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: "Token obtained successfully",
    schema: {
      example: {
        token: "dynamic-token-value",
        expiresAt: "2024-01-01T12:00:00Z",
      },
    },
  })
  @ApiResponse({ status: 401, description: "Invalid shared token" })
  async getToken(
    @Body() body: { address: string; appName?: string },
    @Headers("authorization") auth: string,
  ) {
    await verifyExecutorToken(
      auth,
      this.configService,
      this.systemConfigService,
    );

    const executor = await this.svc.register({
      address: body.address,
      appName: body.appName || "executor",
    });

    return this.svc.rotateToken(executor.id);
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
  @ApiQuery({ name: "limit", required: false, description: "Page size" })
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
