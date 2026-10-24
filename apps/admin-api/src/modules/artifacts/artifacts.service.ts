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
   * 校验产物上传凭据（机器对机器）——复用回调端点的鉴权形态：
   *  1) 执行器共享 token（verifyExecutorToken，读 DB 轮转值 / env 兜底）；
   *  2) 每执行器动态 token（validateTokenByAddress，与该执行行的 executorAddress 绑定）。
   * 执行器上报产物使用与终态回调同一个 token，故两条凭据渠道任一命中即放行。
   * 命中前必须先确认执行行存在（NotFound）；否则 Unauthorized。
   * 返回执行行，供后续 sha 一致性校验使用。
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

    try {
      await verifyExecutorToken(
        authHeader,
        this.configService,
        this.systemConfigService,
      );
      return exec;
    } catch {
      // 共享 token 不匹配 → 试每执行器动态 token。
    }
    if (exec.executorAddress && token) {
      // ADR-017 阶段 3：同址任一行匹配即通过 —— 执行行只记地址不记行身份，
      // pull 同址多行并存时按地址取单行会误拒合法上传（见 executor.service
      // validateTokenByAddressAnyRow 头注）。判定强度不变。
      const ok = await this.executorService.validateTokenByAddressAnyRow(
        exec.executorAddress,
        token,
      );
      if (ok) return exec;
    }
    throw new AppError(ErrorCode.EXECUTOR_CREDENTIAL_INVALID);
  }
}
