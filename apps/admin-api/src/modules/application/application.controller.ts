import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Logger,
  Headers,
  Req,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
  ApiResponse,
  ApiOkResponse,
  ApiCreatedResponse,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
import { UserRole } from "../users/entities/user.entity";
import { ApplicationService } from "./application.service";
import { AppDeploymentService } from "./app-deployment.service";
// ARCH-23 / N-12：响应体类型标注用**专用 DTO**而非实体——实体没有 @ApiProperty，
// @nestjs/swagger 只会 emit 空壳 schema（properties:{}），前端生成出
// Record<string, never>，且会被 CI 的 PK-15 空 schema 闸打红（本仓实测踩过）。
// DTO 显式声明字段并**排除 webhookSecret**（select:false 的 HMAC 密钥）。
import { ApplicationResponseDto } from "./dto/application-response.dto";
// ARCH-23 / N-12（2026-10-07 批）：Application Management 其余端点契约。
import {
  AppHealthAnalysisResponseDto,
  AppReleasesResponseDto,
  ApplicationVersionHistoryRowDto,
  ReleaseWebhookResponseDto,
  RemovalImpactResponseDto,
  SyncTasksResponseDto,
} from "./dto/application-response.dto";
import {
  ApplicationRollbackResponseDto,
  DeployVersionResponseDto,
  SetCurrentVersionResponseDto,
  UpgradeAllResponseDto,
} from "./dto/app-deployment-response.dto";
import { DeploymentTriggerType } from "./entities/app-deployment.entity";
import {
  CreateApplicationDto,
  UpdateApplicationDto,
  UploadApplicationDto,
} from "./dto/application.dto";
// R1（2026-10-24 部署模型评审 §4.2）：应用回滚拆分出的两个显式动作请求体。
import {
  DeployVersionDto,
  SetCurrentVersionDto,
} from "./dto/version-actions.dto";
import { AppReleaseWebhookDto } from "./dto/app-release-webhook.dto";
import { ListReleasesQueryDto } from "./dto/app-release.dto";
import { UpgradeAllDto } from "./dto/rollout.dto";
import * as fs from "fs";
import * as path from "path";
// R5a：上传包内容寻址——对暂存字节流式计算 sha256，作为落盘路径成分。
import { createHash } from "crypto";
// FEAT-21: HMAC 校验收敛到共享纯函数（与 alerts / 任务 webhook 同源）
import { verifyWebhookSignature } from "../../common/utils/webhook-hmac.util";
import type { Request } from "express";
import { ConfigService } from "@nestjs/config";
// SEC-09: 限流分域——upgrade-all/rollback 属集群干预写面，挂中档
// OPS_THROTTLE（默认 30/min）。装饰器求值期读取属 ARCH-27 显式豁免
//（见 src/config/throttle-profiles.ts 头注）。
import { Throttle } from "@nestjs/throttler";
import { OPS_THROTTLE } from "../../config/throttle-profiles";
import {
  ZipGuardError,
  assertZipFileSafe,
  resolveZipGuardLimits,
} from "../../common/utils/zip-guard.util";
// P1-11：从上传 zip 中读取 manifest.json（按需读中央目录 + 单个条目）
import { readManifestFromZip } from "../../common/utils/zip-manifest.util";
import {
  ClamdInfectionError,
  ClamdUnavailableError,
  isFailedVerdict,
  scanStreamWithClamd,
} from "../../common/utils/clamd-scan.util";
import { WriteGuard } from "../../common/decorators/write-guard.decorator";
// LANG-ERR-01: 用户可见报错改为稳定错误码（文案由前端按用户语言渲染）。
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";

/**
 * Same-volume staging dir for the /applications/upload multer diskStorage.
 * Keeping it inside `uploads/` (the final landing dir is `uploads/packages`)
 * makes the final move an atomic rename on one filesystem instead of buffering
 * up to 200 MB in the Node heap. Mirrors executor-package's PACKAGE_UPLOAD_TMP_DIR.
 */
const APP_UPLOAD_STAGING_DIR = path.join(
  process.cwd(),
  "uploads",
  ".app-upload-tmp",
);

@ApiTags("Application Management")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("applications")
export class ApplicationController {
  private readonly logger = new Logger(ApplicationController.name);

  // APP-001: 该端点公开给 CI/CD 调用，属于未认证攻击面。所有鉴权失败路径
  // （应用不存在 / webhookSecret 未配置 / 签名缺失或无效 / 时间戳过期 /
  // raw body 缺失）必须返回完全相同的 401 响应——任何响应差异（状态码或
  // 错误消息）都会成为枚举应用名的判定依据。具体失败原因只写入服务端日志。
  // LANG-ERR-01：该不变式现由单一错误码 APP_WEBHOOK_AUTH_FAILED 承载（所有
  // 分支共用一码，前端渲染出的文案天然一致，比"人工维护同一个字符串常量"
  // 更难被改坏）。

  constructor(
    private readonly svc: ApplicationService,
    private readonly deploymentSvc: AppDeploymentService,
    // ARCH-27: API_BASE_URL 经 ConfigService 读取（configuration.ts
    // app.apiBaseUrl + Joi 注册），取代直读 process.env。
    private readonly configService: ConfigService,
  ) {
    // multer diskStorage resolves `destination` at request time; ensure the
    // staging dir exists at boot so a first upload never hits ENOENT.
    try {
      fs.mkdirSync(APP_UPLOAD_STAGING_DIR, { recursive: true });
    } catch {
      // best-effort; multer will surface a real error at upload time
    }
  }

  /** Read the first `count` bytes of the staged file without loading it all. */
  private async readHeadBytes(
    filePath: string,
    count: number,
  ): Promise<Buffer> {
    const handle = await fs.promises.open(filePath, "r");
    try {
      const buf = Buffer.alloc(count);
      const { bytesRead } = await handle.read(buf, 0, count, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  /**
   * R5a: streaming SHA-256 of the staged package（内容寻址键）。与
   * readHeadBytes 同款句柄分块读——最大 200 MB 的包逐 1 MB 喂给哈希，
   * 从不整段进 Node 堆。
   */
  private async sha256File(filePath: string): Promise<string> {
    const hash = createHash("sha256");
    const handle = await fs.promises.open(filePath, "r");
    try {
      const chunk = Buffer.alloc(1024 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        hash.update(chunk.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
    return hash.digest("hex");
  }

  /**
   * R5a: 把用户提供的原始文件名收敛成单个安全路径段：剥目录分量（两种分隔符
   * 都剥——旧版浏览器会上报完整 Windows 路径），只保留 [A-Za-z0-9._-]
   * （与旧扁平命名对表单 name 的清洗同一字符类），拆掉 `..` 连写，去掉前导
   * 点（express.static 默认 ignore dotfiles，点文件名会 404），超长截断且保住
   * 已通过上游校验的 `.zip` 后缀。产物直接进 URL 与磁盘路径。
   */
  private sanitizePackageFilename(originalname: string): string {
    const base = path.basename(originalname.replace(/\\/g, "/"));
    let cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.\.+/g, ".");
    cleaned = cleaned.replace(/^\.+/, "");
    if (!cleaned.toLowerCase().endsWith(".zip")) {
      cleaned = `${cleaned || "package"}.zip`;
    }
    if (cleaned.length > 120) cleaned = `${cleaned.slice(0, 116)}.zip`;
    return cleaned;
  }

  @Get()
  @ApiOperation({ summary: "获取应用列表" })
  @ApiResponse({
    status: 200,
    description: "应用列表（env 已掩码，webhookSecret 从不查询）",
    type: [ApplicationResponseDto],
  })
  // AUTH-01: 可选 projectId 过滤（"default" = 默认项目视图，含未分配行）。
  findAll(@Query("projectId") projectId?: string) {
    return this.svc.findAll(projectId);
  }

  @Get(":id")
  @ApiOperation({ summary: "获取应用详情" })
  @ApiResponse({
    status: 200,
    description: "应用详情",
    type: ApplicationResponseDto,
  })
  findById(@Param("id") id: string) {
    return this.svc.findById(id);
  }

  // R1: application lifecycle (create/update/delete) plus all deployment
  // management routes below are admin-only — they mutate cluster-level
  // state (deployments, versions, env vars, git refs) that affects every
  // executor. Read endpoints (findAll/findById/version history) stay
  // visible to any authenticated user; the env field on the read surface
  // is masked the same way notification channel credentials are (see
  // NotificationConfigService). The @Public() webhook is a CI machine
  // endpoint with HMAC auth — RolesGuard finds no @Roles metadata on it
  // and lets the request through after JwtAuthGuard's @Public opt-out.
  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "创建应用" })
  @ApiResponse({
    status: 201,
    description: "已创建的应用",
    type: ApplicationResponseDto,
  })
  create(@Body() dto: CreateApplicationDto, @CurrentUser() user: AuthUser) {
    // NF-03: 创建即落 owner（ADMIN 创建也落，可追溯）
    return this.svc.create(dto, user);
  }

  @Put(":id")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "更新应用" })
  @ApiResponse({
    status: 200,
    description: "已更新的应用",
    type: ApplicationResponseDto,
  })
  update(
    @Param("id") id: string,
    @Body() dto: UpdateApplicationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.update(id, dto, user);
  }

  /**
   * P0（UX-AUDIT-2026-09-21 §P0-3）：删除影响面预览（供确认框如实告知后果）。
   * ADMIN-only，与 remove 同权限面——能看影响面的人就是能删的人。
   */
  @Get(":id/removal-impact")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "预览删除该应用会破坏什么" })
  @ApiOkResponse({ type: RemovalImpactResponseDto })
  removalImpact(@Param("id") id: string) {
    return this.svc.describeRemovalImpact(id);
  }

  @Delete(":id")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "删除应用" })
  // N-12: service 返回 void → envelope data 为 null，契约如实声明可空。
  @ApiOkResponse({
    description: "已移除；信封 data 为 null",
    schema: { nullable: true },
  })
  remove(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.svc.remove(id, user);
  }

  @Post("upload")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "上传应用包（zip）" })
  @ApiConsumes("multipart/form-data")
  // N-12: upsert 后的应用行（create/update 同一读面）。
  @ApiCreatedResponse({ type: ApplicationResponseDto })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        file: { type: "string", format: "binary" },
        name: { type: "string" },
        runtime: { type: "string" },
      },
      required: ["file", "name"],
    },
  })
  // diskStorage (not memoryStorage): the up-to-200 MB package lands in
  // APP_UPLOAD_STAGING_DIR on disk instead of a Node-heap buffer. The multer
  // field name stays "file" and the 200 MB limit is unchanged; only the storage
  // medium changes. The staged temp file is always cleaned up (finally).
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({ destination: APP_UPLOAD_STAGING_DIR }),
      limits: { fileSize: 200 * 1024 * 1024 },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: UploadApplicationDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file) throw new AppError(ErrorCode.APP_UPLOAD_FILE_MISSING);
    // ARCH-003: name/runtime 经全局 ValidationPipe（whitelist + MaxLength）校验，
    // 不再用裸 @Body("name") 字符串绕过验证管道
    const { name, runtime, version } = body;
    if (!name) throw new AppError(ErrorCode.APP_UPLOAD_NAME_REQUIRED);

    // diskStorage: the package is staged on disk, not in file.buffer.
    const tmpPath = file.path;
    if (!tmpPath) {
      throw new AppError(ErrorCode.APP_UPLOAD_PAYLOAD_MISSING);
    }

    try {
      // P1: upload validation — extension whitelist plus ZIP magic number, so
      // arbitrary content cannot be stored and served as a trusted .zip.
      const ext = path.extname(file.originalname || "").toLowerCase();
      if (ext !== ".zip") {
        throw new AppError(ErrorCode.APP_UPLOAD_NOT_ZIP);
      }
      const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      // Read only the first 4 bytes from the staged temp file.
      const head = await this.readHeadBytes(tmpPath, 4);
      if (head.length < 4 || !head.equals(ZIP_MAGIC)) {
        throw new AppError(ErrorCode.APP_UPLOAD_NOT_ZIP_ARCHIVE);
      }

      // SEC-05: zip bomb guard — structural central-directory vetting BEFORE
      // the archive is persisted or advertised to executors. Rejects
      // high-ratio bombs / entry-count floods / oversized single files /
      // oversized totals, with bounded nested-zip probing. Fail-closed: any
      // parse anomaly (including an unreadable structure) is a rejection.
      // assertZipFileSafe now parses only the EOCD + central directory from the
      // staged file (no full read into memory).
      try {
        assertZipFileSafe(
          tmpPath,
          resolveZipGuardLimits(this.configService.get("zipGuard")),
        );
      } catch (err: unknown) {
        if (err instanceof ZipGuardError) {
          this.logger.warn(
            `Application package upload rejected by zip-guard [${err.violation}]: ${err.message}`,
          );
          throw new AppError(ErrorCode.APP_UPLOAD_ZIP_GUARD_REJECTED, {
            violation: err.violation,
          });
        }
        throw err;
      }

      // SEC-05: optional ClamAV scan hook. CLAMD_ENABLED=false (default) makes
      // this a no-op. Fail-closed when enabled: an unreachable / timed-out /
      // errored scanner REJECTS the upload (503) — absence of a verdict is
      // never an allow. An infection is a 400 with a generic message (the
      // signature name is logged server-side only). The staged file is streamed
      // to clamd INSTREAM instead of being buffered in memory.
      // ARCH-008: the scan stream is constructed only when scanning will
      // actually run. A ReadStream created for a disabled scan still opens
      // its file asynchronously; if that open loses the race with the rename
      // below it fails ENOENT with no 'error' listener — an uncaughtException
      // that took the whole instance down (2026-09-29 prod).
      const clamdEnabled =
        this.configService.get<boolean>("clamd.enabled") === true;
      if (clamdEnabled) {
        try {
          const verdict = await scanStreamWithClamd(
            fs.createReadStream(tmpPath),
            {
              enabled: clamdEnabled,
              host: this.configService.get<string>("clamd.host") || "127.0.0.1",
              port: this.configService.get<number>("clamd.port") || 3310,
              timeoutMs:
                this.configService.get<number>("clamd.timeoutMs") || 10000,
            },
            this.logger,
          );
          if (isFailedVerdict(verdict)) {
            if (verdict.reason === "infected") {
              this.logger.warn(
                `Application package upload rejected: clamd infection ${verdict.detail}`,
              );
              throw new ClamdInfectionError(verdict.detail);
            }
            throw new ClamdUnavailableError(
              verdict.reason === "timeout"
                ? "timeout"
                : verdict.reason === "error"
                  ? "error"
                  : "unreachable",
              verdict.detail,
            );
          }
        } catch (err: unknown) {
          if (
            err instanceof ClamdInfectionError ||
            err instanceof ClamdUnavailableError
          ) {
            if (err instanceof ClamdInfectionError) {
              throw new AppError(ErrorCode.APP_UPLOAD_MALWARE_DETECTED);
            }
            throw new AppError(ErrorCode.APP_UPLOAD_SCANNER_UNAVAILABLE);
          }
          throw err;
        }
      }

      // APP-002: packageUrl 会被 executor 节点拉取。旧实现缺 API_BASE_URL 时静默
      // 回退 `http://localhost:PORT`，生成的 URL 在其它机器上不可达，问题被推迟到
      // 部署阶段才暴露。这里选择 fail-fast（使用时记 error 并抛 500）而非从请求
      // Host 推导：上传请求的 Host 可能是 CI 容器的 localhost 或反向代理地址，
      // 静默推导同样会存下不可达的 URL，只是把失败换个地方隐藏；显式报错能在
      // 上传这一步就把配置缺失暴露给调用方。
      // R9b: the API_BASE_URL check runs BEFORE anything is written to disk —
      // the old order (write file → check) leaked an orphan zip on every
      // misconfigured upload.
      // ARCH-27: 经 ConfigService 读 app.apiBaseUrl（原直读 process.env）。
      const apiBase = this.configService.get<string>("app.apiBaseUrl");
      if (!apiBase) {
        this.logger.error(
          "API_BASE_URL is not configured — cannot build a package download URL reachable by executors. Set API_BASE_URL to the externally reachable base URL of this API and retry.",
        );
        throw new AppError(ErrorCode.APP_UPLOAD_BASE_URL_NOT_CONFIGURED);
      }

      // R5a（内容寻址，评审 §4.5/§九 5a）：对暂存字节流式计算 sha256——同字节
      // 重复上传得到同一路径/同一 URL（执行器按 URL 键控的 zip 字节缓存天然
      // 去重命中），URL 与字节内容绑定，天然可校验。
      const sha = await this.sha256File(tmpPath);

      // P1-11：解析 zip 内 manifest.json，回填 manifest/entrypoint/runtime。
      // 与 git 部署路径（application.service.deployFromGit）对齐——此前 zip 上传
      // 完全不解析 manifest，entrypoint 只能靠人手填，填错就部署失败。
      // R5a：解析提前到建行/落盘之前——内容寻址路径嵌 <appId>，应用行必须先于
      // 文件存在，而 create 的回填字段需要 manifest 值，故 manifest 必须最先解
      // 析（此刻暂存文件必然存在，不存在历史上「rename 之后读 tmpPath」的时序）。
      // 容错：找不到/损坏/非法 JSON 只 warn，不阻断上传（manifest 是增强不是闸门）。
      // 优先级：用户在表单显式选的 runtime > manifest.runtime > 既有值。
      let manifestParsed: Record<string, unknown> | undefined;
      let manifestEntrypoint: string | undefined;
      let manifestRuntime: string | undefined;
      try {
        const manifestText = readManifestFromZip(tmpPath);
        if (manifestText) {
          const parsed: unknown = JSON.parse(manifestText);
          if (parsed && typeof parsed === "object") {
            manifestParsed = parsed as Record<string, unknown>;
            if (
              typeof manifestParsed.entrypoint === "string" &&
              manifestParsed.entrypoint
            ) {
              manifestEntrypoint = manifestParsed.entrypoint;
            }
            if (
              typeof manifestParsed.runtime === "string" &&
              manifestParsed.runtime
            ) {
              manifestRuntime = manifestParsed.runtime;
            }
            this.logger.log(
              `Parsed manifest.json from uploaded package for ${name}: runtime=${manifestRuntime ?? "-"} entrypoint=${manifestEntrypoint ?? "-"}`,
            );
          }
        }
      } catch (err: unknown) {
        this.logger.warn(
          `zip manifest.json 解析失败（忽略，继续上传）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // R5a：内容寻址路径嵌 <appId>，应用行必须先于文件落地存在。已有应用直接
      // 用其 id；新应用先建行（暂不带 packageUrl——URL 由 appId+sha 唯一决定，
      // 下方 update 对两条分支统一写入，最终行仍带完整 packageUrl）。
      const existing = await this.svc.findByName(name);
      let app;
      if (existing) {
        app = existing;
      } else {
        app = await this.svc.create(
          {
            name,
            runtime: runtime || manifestRuntime || "python",
            version: version || "1.0.0",
            ...(manifestParsed ? { manifest: manifestParsed } : {}),
            ...(manifestEntrypoint ? { entrypoint: manifestEntrypoint } : {}),
          },
          user,
        );
      }

      // Land the staged package at the content-addressed location
      // uploads/packages/<appId>/<sha256>/<origName>.zip (served as static
      // files; <appId>/<sha256> 目录按需创建). The file already lives on
      // disk — move it into place with an atomic rename (staging dir is on
      // the same volume as uploads/packages), falling back to copy+unlink
      // for cross-volume mounts. Same bytes re-uploaded resolve to the exact
      // same path: reuse the existing file verbatim instead of rewriting it
      // (stable mtime, no partial-overwrite window for concurrent uploads
      // of the same package); the staged temp file is then simply discarded
      // by the finally block below.
      const uploadsDir = path.join(process.cwd(), "uploads", "packages");
      const targetDir = path.join(uploadsDir, app.id, sha);
      if (!fs.existsSync(targetDir))
        fs.mkdirSync(targetDir, { recursive: true });
      const origName = this.sanitizePackageFilename(file.originalname);
      const zipPath = path.join(targetDir, origName);
      let landedFresh = false;
      if (!fs.existsSync(zipPath)) {
        try {
          await fs.promises.rename(tmpPath, zipPath);
        } catch {
          await fs.promises.copyFile(tmpPath, zipPath);
        }
        landedFresh = true;
      }
      const packageUrl = `${apiBase}/uploads/packages/${app.id}/${sha}/${origName}`;

      // Upsert the application fields (create-if-not-exists already happened
      // above to pin the appId): a single update pins the freshly computed
      // packageUrl plus the form/manifest overrides. This keeps upload
      // idempotent and supports iterative releases.
      try {
        app = await this.svc.update(
          app.id,
          {
            packageUrl,
            ...(runtime ? { runtime } : {}),
            ...(!runtime && manifestRuntime
              ? { runtime: manifestRuntime }
              : {}),
            // 上传即产生版本（方案 A）：表单显式提供的 version 覆盖既有值，
            // 使本次上传在 application_versions 里成为可回滚的新版本。
            ...(version ? { version } : {}),
            ...(manifestParsed ? { manifest: manifestParsed } : {}),
            ...(manifestEntrypoint ? { entrypoint: manifestEntrypoint } : {}),
          },
          user,
        );
      } catch (err: unknown) {
        // R9b: DB update failed after the file landed — best-effort unlink so
        // the failed upload does not leave an orphan file behind.
        // R5a: only a file THIS request landed may be cleaned — a reused
        // content-addressed file can still be pinned by other version
        // snapshots (same bytes previously uploaded under another version
        // number), deleting it would break those rollback targets.
        if (landedFresh) {
          try {
            await fs.promises.unlink(zipPath);
          } catch {
            // best-effort
          }
        }
        throw err;
      }
      // 上传即产生版本（方案 A）：落 application_versions 快照，使 zip 上传也
      // 出现在版本历史中、可回滚。best-effort——内部自吞异常，绝不影响上传结果。
      await this.svc.recordUploadVersion(app, user);
      return app;
    } finally {
      // Always clean up the staged temp file. After a successful rename the
      // path no longer exists (unlink fails silently); every validation /
      // clamd / landing failure path above reaches here and removes it.
      try {
        await fs.promises.unlink(tmpPath);
      } catch {
        // best-effort
      }
    }
  }

  @Public()
  @WriteGuard("application", {
    scope: "public",
    reason:
      "外部 CI/git 触发部署，凭 per-application webhook secret 做 HMAC 校验",
  })
  @Post("webhook")
  @ApiOperation({
    description:
      "接收版本发布通知并更新应用版本。若 triggerDeploy=true，则对所有 RUNNING 状态的部署触发滚动升级。该路由对 CI/CD 调用方公开，且匹配到的应用必须已配置 webhookSecret。调用方必须携带 X-AutoCodeFlow-Timestamp 与 X-Hub-Signature-256 请求头。签名是对 `${timestamp}.${rawBody}` 计算的 HMAC-SHA256。",
    summary: "版本发布 Webhook",
  })
  @ApiCreatedResponse({ type: ReleaseWebhookResponseDto })
  async webhook(
    @Body() dto: AppReleaseWebhookDto,
    @Headers("x-hub-signature-256") signature?: string,
    @Headers("x-autocodeflow-timestamp") timestamp?: string,
    @Req() req?: Request & { rawBody?: Buffer },
  ) {
    const logger = new Logger("ReleaseWebhook");

    // Find application by name (include webhookSecret for HMAC validation)
    // APP-001: 无论后续哪一步失败，对外只暴露同一个 401 消息，
    // 使"应用不存在"与"secret/签名错误"不可区分，防止应用名枚举。
    const targetApp = await this.svc.findByNameWithSecret(dto.appName);
    if (!targetApp) {
      logger.warn(`Webhook: no application found with name "${dto.appName}"`);
      throw new AppError(ErrorCode.APP_WEBHOOK_AUTH_FAILED);
    }

    // HMAC-SHA256 signature verification (same convention as GitHub webhooks)
    // This route is public for CI/CD systems, so every matching application must
    // have a webhookSecret and callers must sign the raw body with a timestamp.
    if (!targetApp.webhookSecret) {
      logger.warn(
        `Webhook: app "${dto.appName}" has no webhookSecret configured`,
      );
      throw new AppError(ErrorCode.APP_WEBHOOK_AUTH_FAILED);
    }
    // HMAC-SHA256 signature verification (same convention as GitHub webhooks)
    // This route is public for CI/CD systems, so every matching application must
    // have a webhookSecret and callers must sign the raw body with a timestamp.
    // FEAT-21: 校验算法/窗口/常数时间比较收敛到 webhook-hmac.util（三处 webhook 同源）。
    const failure = verifyWebhookSignature(
      { rawBody: req?.rawBody, signature, timestamp },
      targetApp.webhookSecret,
    );
    if (failure) {
      logger.warn(
        `Webhook: signature verification failed (${failure}) for app "${dto.appName}"`,
      );
      throw new AppError(ErrorCode.APP_WEBHOOK_AUTH_FAILED);
    }

    // Update version / git metadata
    const updatedApp = await this.svc.update(
      targetApp.id,
      {
        version: dto.version,
        ...(dto.gitCommit ? { gitCommit: dto.gitCommit } : {}),
        ...(dto.gitBranch ? { gitBranch: dto.gitBranch } : {}),
      },
      undefined,
      // NF-03: webhook 是 HMAC 鉴权的机器面，无 AuthUser——绕过用户属主守卫
      { systemBypass: true },
    );
    logger.log(
      `Release webhook: ${dto.appName} → v${dto.version} (commit=${dto.gitCommit?.slice(0, 8) ?? "n/a"})`,
    );

    // Optionally trigger rolling upgrade on all RUNNING deployments
    let triggeredDeployments = 0;
    if (dto.triggerDeploy) {
      const running = await this.deploymentSvc.findRunningByApp(targetApp.id);
      await Promise.allSettled(
        running.map((d) =>
          this.deploymentSvc
            .upgrade(d.id)
            .catch((err) =>
              logger.error(
                `Upgrade failed for deployment ${d.id}: ${err.message}`,
              ),
            ),
        ),
      );
      triggeredDeployments = running.length;
      logger.log(
        `Triggered upgrade on ${triggeredDeployments} running deployment(s) for "${dto.appName}"`,
      );
    }

    return { ok: true, updatedApp, triggeredDeployments };
  }

  @Get(":id/versions")
  @ApiOperation({
    description: "返回已持久化的应用版本快照；对历史数据回退到部署记录。",
    summary: "获取应用版本历史",
  })
  @ApiOkResponse({ type: [ApplicationVersionHistoryRowDto] })
  async getVersionHistory(@Param("id") id: string) {
    await this.svc.findById(id);
    return this.deploymentSvc.getVersionHistory(id);
  }

  /**
   * DEP-01 统一资源：版本 × 部署一屏追溯（每行 = 一次版本发布，聚合包地址/
   * 最近一次部署时间、状态、触发方式、操作人）。只读端点，与 findAll/findById/
   * versions 同权限面——任意认证用户可见（类级 JwtAuthGuard），不写入、不改 schema。
   * 旧端点 GET /applications/:id/versions 与 GET /app-deployments 原样保留为
   * 过渡期 alias（数据同源；过渡期结束另行任务收口）。
   */
  @Get(":id/releases")
  @ApiOperation({
    description:
      "统一发布追溯视图：按版本聚合部署信息，分页默认 50、上限 200。",
    summary: "列出应用的统一发布记录（版本 × 最新部署）",
  })
  @ApiOkResponse({
    type: AppReleasesResponseDto,
    description:
      "裸四键信封（data/total/page/pageSize），非 paginate() 双键形态",
  })
  listReleases(@Param("id") id: string, @Query() query: ListReleasesQueryDto) {
    return this.deploymentSvc.getReleases(
      id,
      query.page ?? 1,
      query.pageSize ?? 50,
    );
  }

  // SEC-09: 中档限流（应用干预写面，OPS_THROTTLE 默认 30/min）
  @Throttle({ default: OPS_THROTTLE })
  @Post(":id/upgrade-all")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    description:
      "DEP-02: body 缺省（或 rollout.strategy=all）= 既有全量升级；rollout.strategy=canary 时先升 percentage 比例（至少 1 台）→ 健康探测（manifest.healthCheck 声明，DEP-03）→ 通过后自动提升其余台；任一失败暂停批次并对已升级台自动回滚。批次为进程内状态，admin-api 重启即暂停（行级 rolloutState=failed）。",
    summary: "触发所有运行中实例升级到最新版本",
  })
  // POST 无 @HttpCode → 实际 201（历史直觉 200 是漂移，按实际落契约）。
  @ApiCreatedResponse({ type: UpgradeAllResponseDto })
  async upgradeAll(
    @Param("id") id: string,
    @Body() dto: UpgradeAllDto,
    // FEAT-20: upgrade-all 逐行落 upgrade 语义 + 操作人用户名。
    @CurrentUser() user: { id: number; username: string },
  ) {
    return this.deploymentSvc.upgradeAllWithRollout(
      id,
      dto?.rollout ?? null,
      user
        ? {
            operator: user.username,
            triggerType: DeploymentTriggerType.UPGRADE,
          }
        : undefined,
      dto?.version,
    );
  }

  @Post(":id/sync-tasks")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    description: "解析应用的 manifest.json 并自动注册任务定义",
    summary: "从 manifest.json 同步任务注册",
  })
  @ApiCreatedResponse({ type: SyncTasksResponseDto })
  async syncTasks(@Param("id") id: string) {
    const count = await this.svc.syncTasksFromManifest(id);
    return { ok: true, registeredCount: count };
  }

  @Post(":id/analyze")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    description: "聚合该应用下所有任务的执行统计，并运行 AI 健康评估",
    summary: "应用健康度 AI 分析",
  })
  @ApiCreatedResponse({ type: AppHealthAnalysisResponseDto })
  async analyzeHealth(@Param("id") id: string) {
    return this.svc.analyzeHealth(id);
  }

  // ── R1（2026-10-24 部署模型评审 §4.2）：应用回滚拆分为两个显式动作 ──────
  // 旧 /rollback 把「按版本快照恢复应用当前字段」与「全量下发到 RUNNING 部署」
  // 捆绑：只想改回记录面也被迫重启全部实例。下面两个端点把动作拆开；旧端点
  // 保留为 deprecated alias（见下）。权限/限流对齐旧 rollback 写面（ADMIN +
  // OPS_THROTTLE；旧端点本无独立审计落证，新端点同样不新增）。

  // SEC-09: 中档限流（应用干预写面，OPS_THROTTLE 默认 30/min）
  @Throttle({ default: OPS_THROTTLE })
  @Post(":id/set-current-version")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "将应用当前字段设为指定版本快照（不动部署/设备）",
    description:
      "R1（部署模型评审 §4.2）：只按 application_versions 快照恢复应用当前字段（version/gitCommit/gitBranch/packageUrl/env/entrypoint/manifest/runtime，与 rollback 同一映射），绝不触碰部署行与设备。响应 dispatched:false。校验与错误码与 rollback 快照路径一致（版本存在 404、属本应用/已发布 400）",
  })
  @ApiCreatedResponse({ type: SetCurrentVersionResponseDto })
  async setCurrentVersion(
    @Param("id") appId: string,
    @Body() dto: SetCurrentVersionDto,
  ) {
    return this.deploymentSvc.setCurrentVersion(appId, dto.versionId);
  }

  // SEC-09: 中档限流（应用干预写面，OPS_THROTTLE 默认 30/min）
  @Throttle({ default: OPS_THROTTLE })
  @Post(":id/deploy-version")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "按版本快照恢复应用字段后下发到设备（可按执行器点名）",
    description:
      "R1（部署模型评审 §4.2）：先执行与 set-current-version 完全相同的字段恢复，再下发。executorIds 缺省 = 该应用全部 RUNNING 部署行（与旧 rollback 行为一致）；显式 executorIds = 仅对这些执行器对应的 RUNNING 部署行逐台走既有 upgrade 链（部署行 startCommand 会被覆写为恢复后的 app.entrypoint——既有 upgrade 语义）。执行器无部署行/行状态不可下发的进响应 skipped 明细（no_deployment/not_running/upgrade_rejected），不报错。部署行触发痕迹落 triggerType=rollback + 操作人（该端点为旧「应用回滚」拆出的下发半边）",
  })
  @ApiCreatedResponse({ type: DeployVersionResponseDto })
  async deployVersion(
    @Param("id") appId: string,
    @Body() dto: DeployVersionDto,
    // FEAT-20: 下发链逐行落 rollback 语义 + 操作人用户名。
    @CurrentUser() user: { id: number; username: string },
  ) {
    return this.deploymentSvc.deployVersion(
      appId,
      dto.versionId,
      dto.executorIds,
      user
        ? {
            operator: user.username,
            triggerType: DeploymentTriggerType.ROLLBACK,
          }
        : undefined,
    );
  }

  // SEC-09: 中档限流（应用干预写面，OPS_THROTTLE 默认 30/min）
  @Throttle({ default: OPS_THROTTLE })
  @Post(":id/rollback/:deploymentId")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    deprecated: true,
    description:
      "【deprecated】下一版本删除。等价于 set-current-version + deploy-version（executorIds 缺省）的组合，行为与历史版本逐字节一致。新调用方请改用 POST /applications/:id/set-current-version 与 POST /applications/:id/deploy-version",
    summary: "将应用回滚到历史版本（deprecated alias）",
  })
  @ApiCreatedResponse({ type: ApplicationRollbackResponseDto })
  async rollback(
    @Param("id") appId: string,
    @Param("deploymentId") deploymentId: string,
    // FEAT-20: 回退链逐行落 rollback 语义 + 操作人用户名。
    @CurrentUser() user: { id: number; username: string },
  ) {
    return this.deploymentSvc.rollbackApplication(
      appId,
      deploymentId,
      user
        ? {
            operator: user.username,
            triggerType: DeploymentTriggerType.ROLLBACK,
          }
        : undefined,
    );
  }
}
