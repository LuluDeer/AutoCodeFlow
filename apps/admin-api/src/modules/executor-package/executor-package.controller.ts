import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  Headers,
  HttpCode,
  HttpStatus,
  UseGuards,
  Res,
  UseInterceptors,
  UploadedFile,
  Logger,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { Response } from "express";
import * as jwt from "jsonwebtoken";
import { UnauthorizedException } from "@nestjs/common";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { SystemConfigService } from "../config/config.service";
import {
  getExecutorSharedToken,
  verifyExecutorToken,
} from "../../common/utils/verify-executor-token.util";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiConsumes,
  ApiBody,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { ExecutorPackageService } from "./executor-package.service";
import { ExecutorService } from "../executor/executor.service";
import { ConfigService } from "@nestjs/config";
import {
  CreateExecutorPackageDto,
  UpdateExecutorPackageDto,
  QueryExecutorPackageDto,
} from "./dto/executor-package.dto";
import { ExecutorPackage } from "./executor-package.entity";
import { UserRole } from "../users/entities/user.entity";

@ApiTags("Executor Package Management")
@ApiBearerAuth("JWT")
// R4 F-1: package management (upload/push/delete/activate) is admin-only.
// Class-level RolesGuard enforces ADMIN for every route; the @Public()
// push-result callback below opts out of JwtAuthGuard (machine token auth)
// and, carrying no @Roles metadata, is also skipped by RolesGuard.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller("executor-packages")
export class ExecutorPackageController {
  private readonly logger = new Logger(ExecutorPackageController.name);

  constructor(
    private readonly svc: ExecutorPackageService,
    private readonly executorService: ExecutorService,
    private readonly configService: ConfigService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
    }),
  )
  @ApiOperation({ summary: "Upload executor package" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    description: "Executor package file and metadata",
    schema: {
      type: "object",
      required: ["name", "version", "file"],
      properties: {
        name: { type: "string", example: "python-runner" },
        version: { type: "string", example: "1.0.0" },
        type: { type: "string", example: "python" },
        platform: { type: "string", example: "linux" },
        description: { type: "string" },
        file: { type: "string", format: "binary" },
      },
    },
  })
  @ApiResponse({ status: 201, description: "Created successfully" })
  create(
    @Body() createDto: CreateExecutorPackageDto,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser("username") uploadedBy: string,
  ): Promise<ExecutorPackage> {
    return this.svc.create(createDto, file, uploadedBy);
  }

  @Get()
  @ApiOperation({ summary: "Get executor package list" })
  @ApiResponse({ status: 200, description: "Package list" })
  findAll(
    @Query() query: QueryExecutorPackageDto,
  ): Promise<{ items: ExecutorPackage[]; total: number }> {
    return this.svc.findAll(query);
  }

  @Get("latest")
  @ApiOperation({ summary: "Get latest ACTIVE executor package by type" })
  @ApiQuery({
    name: "type",
    required: true,
    description: "Executor package type",
  })
  @ApiQuery({
    name: "platform",
    required: false,
    description: "Platform (optional)",
  })
  @ApiResponse({ status: 200, description: "Latest package info" })
  findLatest(
    @Query("type") type: string,
    @Query("platform") platform?: string,
  ): Promise<ExecutorPackage | null> {
    return this.svc.findLatest(type, platform);
  }

  // R5: POST /executor-packages/install-token removed — it generated an
  // opaque token with no consumer anywhere in the repo (the install wizard
  // uses GET /executors/install-cmd since R4). It will return together with
  // a real install.sh flow, if ever implemented.

  @Get(":id")
  @ApiOperation({ summary: "Get executor package details" })
  @ApiParam({ name: "id", description: "Package ID" })
  @ApiResponse({ status: 200, description: "Package details" })
  @ApiResponse({ status: 404, description: "Package not found" })
  findOne(@Param("id", ParseUUIDPipe) id: string): Promise<ExecutorPackage> {
    return this.svc.findOne(id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update executor package info" })
  @ApiParam({ name: "id", description: "Package ID" })
  @ApiResponse({ status: 200, description: "Updated successfully" })
  @ApiResponse({ status: 404, description: "Package not found" })
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateExecutorPackageDto,
  ): Promise<ExecutorPackage> {
    return this.svc.update(id, updateDto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete executor package" })
  @ApiParam({ name: "id", description: "Package ID" })
  @ApiResponse({ status: 204, description: "Deleted successfully" })
  @ApiResponse({ status: 404, description: "Package not found" })
  remove(@Param("id", ParseUUIDPipe) id: string): Promise<void> {
    return this.svc.remove(id);
  }

  @Public()
  // Reset inherited ADMIN roles: machine callers have no req.user.
  // Access is gated by the shared token or access JWT checks below.
  @Roles()
  @Get(":id/download")
  @ApiOperation({
    summary: "Download executor package file",
    description:
      "Accepts either a valid administrator access JWT or the executor shared token. JWT validation is stateless and does not query the user database, matching upload-auth middleware; access-token expiry provides revocation latency.",
  })
  @ApiParam({ name: "id", description: "Package ID" })
  @ApiResponse({ status: 200, description: "File content" })
  @ApiResponse({ status: 401, description: "Invalid access JWT or executor token" })
  @ApiResponse({ status: 404, description: "Package or file not found" })
  async download(
    @Param("id", ParseUUIDPipe) id: string,
    @Res() res: Response,
    @Headers("authorization") authHeader?: string,
  ): Promise<void> {
    let authorized = false;
    try {
      await verifyExecutorToken(authHeader, this.configService, this.systemConfigService);
      authorized = true;
    } catch {
      // Fall back to the management access JWT.
    }

    // Mirror upload-auth.middleware: same secret and access type, no user DB
    // lookup. Revocation relies on short access-token expiry (default 15m).
    if (!authorized && authHeader?.startsWith("Bearer ")) {
      try {
        const payload = jwt.verify(
          authHeader.slice("Bearer ".length),
          this.configService.get<string>("jwt.secret"),
          { ignoreExpiration: false },
        ) as { type?: string } | string;
        authorized = typeof payload === "object" && payload.type === "access";
      } catch {
        // Both credential channels failed.
      }
    }
    if (!authorized) {
      throw new UnauthorizedException(
        "Unauthorized: package downloads require a valid access JWT or executor token",
      );
    }

    const { buffer, pkg } = await this.svc.getFileBuffer(id);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${pkg.originalFilename ?? pkg.filename ?? `${pkg.name}-${pkg.version}`}"`,
    );
    res.setHeader("Content-Type", pkg.mimeType ?? "application/octet-stream");
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
  }

  @Patch(":id/deprecate")
  @ApiOperation({ summary: "Deprecate executor package" })
  @ApiParam({ name: "id", description: "Package ID" })
  @ApiResponse({ status: 200, description: "Deprecated" })
  deprecate(@Param("id", ParseUUIDPipe) id: string): Promise<ExecutorPackage> {
    return this.svc.deprecate(id);
  }

  @Patch(":id/activate")
  @ApiOperation({ summary: "Activate executor package" })
  @ApiParam({ name: "id", description: "Package ID" })
  @ApiResponse({ status: 200, description: "Activated" })
  activate(@Param("id", ParseUUIDPipe) id: string): Promise<ExecutorPackage> {
    return this.svc.activate(id);
  }

  /**
   * Callback endpoint called by executor-node after download to report result.
   * This endpoint does not require JWT auth (executor-node has no user login),
   * but requires shared token for machine-to-machine verification.
   * Temporarily using @UseGuards(JwtAuthGuard) for consistency; can be changed to SharedTokenGuard later.
   *
   * R4 F-1: @Public() bypasses JwtAuthGuard. The class-level @Roles(ADMIN)
   * would otherwise be inherited by the global RolesGuard and reject the
   * machine caller (no req.user), so this route carries an empty @Roles()
   * override — the executor shared token verified below remains the only
   * gate (machine-to-machine semantics kept).
   */
  @Public()
  // Empty @Roles() resets the class-level ADMIN requirement for this
  // machine-to-machine callback; access is gated by the shared token check.
  @Roles()
  @Post("push-result")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Executor package push result callback (called by executor-node)",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["packageId", "executorId", "status"],
      properties: {
        packageId: { type: "string" },
        executorId: { type: "string" },
        status: { type: "string", enum: ["downloaded", "failed"] },
        version: { type: "string" },
        error: { type: "string" },
      },
    },
  })
  @ApiResponse({ status: 200, description: "Callback recorded" })
  async pushResult(
    @Headers("authorization") auth: string | undefined,
    @Body("packageId") packageId: string,
    @Body("executorId") executorId: string,
    @Body("status") status: "downloaded" | "failed",
    @Body("version") version?: string,
    @Body("error") error?: string,
  ): Promise<{ ok: boolean }> {
    await verifyExecutorToken(
      auth,
      this.configService,
      this.systemConfigService,
    );
    this.logger.log(
      `Push result: package=${packageId} executor=${executorId} status=${status}${
        error ? ` error=${error}` : ""
      }`,
    );
    // Persist push history to package.pushHistory
    try {
      const pkg = await this.svc.findOne(packageId);
      const entry = {
        executorId: executorId ?? "unknown",
        status,
        version: version ?? pkg.version,
        ...(error ? { error } : {}),
        timestamp: new Date().toISOString(),
      };
      const history = Array.isArray(pkg.pushHistory) ? pkg.pushHistory : [];
      // Keep only the most recent 100 records
      const trimmed = [...history, entry].slice(-100);
      await this.svc.update(packageId, { pushHistory: trimmed } as any);
    } catch (e: unknown) {
      this.logger.warn(
        `Failed to persist push history: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return { ok: true };
  }

  @Post(":id/push")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Push executor package to scheduler nodes" })
  @ApiParam({ name: "id", description: "Package ID" })
  @ApiBody({
    description: "Push targets (empty = push to all online executors)",
    schema: {
      type: "object",
      properties: {
        executorIds: {
          type: "array",
          items: { type: "string" },
          description: "Target executor ID list, empty = all",
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: "Push result" })
  async push(
    @Param("id", ParseUUIDPipe) id: string,
    @Body("executorIds") executorIds?: string[],
  ): Promise<
    { executorId: string; address: string; success: boolean; error?: string }[]
  > {
    const executors = await this.executorService.findAll();
    const sharedToken = (await getExecutorSharedToken(
      this.configService,
      this.systemConfigService,
    )) ?? undefined;
    return this.svc.pushToExecutors(id, executorIds, executors, sharedToken);
  }
}
