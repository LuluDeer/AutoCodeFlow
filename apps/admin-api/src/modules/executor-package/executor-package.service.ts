import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
  OnModuleInit,
} from "@nestjs/common";import { InjectRepository } from "@nestjs/typeorm";
import { Repository, Like, FindOptionsWhere } from "typeorm";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import axios from "axios";
import { ConfigService } from "@nestjs/config";
import { assertSafeExecutorUrl } from "../../common/utils/safe-http.util";
import {
  ZipGuardError,
  assertZipFileSafe,
  resolveZipGuardLimits,
} from "../../common/utils/zip-guard.util";
import {
  ClamdUnavailableError,
  isFailedVerdict,
  scanBufferWithClamd,
} from "../../common/utils/clamd-scan.util";
import {
  ExecutorPackage,
  ExecutorPackageStatus,
} from "./executor-package.entity";
import {
  CreateExecutorPackageDto,
  UpdateExecutorPackageDto,
  QueryExecutorPackageDto,
} from "./dto/executor-package.dto";

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

@Injectable()
export class ExecutorPackageService implements OnModuleInit {
  private readonly logger = new Logger(ExecutorPackageService.name);

  constructor(
    @InjectRepository(ExecutorPackage)
    private readonly repo: Repository<ExecutorPackage>,
    private readonly configService: ConfigService,
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
      rs.on("data", (chunk: Buffer) => hash.update(chunk));
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
          assertZipFileSafe(tmpPath, resolveZipGuardLimits(this.configService.get("zipGuard")));
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
        const verdict = await scanBufferWithClamd(
          await fs.promises.readFile(tmpPath),
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

  async remove(id: string): Promise<void> {
    const pkg = await this.findOne(id);

    // R9: async unlink (no sync IO on the request path); best-effort — a
    // failed deletion is logged and does not block DB deletion.
    if (pkg.filePath && fs.existsSync(pkg.filePath)) {
      try {
        await fs.promises.unlink(pkg.filePath);
        this.logger.log(`Deleted file from disk: ${pkg.filePath}`);
      } catch (err) {
        this.logger.warn(`Failed to delete file ${pkg.filePath}: ${err}`);
      }
    }

    await this.repo.remove(pkg);
    this.logger.log(
      `Deleted executor package: ${pkg.name}@${pkg.version} [${id}]`,
    );
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
    return { stream: fs.createReadStream(pkg.filePath), fileSize, pkg };
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
   */
  async pushToExecutors(
    id: string,
    executorIds?: string[],
    executorRepo?: import("../executor/entities/executor.entity").Executor[],
    sharedToken?: string,
  ): Promise<
    { executorId: string; address: string; success: boolean; error?: string }[]
  > {
    const pkg = await this.findOne(id);

    const targets =
      executorIds && executorIds.length > 0
        ? (executorRepo ?? []).filter((e) => executorIds.includes(e.id))
        : (executorRepo ?? []);

    if (targets.length === 0) {
      throw new Error("No target executors found for push");
    }

    const adminApiBaseUrl = this.configService
      .get<string>("ADMIN_API_URL")
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
        const url = executor.address.startsWith("http")
          ? executor.address
          : `http://${executor.address}`;
        // F-3: push 出站与 dispatch 同策略过 SSRF 校验——被投毒的 address
        // （元数据/回环段）单独失败，不影响其余目标。
        await assertSafeExecutorUrl(url);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (sharedToken) headers["Authorization"] = `Bearer ${sharedToken}`;
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
          { timeout: 30_000, headers },
        );
        this.logger.log(
          `Pushed package ${pkg.name}@${pkg.version} to executor ${executor.address}`,
        );
        return {
          executorId: executor.id,
          address: executor.address,
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
   * Find the latest ACTIVE package for the given type (and optional platform), ordered by creation time desc.
   */
  async findLatest(
    type: string,
    platform?: string,
  ): Promise<ExecutorPackage | null> {
    const qb = this.repo
      .createQueryBuilder("pkg")
      .where("pkg.status = :status", { status: ExecutorPackageStatus.ACTIVE })
      .andWhere("pkg.type = :type", { type })
      .orderBy("pkg.createdAt", "DESC");
    if (platform) {
      qb.andWhere("pkg.platform = :platform", { platform });
    }
    return qb.getOne();
  }
}
