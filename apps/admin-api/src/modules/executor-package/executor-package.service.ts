import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, Like, FindOptionsWhere } from "typeorm";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import axios from "axios";
import { ConfigService } from "@nestjs/config";
import {
  assertAndPinExecutorUrl,
  pinnedAxiosConfig,
} from "../../common/utils/safe-http.util";
import {
  ZipGuardError,
  assertZipFileSafe,
  resolveZipGuardLimits,
} from "../../common/utils/zip-guard.util";
import { createResponseReadStream } from "../../common/utils/response-stream.util";
import {
  isFailedVerdict,
  scanStreamWithClamd,
} from "../../common/utils/clamd-scan.util";
// DEEP-AUDIT B·3.1：「最新安装包」按语义化版本取最大（与执行器版本门禁同源）。
import { compareDottedVersions } from "../executor/version-compare.util";
import {
  ExecutorPackage,
  ExecutorPackageStatus,
} from "./executor-package.entity";
import {
  CreateExecutorPackageDto,
  UpdateExecutorPackageDto,
  QueryExecutorPackageDto,
} from "./dto/executor-package.dto";
import { ExecutorStatus } from "../executor/entities/executor.entity";
// ARCH-33（ADR-016）：pull 执行器的包推送改走命令队列（控制面 pull 通道）。
import { ExecutorService } from "../executor/executor.service";

/** Upload directory for executor package files (relative to process working directory) */
const UPLOAD_DIR = path.join(process.cwd(), "uploads", "executor-packages");

/**
 * R9: same-volume staging directory for multer diskStorage uploads. Keeping
 * the temp file inside UPLOAD_DIR makes the final move an atomic rename on
 * the same filesystem instead of buffering the whole (up to 500 MB) upload
 * in the Node heap. Exported for the controller's FileInterceptor config.
 */
export const PACKAGE_UPLOAD_TMP_DIR = path.join(UPLOAD_DIR, "upload-tmp");

/** QA9: multer temp files older than this are swept away at startup — a
 *  crashed process (or a killed 500 MB upload) can leave them behind with no
 *  request path ever cleaning them up. One hour is far above any legitimate
 *  upload duration (the interceptor caps uploads at 500 MB / 60s timeouts). */
const UPLOAD_TMP_STALE_MS = 60 * 60 * 1000;

/**
 * 遗留 P1-10：push 逐执行器结果明细。
 *
 * 旧响应只面向聚合（前端读 queued/success/error 三态），逐执行器失败原因散在
 * runtime 对象里、类型未声明。这里显式建模每台结果：status 三态机 + 可选
 * commandId/error；success 布尔保留供旧消费方兼容。
 */
export type ExecutorPushResultStatus = "queued" | "success" | "error";
export interface ExecutorPushResult {
  executorId: string;
  address: string;
  /** queued=已入 pull 命令队列；success=push 同步 accepted；error=失败。 */
  status: ExecutorPushResultStatus;
  /** queued 时回填中台命令 ID（终态由 push-result 回调收敛）。 */
  commandId?: string;
  /** error 时回填诊断信息。 */
  error?: string;
  /** 向后兼容：旧消费方读布尔。 */
  success: boolean;
}

/**
 * A-8（执行器域审计 P3）：pushHistory 追加 + 上限裁剪的**纯函数**（单测锚点）。
 * 追加到尾部、只保留最近 max（默认 100）条——与旧 controller 内联逻辑逐字节
 * 等价（[...history, entry].slice(-100)），差异只在"基于哪一版行"：
 * appendPushHistory 在事务锁内重读最新行后再走本函数。
 */
export function appendPushHistoryEntry(
  history: ExecutorPackage["pushHistory"] | null | undefined,
  entry: ExecutorPackage["pushHistory"][number],
  max = 100,
): ExecutorPackage["pushHistory"] {
  const base = Array.isArray(history) ? history : [];
  return [...base, entry].slice(-max);
}

@Injectable()
export class ExecutorPackageService implements OnModuleInit {
  private readonly logger = new Logger(ExecutorPackageService.name);

  constructor(
    @InjectRepository(ExecutorPackage)
    private readonly repo: Repository<ExecutorPackage>,
    private readonly configService: ConfigService,
    // ARCH-33（ADR-016）：pull 执行器的包推送改走命令队列，需要按 id 定位
    // 执行器行并判协议版本。@Optional 仅为既有单测装配兼容（先例
    // executor.service 的 eventBus/audit）——provider 缺失时 pushToExecutors
    // 退化为纯 push（行为与今日一致），主链不受影响。
    @Optional()
    private readonly executorService: ExecutorService | null = null,
  ) {
    // Ensure upload directories exist on startup
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
    if (!fs.existsSync(PACKAGE_UPLOAD_TMP_DIR)) {
      fs.mkdirSync(PACKAGE_UPLOAD_TMP_DIR, { recursive: true });
    }
  }

  /** QA9: startup sweep — remove stale leftover files from the upload
   *  staging directory (crash / killed-upload orphans). Best-effort: any
   *  error is logged and must not block module bootstrap. */
  async onModuleInit(): Promise<void> {
    try {
      const entries = await fs.promises.readdir(PACKAGE_UPLOAD_TMP_DIR);
      const cutoff = Date.now() - UPLOAD_TMP_STALE_MS;
      for (const entry of entries) {
        const fullPath = path.join(PACKAGE_UPLOAD_TMP_DIR, entry);
        try {
          const st = await fs.promises.stat(fullPath);
          if (st.isFile() && st.mtimeMs < cutoff) {
            await fs.promises.unlink(fullPath);
            this.logger.warn(
              `Swept stale upload temp file (older than 1h): ${fullPath}`,
            );
          }
        } catch (err: unknown) {
          // per-entry best-effort — a concurrent remove must not abort the sweep
          this.logger.warn(
            `Failed to inspect temp file ${fullPath}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to sweep ${PACKAGE_UPLOAD_TMP_DIR}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * R9: read only the first `count` bytes of a file (content sniffing)
   * without loading the whole package into memory.
   */
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
   * R9: SHA-256 checksum computed by streaming the file from disk — the
   * previous implementation hashed the in-memory buffer, which forced a
   * 500 MB upload to be resident in the heap twice over.
   */
  private hashFileSha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const rs = fs.createReadStream(filePath);
      rs.on("data", (chunk: string | Buffer) => hash.update(chunk));
      rs.on("error", reject);
      rs.on("end", () => resolve(hash.digest("hex")));
    });
  }

  /**
   * Create executor package, save uploaded file to disk and record SHA-256 checksum.
   *
   * R9: the uploaded file arrives already on disk (multer diskStorage, see
   * the controller). Validation reads only the first bytes, the checksum is
   * streamed, and the file is moved (renamed) into the upload directory —
   * no in-memory buffer is ever written back to disk. The multer temp file
   * is always cleaned up: moved on success, unlinked best-effort on failure.
   */
  async create(
    createDto: CreateExecutorPackageDto,
    file: Express.Multer.File,
    uploadedBy?: string,
  ): Promise<ExecutorPackage> {
    if (!file) {
      throw new BadRequestException("Package file is required");
    }
    const tmpPath = file.path;
    if (!tmpPath) {
      throw new BadRequestException(
        "Uploaded file payload is missing (expected multer diskStorage upload)",
      );
    }

    try {
      // Check if same name/version/type already exists
      const existing = await this.repo.findOne({
        where: {
          name: createDto.name,
          version: createDto.version,
          type: createDto.type,
        },
      });
      if (existing) {
        throw new ConflictException(
          `Package ${createDto.name}@${createDto.version} (${createDto.type}) already exists`,
        );
      }

      // P1: upload validation — extension whitelist plus magic-number check
      // (zip family starts with PK, gzip with 1f 8b), rejecting arbitrary
      // content stored under a trusted extension.
      const lowerName = (file.originalname || "").toLowerCase();
      const effectiveExt = lowerName.endsWith(".tar.gz")
        ? ".tar.gz"
        : path.extname(lowerName) || "";
      const ALLOWED_EXTS = new Set([".zip", ".whl", ".tar.gz", ".tgz"]);
      if (!ALLOWED_EXTS.has(effectiveExt)) {
        throw new BadRequestException(
          `Unsupported package extension "${effectiveExt || "(none)"}". Allowed: .zip, .whl, .tar.gz, .tgz`,
        );
      }
      const head = await this.readHeadBytes(tmpPath, 2);
      const isArchive =
        (head[0] === 0x50 && head[1] === 0x4b) ||
        (head[0] === 0x1f && head[1] === 0x8b);
      if (!isArchive) {
        throw new BadRequestException(
          "Package content is not a zip/wheel/gzip archive",
        );
      }

      // SEC-05: zip bomb guard for the .zip / .whl slice of the whitelist.
      // .whl IS a zip (PEP 427) — same structural vetting applies. Only the
      // PK family is analyzed: gzip (0x1f 0x8b) streams (.tar.gz/.tgz) have
      // no central directory and are bounded by the 500 MB multer limit
      // plus the executor's extraction-side guard. Fail-closed on parse
      // anomalies (an unreadable package cannot be vetted).
      if (head[0] === 0x50 && head[1] === 0x4b) {
        try {
          assertZipFileSafe(
            tmpPath,
            resolveZipGuardLimits(this.configService.get("zipGuard")),
          );
        } catch (err: unknown) {
          if (err instanceof ZipGuardError) {
            this.logger.warn(
              `Executor package upload rejected by zip-guard [${err.violation}]: ${err.message}`,
            );
            throw new BadRequestException(
              `Package rejected by zip-bomb guard (${err.violation})`,
            );
          }
          throw err;
        }

        // SEC-05: optional clamd hook (same fail-closed policy as the
        // application upload path; CLAMD_ENABLED=false keeps it a no-op).
        // DEEP-AUDIT B·3.3：改走 INSTREAM **流式**扫描——multer diskStorage
        // 已把上传落在 tmpPath，再 readFile 进 Buffer 等于把 500 MB 包整个
        // 搬进堆里，纯为扫描而生。scanStreamWithClamd（与 application
        // 上传路径同款）按 4 字节长度前缀分块直灌 clamd，TCP 背压暂停源流，
        // 堆占用 O(块) 而非 O(包)。verdict 契约不变（fail-closed，不抛）。
        const verdict = await scanStreamWithClamd(
          fs.createReadStream(tmpPath),
          {
            enabled: this.configService.get<boolean>("clamd.enabled") === true,
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
              `Executor package upload rejected: clamd infection ${verdict.detail}`,
            );
            throw new BadRequestException(
              "Package rejected: antivirus scan detected a threat",
            );
          }
          this.logger.warn(
            `Executor package upload rejected: clamd unavailable (${verdict.reason}): ${verdict.detail}`,
          );
          throw new ServiceUnavailableException(
            "Package rejected: antivirus scan is unavailable (fail-closed)",
          );
        }
      }

      // Calculate SHA-256 checksum (streamed from disk)
      const checksum = await this.hashFileSha256(tmpPath);

      // Construct unique filename: <name>-<version>-<first8checksum>.<ext>
      const safeName = createDto.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const safeVersion = createDto.version.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `${safeName}-${safeVersion}-${checksum.slice(0, 8)}${effectiveExt}`;
      const filePath = path.join(UPLOAD_DIR, filename);

      // R9: the upload already lives on disk — move it into place. rename is
      // atomic on the same volume (temp dir is inside UPLOAD_DIR); fall back
      // to copy+unlink for cross-volume setups.
      try {
        await fs.promises.rename(tmpPath, filePath);
      } catch {
        await fs.promises.copyFile(tmpPath, filePath);
        await fs.promises.unlink(tmpPath);
      }

      const pkg = this.repo.create({
        ...createDto,
        uploadedBy,
        filename,
        filePath,
        originalFilename: file.originalname,
        mimeType: file.mimetype,
        fileSize: file.size,
        checksum,
        status: ExecutorPackageStatus.ACTIVE,
      });
      let saved: ExecutorPackage;
      try {
        saved = await this.repo.save(pkg);
      } catch (err: unknown) {
        // QA9: the file has already been moved into its final location when
        // the DB write fails — unlink it so an on-disk orphan does not linger
        // (invisible to any listing, and colliding with a future upload of
        // the same checksum). Best-effort: the original save error is what
        // the caller must see.
        try {
          await fs.promises.unlink(filePath);
        } catch {
          // best-effort
        }
        throw err;
      }
      this.logger.log(
        `Created executor package: ${saved.name}@${saved.version} [${saved.id}], file=${filename}, size=${file.size}, checksum=${checksum}`,
      );
      return saved;
    } finally {
      // R9: best-effort temp cleanup. After a successful rename the temp
      // path no longer exists and the unlink fails silently.
      try {
        await fs.promises.unlink(tmpPath);
      } catch {
        // best-effort
      }
    }
  }

  async findAll(
    query: QueryExecutorPackageDto,
  ): Promise<{ items: ExecutorPackage[]; total: number }> {
    const { page = 1, pageSize = 20, name, type, status, platform } = query;
    const where: FindOptionsWhere<ExecutorPackage> = {};
    if (name) where.name = Like(`%${name}%`);
    if (type) where.type = type;
    if (status) where.status = status;
    if (platform) where.platform = platform;

    const [items, total] = await this.repo.findAndCount({
      where,
      order: { createdAt: "DESC" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total };
  }

  async findOne(id: string): Promise<ExecutorPackage> {
    const pkg = await this.repo.findOne({ where: { id } });
    if (!pkg) {
      throw new NotFoundException(`Executor package ${id} not found`);
    }
    return pkg;
  }

  async update(
    id: string,
    updateDto: UpdateExecutorPackageDto,
  ): Promise<ExecutorPackage> {
    const pkg = await this.findOne(id);
    if (
      updateDto.name !== undefined ||
      updateDto.version !== undefined ||
      updateDto.type !== undefined
    ) {
      const conflict = await this.repo.findOne({
        where: {
          name: updateDto.name ?? pkg.name,
          version: updateDto.version ?? pkg.version,
          type: updateDto.type ?? pkg.type,
        },
      });
      if (conflict && conflict.id !== id) {
        throw new ConflictException(
          `Package ${updateDto.name ?? pkg.name}@${updateDto.version ?? pkg.version} already exists`,
        );
      }
    }
    Object.assign(pkg, updateDto);
    const saved = await this.repo.save(pkg);
    this.logger.log(
      `Updated executor package: ${saved.name}@${saved.version} [${saved.id}]`,
    );
    return saved;
  }

  /**
   * A-8（执行器域审计 P3）：push-result 回调的 pushHistory 持久化——**事务内
   * FOR UPDATE（pessimistic_write）重读最新行后再追加写回**。
   *
   * 旧链路（controller: findOne → 拼数组 → svc.update 整行 save）是典型的
   * 读改写竞态：一次广播 N 台执行器几乎同时回调，各自基于同一陈旧快照拼数组，
   * 整行 save 后写者把先写者的记录整条抹掉（丢历史）。锁内重读让每次追加都
   * 基于「含先到者记录」的最新行；上限 100 裁剪由纯函数 appendPushHistoryEntry
   * 承担（语义与旧行为逐字节等价）。
   *
   * 版本缺省回填 `version ?? pkg.version` 保留旧语义，但基于**锁内最新行**取值。
   * 包不存在 → NotFoundException（调用方 catch 后 warn，不阻断回调 ack）。
   */
  async appendPushHistory(
    packageId: string,
    report: {
      executorId?: string;
      status: "downloaded" | "failed";
      version?: string;
      error?: string;
    },
  ): Promise<void> {
    await this.repo.manager.transaction(async (em) => {
      const pkg = await em.findOne(ExecutorPackage, {
        where: { id: packageId },
        lock: { mode: "pessimistic_write" },
      });
      if (!pkg) {
        throw new NotFoundException(
          `Executor package ${packageId} not found`,
        );
      }
      pkg.pushHistory = appendPushHistoryEntry(pkg.pushHistory, {
        executorId: report.executorId ?? "unknown",
        status: report.status,
        version: report.version ?? pkg.version,
        ...(report.error ? { error: report.error } : {}),
        timestamp: new Date().toISOString(),
      });
      await em.save(pkg);
    });
  }

  async remove(id: string): Promise<void> {
    const pkg = await this.findOne(id);

    // DEEP-AUDIT B·3.2：顺序反转——**先删行、后删文件**。旧顺序（先 unlink 后
    // repo.remove）在 DB 删除失败时已经把包文件删了：行还在、文件没了，下载/
    // 推送全部报错，且行无法重删（remove 幂等的是 unlink 不是 DB）。反转后：
    //   · DB 失败 → 文件保留，接口把 DB 错误抛给调用方，行与文件状态一致，
    //     重试删除即可收敛（孤儿文件最多多留一轮）；
    //   · DB 成功后文件删除失败 → 仅记录 orphan 警告（行已不可见，磁盘孤儿
    //     不影响任何功能，可由运维清理；同 checksum 重传会直接覆盖同路径）。
    await this.repo.remove(pkg);
    this.logger.log(
      `Deleted executor package: ${pkg.name}@${pkg.version} [${id}]`,
    );

    // R9: async unlink (no sync IO on the request path); best-effort — a
    // failed deletion is logged and does not fail the request (the DB row is
    // already gone; the on-disk orphan is invisible to any listing).
    if (pkg.filePath && fs.existsSync(pkg.filePath)) {
      try {
        await fs.promises.unlink(pkg.filePath);
        this.logger.log(`Deleted file from disk: ${pkg.filePath}`);
      } catch (err) {
        this.logger.warn(
          `Orphaned package file could not be deleted ${pkg.filePath}: ${err}`,
        );
      }
    }
  }

  /**
   * Open the stored package file for streaming download (used by the
   * download endpoint). R9: replaces getFileBuffer — a 500 MB package is no
   * longer read into a single Buffer; the controller streams it through
   * stream.pipeline. Auth/404 semantics are unchanged (NotFoundException
   * when the row or the file is missing).
   */
  async openPackageFile(id: string): Promise<{
    stream: fs.ReadStream;
    fileSize: number;
    pkg: ExecutorPackage;
  }> {
    const pkg = await this.findOne(id);
    if (!pkg.filePath || !fs.existsSync(pkg.filePath)) {
      throw new NotFoundException(
        `File for ExecutorPackage ${id} not found on disk`,
      );
    }
    let fileSize = pkg.fileSize ?? 0;
    try {
      fileSize = (await fs.promises.stat(pkg.filePath)).size;
    } catch {
      // Row exists but stat failed — fall back to the recorded size.
    }
    // P1-2（ARCH-008）：existsSync/stat 之后、流 open 之前文件被删的竞态下，
    // ENOENT 不再是无监听 error → uncaughtException，降级为该次下载失败。
    return {
      stream: createResponseReadStream(pkg.filePath, this.logger),
      fileSize,
      pkg,
    };
  }

  /**
   * Return absolute path of the upload directory (for static file serving).
   */
  getUploadDir(): string {
    return UPLOAD_DIR;
  }

  /**
   * Push executor package to online executor nodes.
   * Notify each executor node to pull the latest package from admin-api and update itself.
   * When executorIds is empty, push to all online executors.
   *
   * Executor lifecycle audit（P2-8）：控制器 @ApiBody 承诺 "empty = push to all
   * **online** executors"，管理台按钮文案也是"推送到全部在线调度机"，但旧实现
   * 空名单时取的是**全部行（含离线）**，于是对离线机器产生一整片连接失败，
   * 且 0 台在线时仍会对整个离线机群发起推送。现在空名单严格只取 ONLINE 行；
   * 显式传入 executorIds 时不做状态过滤（操作者明确点名，连接失败会在结果里
   * 逐台呈现）。
   */
  async pushToExecutors(
    id: string,
    executorIds?: string[],
    executorRepo?: import("../executor/entities/executor.entity").Executor[],
    sharedToken?: string,
  ): Promise<ExecutorPushResult[]> {
    const pkg = await this.findOne(id);

    const all = executorRepo ?? [];
    const targets =
      executorIds && executorIds.length > 0
        ? all.filter((e) => executorIds.includes(e.id))
        : all.filter((e) => e.status === ExecutorStatus.ONLINE);

    if (targets.length === 0) {
      throw new Error("No target executors found for push");
    }

    // R-12（DEEP_REVIEW 0ef3bbe）: 改读映射节 app.adminApiUrl（此前裸读
    // configService.get("ADMIN_API_URL") 绕过配置中心）。
    const adminApiBaseUrl = this.configService
      .get<string>("app.adminApiUrl")
      ?.trim();
    if (!adminApiBaseUrl) {
      throw new ServiceUnavailableException(
        "ADMIN_API_URL is not configured; cannot push executor package",
      );
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(adminApiBaseUrl);
      if (
        !["http:", "https:"].includes(parsedUrl.protocol) ||
        parsedUrl.search ||
        parsedUrl.hash
      ) {
        throw new Error("Invalid base URL");
      }
    } catch {
      throw new ServiceUnavailableException(
        "ADMIN_API_URL must be an absolute HTTP(S) base URL without query or fragment",
      );
    }
    // ADMIN_API_URL follows install-cmd semantics; tolerate an existing /api suffix.
    const basePath = parsedUrl.pathname
      .replace(/\/+$/, "")
      .replace(/(?:\/api)+$/, "");
    parsedUrl.pathname = `${basePath}/api/executor-packages/${pkg.id}/download`;
    const downloadUrl = parsedUrl.toString();
    const results = await Promise.allSettled(
      targets.map(async (executor) => {
        // ARCH-33（ADR-016）：pull 执行器（NAT 内）走命令队列。逐台独立判定
        // ——混合机队里 push 执行器照旧走 HTTP，一台的失败不影响其余目标。
        //
        // 语义损失**如实声明**：push 能同步拿到执行器的 accepted 响应；pull
        // 只能确认「已入队」。逐台结果因此带 `queued: true`（而非 success），
        // 终态仍由既有 push-result 回调收敛。
        if (this.executorService) {
          const routed = await this.executorService.deliverControlCommand({
            executorId: executor.id,
            address: executor.address,
            type: "update-package",
            payload: {
              packageId: pkg.id,
              name: pkg.name,
              version: pkg.version,
              type: pkg.type,
              downloadUrl,
              checksum: pkg.checksum,
            },
          });
          if (routed.delivered === "pull") {
            this.logger.log(
              `Queued package ${pkg.name}@${pkg.version} for pull executor ${executor.address} (commandId=${routed.commandId})`,
            );
            return {
              executorId: executor.id,
              address: executor.address,
              status: "queued" as const,
              success: true,
              commandId: routed.commandId,
            };
          }
        }
        // A-7（执行器域审计 P3）：address 是执行器自报字段（register/heartbeat
        // 上报），可能带 ?/#——与 ExecutorService.getExecutorUrl 的
        // split(/[?#]/, 1) 清洗同款：否则拼出的 `${url}/api/update-package`
        // 会把 /api/update-package 整体吞进 query/fragment，请求打到目标主机
        // 的错误端点（getExecutorUrl 头注有实测案例）。
        const sanitizedAddress = executor.address.split(/[?#]/, 1)[0];
        const url = sanitizedAddress.startsWith("http")
          ? sanitizedAddress
          : `http://${sanitizedAddress}`;
        // F-3: push 出站与 dispatch 同策略过 SSRF 校验——被投毒的 address
        // （元数据/回环段）单独失败，不影响其余目标。
        // F-3 (SEC-NEW): pin to the validated IP (Host/SNI kept).
        const pinned = await assertAndPinExecutorUrl(url);
        const pinCfg = pinnedAxiosConfig(pinned);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (sharedToken) headers["Authorization"] = `Bearer ${sharedToken}`;
        // 原始 URL 原样拼路径（new URL 归一化会改字节形态）；pin 由 agent.lookup 完成。
        await axios.post(
          `${url}/api/update-package`,
          {
            packageId: pkg.id,
            name: pkg.name,
            version: pkg.version,
            type: pkg.type,
            downloadUrl,
            checksum: pkg.checksum,
          },
          {
            timeout: 30_000,
            headers,
            maxRedirects: 0, // R3 parity
            ...pinCfg,
          },
        );
        this.logger.log(
          `Pushed package ${pkg.name}@${pkg.version} to executor ${executor.address}`,
        );
        return {
          executorId: executor.id,
          address: executor.address,
          status: "success" as const,
          success: true,
        };
      }),
    );

    return results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : {
            executorId: targets[i].id,
            address: targets[i].address,
            status: "error" as const,
            success: false,
            error: (r.reason as Error)?.message ?? String(r.reason),
          },
    );
  }

  async deprecate(id: string): Promise<ExecutorPackage> {
    return this.update(id, { status: ExecutorPackageStatus.DEPRECATED });
  }

  async activate(id: string): Promise<ExecutorPackage> {
    return this.update(id, { status: ExecutorPackageStatus.ACTIVE });
  }

  /**
   * Find the latest ACTIVE package for the given type (and optional platform).
   *
   * DEEP-AUDIT B·3.1：「最新」按**语义化版本**取最大（compareDottedVersions，
   * 与执行器版本门禁 EXE-VER-1 同源），createdAt 仅作同版本/不可解析时的
   * 决胜。旧实现只按 createdAt DESC 取首行——管理员重传旧版本包、或乱序
   * 上传时，「最新安装包」会指向低版本，执行器装到旧包还自以为升级成功。
   */
  async findLatest(
    type: string,
    platform?: string,
  ): Promise<ExecutorPackage | null> {
    const qb = this.repo
      .createQueryBuilder("pkg")
      .where("pkg.status = :status", { status: ExecutorPackageStatus.ACTIVE })
      .andWhere("pkg.type = :type", { type })
      // createdAt DESC 仍是本查询的兜底序：同版本或版本不可解析（NaN）时，
      // 先见的行（更新创建）胜出——与旧实现口径兼容。
      .orderBy("pkg.createdAt", "DESC");
    if (platform) {
      qb.andWhere("pkg.platform = :platform", { platform });
    }
    const candidates = await qb.getMany();
    // 版本比较在内存做（候选 = ACTIVE 包，管理员上传产物，量级有限）：DB 侧
    // 语义化排序需按段拆分（split_part + 数值转换），可移植性差；且「解析
    // 失败回落 createdAt 序」这一规则在 SQL 里无法表达。
    let latest: ExecutorPackage | null = null;
    for (const pkg of candidates) {
      if (!latest) {
        latest = pkg;
        continue;
      }
      const cmp = compareDottedVersions(pkg.version, latest.version);
      // NaN（任一侧无法解析）→ 保持 latest（createdAt 序在前的行优先）；
      // cmp === 0（同版本）→ 同上，createdAt 决胜；cmp > 0 → 新版本胜出。
      if (!Number.isNaN(cmp) && cmp > 0) latest = pkg;
    }
    return latest;
  }
}
