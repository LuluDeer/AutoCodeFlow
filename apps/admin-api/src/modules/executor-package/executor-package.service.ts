import { Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染）。AppError 按状态码挂到对应内置异常原型上，故既有按异常类
// 断言的 spec 不受影响。
import { AppError } from "../../common/errors/app-error";
import { InjectRepository } from "@nestjs/typeorm";
import {
  Repository,
  Like,
  FindOptionsWhere,
  SelectQueryBuilder,
} from "typeorm";
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
// §2.1 keyset 游标：`executor_packages.id` 是 uuid，故用 uuid 版解码/编码器
// （审计端点用的是整型版——两张表主键类型不同，判据不能混用）。
import {
  decodeKeysetCursor,
  nextKeysetCursor,
} from "../../common/utils/keyset-cursor.util";

/** Upload directory for executor package files (relative to process working directory) */
const UPLOAD_DIR = path.join(process.cwd(), "uploads", "executor-packages");

/**
 * P2-2（2026-10-25 审计）：filePath 包含性判定（纵深防御共用判据）。
 *
 * `UpdateExecutorPackageDto.filePath` 只是 @MaxLength(1024) 的自由字符串——
 * PATCH 直接把它写进行，而 openPackageFile/remove 对该列做
 * createReadStream/unlink：不校验包含性时，PATCH 指向 /etc/passwd 等任意
 * 绝对路径即获得「读任意文件」（下载流）与「删任意文件」（unlink）原语。
 * 对照 sop-media.service.openStream 的 root 包含断言先例：path.resolve 后
 * 必须仍位于 UPLOAD_DIR 内（绝对路径输入会被 resolve 直接采纳，天然落败；
 * 逐字节前缀比较补 path.sep 防 `…executor-packages-evil` 这类兄弟目录绕过）。
 * 导出为纯函数（单测锚点，同 appendPushHistoryEntry 先例）。
 */
export function isPathInsideUploadRoot(filePath: string): boolean {
  const root = path.resolve(UPLOAD_DIR);
  const abs = path.resolve(root, filePath);
  return abs.startsWith(root + path.sep);
}

/** P3-3：PG 唯一约束冲突（23505）判定——TypeORM 的 driverError 包装形态同样命中。 */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } } | null;
  return e?.code === "23505" || e?.driverError?.code === "23505";
}

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

/**
 * R60-A1（ADR-026 规则 4）：`update()` **真正拥有**的列 —— 正向白名单。
 *
 * 为什么是白名单而不是"整行 save 后 delete 几列"：黑名单只拦今天想得起来的列，
 * 明天给 `executor_packages` 加一列（迁移加列是常态）就自动从"不写"变成"按
 * 陈旧快照写回"，腐化是静默的。白名单下新列默认**不属于** PATCH 的写面，
 * 想写它必须先显式加进来并说明依据。
 *
 * 清单 = `UpdateExecutorPackageDto` 的全部字段（name/version/type/platform/
 * description/checksum/filePath/fileSize/status）：管理台 PATCH 的语义就是
 * "把这几个元数据列改成我给的值"。**刻意不含**：
 *   · `pushHistory` —— 唯一写者是 `appendPushHistory()`（事务 + FOR UPDATE，
 *     追加语义）。PATCH 拿着旧快照覆盖它 = 回滚并发 push-result 回调的记录；
 *   · `projectId` —— 归属变更走独立路径（AUTH-01 多租户），不属于包元数据编辑；
 *   · `id` / `uploadedBy` / `createdAt` / `updatedAt` —— 服务端/DB 所有。
 */
const PACKAGE_UPDATE_OWNED_COLUMNS = [
  "name",
  "version",
  "type",
  "platform",
  "description",
  "checksum",
  "filePath",
  "fileSize",
  "status",
] as const;

/** update() 白名单列名（逐列依据见 PACKAGE_UPDATE_OWNED_COLUMNS）。 */
type PackageUpdateOwnedColumn = (typeof PACKAGE_UPDATE_OWNED_COLUMNS)[number];

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
      throw new AppError("EXECUTOR_PACKAGE_FILE_REQUIRED");
    }
    const tmpPath = file.path;
    if (!tmpPath) {
      throw new AppError("EXECUTOR_PACKAGE_UPLOAD_CONTENT_MISSING");
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
        throw new AppError("EXECUTOR_PACKAGE_EXISTS", {
          name: createDto.name,
          version: createDto.version,
          type: createDto.type,
        });
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
        throw new AppError("EXECUTOR_PACKAGE_EXT_UNSUPPORTED", {
          ext: effectiveExt || "(none)",
        });
      }
      const head = await this.readHeadBytes(tmpPath, 2);
      const isArchive =
        (head[0] === 0x50 && head[1] === 0x4b) ||
        (head[0] === 0x1f && head[1] === 0x8b);
      if (!isArchive) {
        throw new AppError("EXECUTOR_PACKAGE_NOT_ARCHIVE");
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
            // `err.violation` 是机器标识符枚举（ZipGuardViolation）——原样作为
            // **参数**下发，绝不翻译（直连守卫判据，见 zip-guard.util 头注）。
            throw new AppError("EXECUTOR_PACKAGE_ZIP_GUARD_REJECTED", {
              violation: err.violation,
            });
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
            throw new AppError("EXECUTOR_PACKAGE_VIRUS_DETECTED");
          }
          this.logger.warn(
            `Executor package upload rejected: clamd unavailable (${verdict.reason}): ${verdict.detail}`,
          );
          throw new AppError("EXECUTOR_PACKAGE_SCANNER_UNAVAILABLE");
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
        // R60-A1 分类：**创建/插入路径**（保留整行 save）。pkg 由上面的
        // `this.repo.create({...})` 就地构造、没有既有主键 ⇒ save 等价 INSERT，
        // 快照里不存在"别人的列"，没有可被覆盖的并发事实。
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
        // P3-3（TOCTOU 兜底）：同名 (name, version, type) 的预检 findOne 与
        // INSERT 之间存在并发窗口——唯一索引 uq（@Index unique 三列）是真正的
        // 收口，输家把 PG 23505 映射成与预检**同一个** 409 EXECUTOR_PACKAGE_EXISTS
        // （对照 users.service R32-A5 / deploy 在途唯一冲突的分流先例），
        // 不再冒裸 500。
        if (isUniqueViolation(err)) {
          throw new AppError("EXECUTOR_PACKAGE_EXISTS", {
            name: createDto.name,
            version: createDto.version,
            type: createDto.type,
          });
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

  /**
   * `GET /executor-packages` 列表。
   *
   * ## 响应形状：保持裸 `{items,total}`，只**加性**追加可选 `nextCursor`
   *
   * 本方法**不是** `paginate()` 信封（无 list/page/pageSize/totalPages），且形状
   * 有真实外部消费方，已逐一核实：
   *   · `apps/admin-web/src/api/executor-packages.ts` 的 `list()`
   *     返回类型写死 `{ items, total }`，`ExecutorPackagesPage` 的 load() 读
   *     `res.items` / `res.total`（分页条 `total`、`showTotal` 计数）；
   *   · 同文件的 `listLatest()` 读 `res.items`（安装向导页取「最新可用包」）。
   * 改成 `paginate()` 信封会一次性打断这两处（`res.items` 变 undefined →
   * 包表恒空、安装向导取不到任何包），属于**破坏性**变更，超出本轮「加性」纪律。
   * 故这里只追加一个可选键：
   *   · 不带 `cursor` → 走原有 `findAndCount`，响应**逐字节不变**（连
   *     `nextCursor` 这个键都不出现，`JSON.stringify` 会把 undefined 整个丢掉）；
   *   · 带 `cursor` → keyset 分支，追加 `nextCursor`（字符串 = 下一页，
   *     `null` = 末页）。
   */
  async findAll(query: QueryExecutorPackageDto): Promise<{
    items: ExecutorPackage[];
    total: number;
    nextCursor?: string | null;
  }> {
    // §2.1（推广到 GET /executor-packages）：不带 cursor 时下面一行都不执行，
    // 旧路径**逐字节不变**（仍走 findAndCount + 同一组 find 选项）。
    if (query.cursor !== undefined && query.cursor !== null) {
      return this.findAllByKeyset(query, query.cursor);
    }

    const { page = 1, pageSize = 20, name, type, status, platform } = query;
    const where: FindOptionsWhere<ExecutorPackage> = {};
    if (name) where.name = Like(`%${name}%`);
    if (type) where.type = type;
    if (status) where.status = status;
    if (platform) where.platform = platform;

    const [items, total] = await this.repo.findAndCount({
      where,
      // A-8 推广（本轮深审）：`createdAt` 非唯一——同一事务批量上传/并发上传
      // 的多行会拿到**完全相同**的 timestamp(6) 值（真实库实测该列为
      // `timestamp without time zone`，precision 6，与 task_executions 同款）。
      // 单键排序在这种并列上的相对顺序由 PG 的执行计划决定、**不保证稳定**：
      // 跨页翻页时同一行可能在第 1 页和第 2 页各出现一次，另一行则彻底消失。
      // 这是**独立于游标分页的真实缺陷**——OFFSET 分页同样会漏行/重行。
      //
      // 补 `id` 决胜键后构成确定性全序 (createdAt DESC, id DESC)，翻页稳定。
      // 与 audit.service（A-8 原处）/ task.service（FIX-5.3）同一纪律。
      //
      // 顺序保证：TypeORM 的 find 选项按对象键插入顺序生成 ORDER BY，故
      // createdAt 仍是主排序键，id 只在其后决胜——既有"按时间倒序"语义不变。
      order: { createdAt: "DESC", id: "DESC" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total };
  }

  /**
   * §2.1（推广到 `GET /executor-packages`）keyset 分支：`(createdAt, id)` 行值
   * 比较翻页。语义与 task 域三个端点、审计端点**逐条一致**。
   *
   * ## 为什么这里必须用 QueryBuilder（不能用 findAndCount）
   *
   * 游标谓词是**行值比较 + 子查询**：
   *
   *     ("createdAt", id) < (SELECT c."createdAt", c.id FROM executor_packages c
   *                          WHERE c.id = :cursorId)
   *
   * `find`/`findAndCount` 的 FindOptions 表达不了"与另一行的元组比较"（它只
   * 支持 `LessThan(常量)`），故 keyset 分支走 QueryBuilder。**OFFSET 分支保持
   * `findAndCount` 原样**——那是旧路径逐字节不变的一部分，不要顺手统一。
   *
   * ## 精度
   *
   * 实测（真 PG `information_schema`）：
   *   executor_packages."createdAt"  timestamp without time zone, precision 6
   *   executor_packages.id           uuid（`uuid_generate_v4()`，不是整型）
   * 时间列与 `task_executions."createdAt"` 逐字段相同 ⇒ 微秒打平会漏行的论证
   * 对本表同样成立，故必须用行值比较，**不能**用毫秒半开区间。id 是 uuid，故
   * 用 `decodeKeysetCursor` / `nextKeysetCursor`（与审计端点的整型版区分开）。
   *
   * ## 过滤器
   *
   * `name`（模糊）/`type`/`status`/`platform` 与游标条件是 AND 关系，可任意组合。
   * 它们由 `applyPackageFilters` 装配，与 OFFSET 分支**共用同一份**（否则"两条
   * 路径过滤集漂移"会静默改变结果集）。
   */
  private async findAllByKeyset(
    query: QueryExecutorPackageDto,
    rawCursor: string,
  ): Promise<{
    items: ExecutorPackage[];
    total: number;
    nextCursor: string | null;
  }> {
    // 空串 = 调用方显式声明的 keyset 起点；非空则必须是合法游标，否则 400 ——
    // 绝不降级到 OFFSET 分支（那会造成"带着坏游标反复拿回第 1 页"的死循环）。
    const cursor = rawCursor === "" ? null : decodeKeysetCursor(rawCursor);
    const pageSize = query.pageSize ?? 20;

    const qb = this.repo
      .createQueryBuilder("p")
      // 排序键与游标元组必须同源（createdAt DESC, id DESC），否则"继续"的
      // 起点与结果集排序不符，翻页会漏/重。
      .orderBy("p.createdAt", "DESC")
      .addOrderBy("p.id", "DESC");

    this.applyPackageFilters(qb, query);

    if (cursor) {
      // 行值比较；游标那一行的精确 (createdAt, id) 由子查询按主键取库内原值
      // （含微秒）——DB 值比 DB 值，JS 的毫秒截断不参与运算，零精度损失。
      //
      // 游标行被并发删除（管理员刚删了该包）：子查询无行 → 比较得 NULL →
      // WHERE 为假 → 本页为空，调用方看到 `nextCursor: null` 即视为翻完。
      // 这是**安全地提前结束**，不会错行/重复。
      qb.andWhere(
        `(p."createdAt", p.id) < (
           SELECT c."createdAt", c.id FROM executor_packages c WHERE c.id = :cursorId
         )`,
        { cursorId: cursor.id },
      );
    }

    // 多取一行：用"有没有第 N+1 行"判断 hasMore，避免额外的 exists 查询。
    qb.take(pageSize + 1);

    // total 用独立的 COUNT（同过滤条件、**不含**游标下界）——与 OFFSET 分支
    // findAndCount 的 total 语义一致：真实总数，不是"剩余条数"、也不是 -1。
    // 顺序执行（不 Promise.all 同一个 qb）：getCount 会改 expressionMap.queryEntity。
    const rows = await qb.getMany();
    const total = await qb.getCount();

    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;
    return {
      items,
      total,
      // 还有下一页 → 用本页最后一行编游标；否则显式 null（末页标记）。
      // `null` 与"键不出现"是两种不同语义：keyset 分支的末页必须**出现**该键。
      nextCursor: hasMore ? nextKeysetCursor(items) : null,
    };
  }

  /**
   * 执行器包列表过滤条件的**唯一真值源**（OFFSET / keyset 两条路径共用）。
   *
   * 改造前过滤条件内联在 `findAll` 的 `FindOptionsWhere` 里；keyset 分支改用
   * QueryBuilder 后若照抄一遍，就成了两份判据——`name` 的模糊匹配方式（是否
   * 转义 LIKE 元字符、是否大小写敏感）在两个分支各写一次，改一处忘另一处会
   * 让"翻下一页"与"第 1 页"返回**不同的行集**，且两边都不报错。故收口于此。
   *
   * 语义刻意与改造前的 FindOptions 逐条对齐（不是"顺手改进"）：
   *   · `name` 用 `Like('%…%')`——**不**转义 LIKE 元字符。改造前就是如此，
   *     改它会改变既有 `?name=a_b` 的匹配结果（属于行为变更，不在本轮范围）；
   *   · `type` / `status` / `platform` 都是精确等值。
   */
  private applyPackageFilters(
    qb: SelectQueryBuilder<ExecutorPackage>,
    query: QueryExecutorPackageDto,
  ): void {
    const { name, type, status, platform } = query;
    // 绑定参数写法与 FindOptions 生成的 SQL 语义一致（`ILIKE`/`LIKE` 取决于
    // 列的 collation；TypeORM 的 Like() 生成 `LIKE`，这里同样用 `LIKE`）。
    if (name) qb.andWhere("p.name LIKE :name", { name: `%${name}%` });
    if (type) qb.andWhere("p.type = :type", { type });
    if (status) qb.andWhere("p.status = :status", { status });
    if (platform) qb.andWhere("p.platform = :platform", { platform });
  }

  async findOne(id: string): Promise<ExecutorPackage> {
    const pkg = await this.repo.findOne({ where: { id } });
    if (!pkg) {
      throw new AppError("EXECUTOR_PACKAGE_NOT_FOUND");
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
        throw new AppError("EXECUTOR_PACKAGE_EXISTS", {
          name: updateDto.name ?? pkg.name,
          version: updateDto.version ?? pkg.version,
          type: updateDto.type ?? pkg.type,
        });
      }
    }
    // P2-2（纵深第一层）：PATCH filePath 的包含性闸——resolve 后必须仍在
    // UPLOAD_DIR 内，否则 400（VALIDATION 形态，同 EXT_UNSUPPORTED/NOT_ARCHIVE
    // 一族）。null（可空列清空）不拦——它不落新路径，也不构成读/删原语。
    if (typeof updateDto.filePath === "string") {
      if (!isPathInsideUploadRoot(updateDto.filePath)) {
        throw new AppError("EXECUTOR_PACKAGE_STORAGE_PATH_ESCAPED", {
          filePath: updateDto.filePath,
        });
      }
    }
    // R60-A1（ADR-026 规则 4）：这里此前是「findOne 快照 → Object.assign(updateDto)
    // → 整行 save()」。TypeORM 的 save 对既有主键走 UPDATE，且按「读当前行 → 列 diff」
    // 只写**与当前行不同**的列——于是快照里**过期的** pushHistory 与当前行不等，
    // 被判成"改动"写回，把并发 push-result 回调（appendPushHistory，事务内 FOR
    // UPDATE）刚追加的记录整列回滚。本方法语义上只拥有白名单里的元数据列，
    // 故改成「白名单 ∩ 调用方显式提供」的列级 patch（与 executor.service.update
    // 的 R51-A1 同款）。
    const patch = this.pickUpdateColumns(updateDto);
    if (Object.keys(patch).length === 0) {
      // 空 patch：不发写请求。旧的整行 save 在这里会发一条 no-op UPDATE，
      // 那同样是一个「读快照 → 写回」的可交错窗口。
      return pkg;
    }
    // 内存对象同步一份：返回值（controller 回包）与既有调用方语义不变。
    Object.assign(pkg, patch);
    // 为什么这里**不该**加 CAS：写面只有 PACKAGE_UPDATE_OWNED_COLUMNS ∩ 调用方显式提供
    // 的列（patch 里没有 pushHistory/projectId/凭据/计数列）；status 携带的是管理台
    // 「启用/弃用」的**绝对目标值**（不是"读到的旧值"），last-writer-wins 即正确语义
    // ——加 CAS 会让两个管理员并发开关包、或 PATCH 撞上并发的 deprecate() 时凭空 409，
    // 而这些列不承载任何依赖「读取时刻状态」的生命周期不变量（对比 ADR-026 要治的
    // tokenHash/isActive 类：那是"用旧值复活一个已被别人撤销的事实"，这里不存在）。
    // adr-026-exempt: 列级 patch（白名单 ∩ 显式提供），状态列是绝对目标值、LWMW 即正确语义。
    await this.repo.update({ id: pkg.id }, patch);
    this.logger.log(
      `Updated executor package: ${pkg.name}@${pkg.version} [${pkg.id}]`,
    );
    return pkg;
  }

  /**
   * R60-A1：把 `UpdateExecutorPackageDto` 收窄成「白名单 ∩ 显式提供」的列 patch。
   *
   * 两重保险缺一不可：
   *   · 白名单 —— DTO 的内联类型只是编译期的，运行时 `@Body()` 对象可以带任意
   *     属性（`pushHistory` / `id` / `projectId`）；不裁剪就等于把"客户端能写
   *     哪些列"交给客户端决定。
   *   · `!== undefined` —— 与 TypeORM save 的 undefined 语义对齐（未提供 = 不动
   *     该列）。`null` 仍然写入（可空列的"清空"是显式意图）。
   */
  private pickUpdateColumns(
    updateDto: UpdateExecutorPackageDto,
  ): Partial<Pick<ExecutorPackage, PackageUpdateOwnedColumn>> {
    const source = updateDto as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const column of PACKAGE_UPDATE_OWNED_COLUMNS) {
      if (source[column] !== undefined) patch[column] = source[column];
    }
    return patch as Partial<Pick<ExecutorPackage, PackageUpdateOwnedColumn>>;
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
        throw new AppError("EXECUTOR_PACKAGE_NOT_FOUND");
      }
      pkg.pushHistory = appendPushHistoryEntry(pkg.pushHistory, {
        executorId: report.executorId ?? "unknown",
        status: report.status,
        version: report.version ?? pkg.version,
        ...(report.error ? { error: report.error } : {}),
        timestamp: new Date().toISOString(),
      });
      // R60-A1 分类：**锁内整行回写**（保留）。pkg 是上面 `pessimistic_write`
      // 事务内重读的**最新行**，行锁持有到 commit ⇒ 并发写者要么在本事务前提交
      // （本行已读到其值），要么阻塞到本事务结束——不存在"读后写前"的陈旧窗口。
      // 不改成列 patch 的理由：pushHistory 是**整列覆盖**语义（追加在内存完成），
      // 且本方法（连同其上方锁）是该列的唯一写者。
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
      // P2-2（纵深第二层）：落盘 unlink 前二次断言包含性——DB 里的历史脏行
      // 或绕过 update 闸的写入面不能把删除变成任意文件删除原语。行已删，
      // 越界文件不删只告警（不因路径越界阻断删行——删除本身是合法管理动作，
      // 磁盘孤儿可由运维清理，同上方 orphan 语义）。
      if (!isPathInsideUploadRoot(pkg.filePath)) {
        this.logger.warn(
          `Refusing to unlink ${pkg.filePath} for package ${id}: path is outside the upload root`,
        );
      } else {
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
    // P2-2（纵深第二层）：落盘读之前二次断言包含性（update 闸是第一层）。
    // DB 里的历史脏行或绕过 update 的写入面不能把下载流变成任意文件读取原语
    // （对照 sop-media.service.openStream 的 root 包含断言先例）。
    if (pkg.filePath && !isPathInsideUploadRoot(pkg.filePath)) {
      throw new AppError("EXECUTOR_PACKAGE_STORAGE_PATH_ESCAPED", {
        packageId: id,
      });
    }
    if (!pkg.filePath || !fs.existsSync(pkg.filePath)) {
      throw new AppError("EXECUTOR_PACKAGE_FILE_MISSING", {
        packageId: id,
      });
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
      throw new AppError("EXECUTOR_PACKAGE_PUSH_NO_TARGETS");
    }

    // R-12（DEEP_REVIEW 0ef3bbe）: 改读映射节 app.adminApiUrl（此前裸读
    // configService.get("ADMIN_API_URL") 绕过配置中心）。
    const adminApiBaseUrl = this.configService
      .get<string>("app.adminApiUrl")
      ?.trim();
    if (!adminApiBaseUrl) {
      throw new AppError("EXECUTOR_PACKAGE_PUSH_URL_NOT_CONFIGURED");
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(adminApiBaseUrl);
      if (
        !["http:", "https:"].includes(parsedUrl.protocol) ||
        parsedUrl.search ||
        parsedUrl.hash
      ) {
        throw new Error("基础 URL 无效");
      }
    } catch {
      throw new AppError("EXECUTOR_PACKAGE_PUSH_URL_INVALID");
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
          if (routed.delivered === "unresolved") {
            // 行在本次调用前已被删除（列表快照 → 推送之间的窗口）。按失败返回，
            // 绝不对陈旧地址发 HTTP（与部署面同策，见 resolveExecutorTransport）。
            return {
              executorId: executor.id,
              address: executor.address,
              status: "error" as const,
              success: false,
              error:
                "Executor record no longer exists (deleted or auto-cleaned) — package not pushed",
            };
          }
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
