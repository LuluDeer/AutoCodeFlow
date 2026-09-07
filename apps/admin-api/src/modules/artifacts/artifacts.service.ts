import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
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
import { SystemConfigService } from "../config/config.service";
import { ExecutorService } from "../executor/executor.service";
import { verifyExecutorToken } from "../../common/utils/verify-executor-token.util";
import {
  getArtifactRootDir,
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
      throw new BadRequestException("Invalid execution id");
    }
    if (!SAFE_ARTIFACT_NAME_RE.test(name) || path.basename(name) !== name) {
      throw new BadRequestException("Invalid artifact name");
    }
    const base = path.join(getArtifactRootDir(), execId);
    const full = path.join(base, name);
    if (full !== path.join(base, name) || !full.startsWith(base + path.sep)) {
      throw new BadRequestException("Invalid artifact path");
    }
    return full;
  }

  /** 目录内文件数上限预检（上传前）。 */
  private assertWithinCountCap(execId: string): void {
    const dir = path.join(getArtifactRootDir(), execId);
    try {
      if (fs.existsSync(dir)) {
        const n = fs.readdirSync(dir).length;
        if (n >= MAX_ARTIFACT_COUNT) {
          throw new BadRequestException(
            `Artifact count cap (${MAX_ARTIFACT_COUNT}) reached for this execution`,
          );
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
      throw new BadRequestException("Artifact exceeds size cap");
    }
    this.assertWithinCountCap(execId);

    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    if (
      declaredSha256 &&
      declaredSha256.toLowerCase() !== sha256
    ) {
      throw new BadRequestException(
        "Artifact sha256 does not match uploaded bytes",
      );
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

  /** 打开产物用于流式下载。缺文件 → NotFound。 */
  async openArtifact(
    execId: string,
    name: string,
  ): Promise<{ stream: fs.ReadStream; fileSize: number; contentType: string }> {
    const full = this.resolveArtifactPath(execId, name);
    if (!fs.existsSync(full)) {
      throw new NotFoundException("Artifact not found");
    }
    const fileSize = fs.statSync(full).size;
    const ext = path.extname(name).toLowerCase();
    return {
      stream: fs.createReadStream(full),
      fileSize,
      contentType: CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream",
    };
  }

  /** 读取执行行的产物清单（供列表端点）。 */
  async getManifest(execId: string): Promise<ExecutionArtifact[]> {
    if (!isUUID(execId)) throw new BadRequestException("Invalid execution id");
    const exec = await this.execRepo.findOne({ where: { id: execId } });
    if (!exec) throw new NotFoundException("Execution not found");
    return exec.artifacts ?? [];
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
      throw new UnauthorizedException("Invalid executor credential");
    }
    const exec = await this.execRepo.findOne({ where: { id: execId } });
    if (!exec) {
      throw new NotFoundException("Execution not found");
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
      const ok = await this.executorService.validateTokenByAddress(
        exec.executorAddress,
        token,
      );
      if (ok) return exec;
    }
    throw new UnauthorizedException("Invalid executor credential");
  }
}
