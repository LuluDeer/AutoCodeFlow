import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { isUUID } from "class-validator";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  TaskExecution,
  ExecutionArtifact,
} from "../task/entities/task-execution.entity";
// ARTIFACTS-INDEX-46: 产物元数据索引表（GET /artifacts 查询面）。
import { ExecutionArtifactRow } from "./entities/execution-artifact.entity";
// 分页信封（仓库惯例：paginate + PageQueryDto，见 pagination.dto 头注）。
import { paginate } from "../../common/dto/pagination.dto";
import { SystemConfigService } from "../config/config.service";
import { ExecutorService } from "../executor/executor.service";
import { verifyExecutorToken } from "../../common/utils/verify-executor-token.util";
import { createResponseReadStream } from "../../common/utils/response-stream.util";
// LANG-ERR-01: 用户可见报错改为稳定错误码（文案由前端按用户语言渲染）。
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import {
  getArtifactRootDir,
  isArtifactPathWithin,
  MAX_ARTIFACT_COUNT,
  MAX_ARTIFACT_SIZE_BYTES,
  SAFE_ARTIFACT_NAME_RE,
} from "./artifacts.constants";

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".xml": "application/xml",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

@Injectable()
export class ArtifactsService {
  private readonly logger = new Logger(ArtifactsService.name);

  constructor(
    @InjectRepository(TaskExecution)
    private readonly execRepo: Repository<TaskExecution>,
    // ARTIFACTS-INDEX-46: 索引表读侧（GET /artifacts）。@Optional——既有单测
    // 装配未提供时回退 null，listArtifactRows 抛 501 风格降级（见方法注释）。
    @Optional()
    @InjectRepository(ExecutionArtifactRow)
    private readonly artifactIndexRepo: Repository<ExecutionArtifactRow> | null,
    private readonly configService: ConfigService,
    private readonly systemConfigService: SystemConfigService,
    private readonly executorService: ExecutorService,
  ) {}

  /**
   * 解析并守卫 `<ARTIFACT_ROOT_DIR>/<execId>/<name>`：
   *  - execId 必须是 UUID；name 必须匹配裸文件名安全字符集（无路径分隔符 / 前导点）；
   *  - path.basename(name) === name 且拼接结果仍在 execId 目录内（纵深防御路径穿越）。
   * 任一不满足抛 BadRequest（400），绝不落到磁盘。
   */
  resolveArtifactPath(execId: string, name: string): string {
    if (!isUUID(execId)) {
      throw new AppError(ErrorCode.ARTIFACT_EXECUTION_ID_INVALID);
    }
    if (!SAFE_ARTIFACT_NAME_RE.test(name) || path.basename(name) !== name) {
      throw new AppError(ErrorCode.ARTIFACT_NAME_INVALID);
    }
    const base = path.join(getArtifactRootDir(), execId);
    // 纵深防御判定抽成纯函数（isArtifactPathWithin，见 artifacts.constants.ts）——
    // 原实现里那一项 `full !== path.join(base, name)` **恒为假**（同一个表达式），
    // 是"看起来在防、其实永不触发"的死守卫；抽出来后可以直接对 `..` / `.`
    // 这类畸形名做单测，不必依赖上面那条正则是否被放宽。
    if (!isArtifactPathWithin(base, name)) {
      throw new AppError(ErrorCode.ARTIFACT_PATH_INVALID);
    }
    return path.join(base, name);
  }

  /** 目录内文件数上限预检（上传前）。 */
  private assertWithinCountCap(execId: string): void {
    const dir = path.join(getArtifactRootDir(), execId);
    try {
      if (fs.existsSync(dir)) {
        const n = fs.readdirSync(dir).length;
        if (n >= MAX_ARTIFACT_COUNT) {
          throw new AppError(ErrorCode.ARTIFACT_COUNT_LIMIT_REACHED, {
            max: MAX_ARTIFACT_COUNT,
          });
        }
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      // readdir 失败（竞态删除等）——不阻断，落盘阶段自然处理。
    }
  }

  /**
   * 落盘一个产物文件（buffer 已在内存，multer memoryStorage 已限 100MB）。
   * 若提供 declaredSha256 且与实际不符 → BadRequest（完整性核对，防清单/文件错配）。
   * 原子写：先写 `<name>.tmp-<rand>` 再 rename。返回清单条目 {name,size,sha256}。
   */
  async saveArtifact(
    execId: string,
    name: string,
    buf: Buffer,
    declaredSha256?: string,
  ): Promise<ExecutionArtifact> {
    const full = this.resolveArtifactPath(execId, name);
    if (buf.length > MAX_ARTIFACT_SIZE_BYTES) {
      throw new AppError(ErrorCode.ARTIFACT_TOO_LARGE);
    }
    this.assertWithinCountCap(execId);

    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    if (declaredSha256 && declaredSha256.toLowerCase() !== sha256) {
      throw new AppError(ErrorCode.ARTIFACT_SHA256_MISMATCH);
    }

    const dir = path.dirname(full);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.${name}.tmp-${crypto.randomBytes(6).toString("hex")}`,
    );
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, full);
    this.logger.log(
      `FEAT-05: stored artifact ${execId}/${name} (${buf.length} bytes, sha256=${sha256.slice(0, 12)}…)`,
    );
    return { name, size: buf.length, sha256 };
  }

  /** 流式计算文件 sha256（不整文件入内存）。 */
  private hashFile(full: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const input = fs.createReadStream(full);
      input.on("error", reject);
      input.on("data", (chunk) => hash.update(chunk));
      input.on("end", () => resolve(hash.digest("hex")));
    });
  }

  /** 打开产物用于流式下载。缺文件 → NotFound。
   *  E-P2-P6：同时计算实际字节 sha256 返回，由下载路由写入 X-SHA256 响应头，
   *  供安装/消费侧解压前做完整性核对。 */
  async openArtifact(
    execId: string,
    name: string,
  ): Promise<{
    stream: fs.ReadStream;
    fileSize: number;
    contentType: string;
    sha256: string;
  }> {
    const full = this.resolveArtifactPath(execId, name);
    if (!fs.existsSync(full)) {
      throw new AppError(ErrorCode.ARTIFACT_NOT_FOUND);
    }
    const fileSize = fs.statSync(full).size;
    const ext = path.extname(name).toLowerCase();
    const sha256 = await this.hashFile(full);
    // P1-2（ARCH-008）：existsSync/statSync 之后、流 open 之前文件被删的竞态下，
    // ENOENT 降级为该次下载失败（warn + destroy），不再无监听 error 冒泡。
    return {
      stream: createResponseReadStream(full, this.logger),
      fileSize,
      contentType: CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream",
      sha256,
    };
  }

  /** 读取执行行的产物清单（供列表端点）。 */
  async getManifest(execId: string): Promise<ExecutionArtifact[]> {
    if (!isUUID(execId))
      throw new AppError(ErrorCode.ARTIFACT_EXECUTION_ID_INVALID);
    const exec = await this.execRepo.findOne({ where: { id: execId } });
    if (!exec) throw new AppError(ErrorCode.TASK_EXECUTION_NOT_FOUND);
    return exec.artifacts ?? [];
  }

  /**
   * ARTIFACTS-INDEX-46（部署模型评审 §4.6）：按应用/任务维度索引查询产物
   * （GET /artifacts?applicationId=&taskId=&page=），读 execution_artifacts
   * 新表——jsonb 清单「全表扫执行行再解数组」不可查询的痛点由本面承接。
   *
   * ## 过渡期语义（如实返回空，刻意不回落）
   *
   * 本表自迁移 1790000000065 起、随终态回调双轨写积累；**存量执行**（迁移前
   * 终态化、清单只在 jsonb 里）没有新表行——本端点对它们**如实返回空**，不做
   * jsonb 回落（回落=全表扫解数组，正是本索引要消灭的形态；且存量行的
   * applicationId 需按任务快照回溯猜测，与 1790000000055/0061「不猜映射」
   * 先例冲突）。按执行的既有清单端点 GET /tasks/executions/:execId/artifacts
   * 继续读 jsonb，存量执行在该面完整可见——两面各答各的问题，不重叠。
   *
   * @param query 过滤：applicationId / taskId（均可选，都不传=全量分页）+ 分页。
   * @returns paginate() 信封（仓库惯例 6 键：list/items/total/page/pageSize/totalPages）。
   */
  async listArtifactRows(query: {
    applicationId?: string;
    taskId?: string;
    page: number;
    pageSize: number;
  }) {
    // 参数校验与仓库惯例对齐：非 UUID 形状的过滤值 400（VALIDATION_FAILED，
    // 与 keyset-cursor invalidKeysetCursor 同款判据强度——宁可 400 也不带病查询）。
    if (query.applicationId !== undefined && !isUUID(query.applicationId)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: "applicationId 必须是 UUID",
      });
    }
    if (query.taskId !== undefined && !isUUID(query.taskId)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: "taskId 必须是 UUID",
      });
    }
    if (!this.artifactIndexRepo) {
      // 单测装配降级（生产 ArtifactsModule 恒提供）——诚实报错优于静默空列表。
      throw new AppError(ErrorCode.INTERNAL_ERROR, {
        detail: "execution_artifacts repository not available",
      });
    }
    const where: { applicationId?: string; taskId?: string } = {};
    if (query.applicationId) where.applicationId = query.applicationId;
    if (query.taskId) where.taskId = query.taskId;

    const [rows, total] = await this.artifactIndexRepo.findAndCount({
      where,
      order: { createdAt: "DESC", id: "DESC" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    });
    return paginate(rows, total, query.page, query.pageSize);
  }

  /**
   * SEC-1 迁移开关：`EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN`（默认 **false**）。
   *
   * 为什么需要它：共享令牌是**全机队单一密钥**、不携带"我是哪台执行器"的身份，
   * 默认必须拒绝它授权产物上传（见 verifyUploadAuth 头注）；但它确实还在极老 /
   * 手工配置的部署里承担上传凭据，故留一个**显式、默认关闭、每次放行都记 warn**
   * 的过渡开关，而不是让升级方直接黑屏。
   *
   * 走 `ConfigService`（本仓惯例：运行时读配置不直读 `process.env`，ARCH-27）。
   * 该键未在 `configuration.ts` 注册，`ConfigService` 会按 Nest 的 process.env
   * 兜底读取同名环境变量（与本仓 `LOG_PARTITION_ENABLED` / `LOG_RETENTION_DAYS`
   * 同款用法），因此运维置环境变量即可生效，无需改代码。
   */
  private sharedTokenUploadAllowed(): boolean {
    const raw = this.configService.get<string | boolean>(
      "EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN",
    );
    if (raw === true) return true;
    return typeof raw === "string" && raw.trim().toLowerCase() === "true";
  }

  /**
   * 校验产物上传凭据（机器对机器）。
   *
   * ## SEC-1：共享令牌不得授权产物上传（默认，破坏性修复）
   *
   * 旧实现的顺序是「先试共享令牌，命中即 `return exec`」，而 `exec` 只按**路径
   * 参数**查出。共享令牌是全机队单一密钥、**不携带任何执行器身份**，于是持它者
   * 只需知道 execId（UUID，出现在回调载荷 / 管理台 URL / 日志里）就能：
   *   · 往**别人执行**的产物目录写入任意文件（产物可下载、可被部署消费 ⇒
   *     等于替换他人交付物）；
   *   · 用 `MAX_ARTIFACT_COUNT` 把别人的产物目录灌满，让合法执行器后续上传失败。
   * 同体系的 `execution-callback.controller` 早已明令「共享令牌不得跨执行器确认
   * 回调」，产物上传是当时漏掉的那处——这里补齐。
   *
   * 影响面已核实：node / python 执行器上传走的都是 `getCurrentToken()` 的
   * per-executor 动态令牌（见 `apps/executor-node/src/admin-client.ts`），共享
   * 令牌只出现在极老 / 手工配置的部署里。
   *
   * ## 两条凭据渠道
   *  1) 共享令牌（`verifyExecutorToken`，读 DB 轮转值 / env 兜底）
   *     → **默认拒绝**（403 `ARTIFACT_UPLOAD_REQUIRES_EXECUTOR_TOKEN`）；仅当
   *       `EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN=true` 时保留旧行为，且每次
   *       `logger.warn`（避免它悄悄变成永久形态）。
   *  2) 每执行器动态令牌（`validateTokenByAddressAnyRow`，与该执行行的
   *     `executorAddress` 绑定）→ 行身份闸，判定强度与改动前完全一致。
   *
   * ⚠️ 不能只把上面的 `return exec` 删掉就收工：`validateTokenByAddressAnyRow`
   * 内部**仍带共享令牌兜底**（executor.service：per-executor 优先、共享兜底），
   * 于是共享令牌会从第二条渠道把口子原样开回来。本方法靠「共享令牌已在前一支
   * 判出」来阻断它：走到渠道 2 的令牌**必然不等于**共享令牌，其内部兜底因此恒
   * 不命中（`timingSafeEqual` 长度或字节不同）。把兜底留在 executor.service 是
   * 刻意的（回调等调用方仍依赖它），此处只保证**本端点**不吃它。
   *
   * 命中前必须先确认执行行存在（NotFound）；否则 401（凭据无效）/ 403（新码）。
   * 返回执行行，供后续 sha 一致性校验与审计使用。
   */
  async verifyUploadAuth(
    execId: string,
    authHeader: string | undefined,
  ): Promise<TaskExecution> {
    if (!isUUID(execId)) {
      throw new AppError(ErrorCode.EXECUTOR_CREDENTIAL_INVALID);
    }
    const exec = await this.execRepo.findOne({ where: { id: execId } });
    if (!exec) {
      throw new AppError(ErrorCode.TASK_EXECUTION_NOT_FOUND);
    }
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : authHeader;

    // ── 渠道 1：共享令牌 ──────────────────────────────────────────────
    let sharedTokenMatched = false;
    try {
      await verifyExecutorToken(
        authHeader,
        this.configService,
        this.systemConfigService,
      );
      sharedTokenMatched = true;
    } catch {
      // 不是共享令牌（或部署未配置共享令牌）→ 继续试 per-executor 动态令牌。
      // 这里刻意吞掉异常：`verifyExecutorToken` 的两种失败（令牌无效 /
      // 未配置）在本端点都只意味着"该走渠道 2"，对外文案由下面的分支决定。
    }

    if (sharedTokenMatched) {
      if (this.sharedTokenUploadAllowed()) {
        // 兼容模式：保留旧行为，但**每次**都喊出来——它允许任一持共享令牌者
        // 向任意 execId 的产物目录写入，是已知的跨执行器写权限。
        this.logger.warn(
          `SEC-1 兼容模式（EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN=true）：共享令牌被接受用于执行 ${execId} 的产物上传。` +
            `该行为允许任一持共享令牌者向**他人**执行的产物目录写入/灌满；请把执行器升级到携带 per-executor 令牌的版本后关闭本开关。`,
        );
        return exec;
      }
      // 刻意不区分 execId 是谁的：共享令牌不携带身份，所以"自己的执行"也拒
      // （谁能用共享令牌，谁就能用它喂任意 execId —— 放行"自己"等于放行全部）。
      throw new AppError(ErrorCode.ARTIFACT_UPLOAD_REQUIRES_EXECUTOR_TOKEN, {
        execId,
        // 两种触发场景共用本码，但下一步动作必须分别说清（见 catalog 文案）。
        reason: "shared_token",
        nextStep:
          "请把执行器升级到会携带 per-executor 动态令牌的版本（getCurrentToken）；迁移期可临时置 EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN=true 恢复旧行为",
      });
    }

    // ── 渠道 2：每执行器动态令牌（行身份闸）────────────────────────────
    if (!token) {
      // 完全没带凭据：与"带了但校验失败"同档（401，既有行为不变）。
      throw new AppError(ErrorCode.EXECUTOR_CREDENTIAL_INVALID);
    }
    if (!exec.executorAddress) {
      // SEC-1：没有 executorAddress 就无法把 per-executor 令牌绑定到具体执行器
      // 行——此时唯一还能通过的凭据是共享令牌，而它已被渠道 1 拒绝。fail-closed
      // 用 403 而非 401：令牌**形态**可能是合法的 per-executor 令牌，失败原因是
      // 执行行缺身份锚点（服务端状态 / 迁移面），调用方无从"改参重试"。
      throw new AppError(ErrorCode.ARTIFACT_UPLOAD_REQUIRES_EXECUTOR_TOKEN, {
        execId,
        reason: "executor_address_unbound",
        nextStep:
          "该执行行没有 executorAddress，无法把 per-executor 令牌绑定到具体执行器：请让执行器重新注册（心跳会回填地址）后再上传，或请管理员核对该执行行的注册记录",
      });
    }
    // ADR-017 阶段 3：同址任一行匹配即通过 —— 执行行只记地址不记行身份，
    // pull 同址多行并存时按地址取单行会误拒合法上传（见 executor.service
    // validateTokenByAddressAnyRow 头注）。判定强度不变。
    const ok = await this.executorService.validateTokenByAddressAnyRow(
      exec.executorAddress,
      token,
    );
    if (ok) return exec;
    throw new AppError(ErrorCode.EXECUTOR_CREDENTIAL_INVALID);
  }
}
