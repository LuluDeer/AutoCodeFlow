import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, Like, FindOptionsWhere } from "typeorm";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import axios from "axios";
import { ConfigService } from "@nestjs/config";
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

@Injectable()
export class ExecutorPackageService {
  private readonly logger = new Logger(ExecutorPackageService.name);

  constructor(
    @InjectRepository(ExecutorPackage)
    private readonly repo: Repository<ExecutorPackage>,
    private readonly configService: ConfigService,
  ) {
    // Ensure upload directory exists on startup
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
  }

  /**
   * Create executor package, save uploaded file to disk and record SHA-256 checksum.
   */
  async create(
    createDto: CreateExecutorPackageDto,
    file: Express.Multer.File,
    uploadedBy?: string,
  ): Promise<ExecutorPackage> {
    if (!file) {
      throw new BadRequestException("Package file is required");
    }

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

    // Calculate SHA-256 checksum
    const checksum = crypto
      .createHash("sha256")
      .update(file.buffer)
      .digest("hex");

    // Construct unique filename: <name>-<version>-<first8checksum>.<ext>
    const ext = path.extname(file.originalname) || ".zip";
    const safeName = createDto.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeVersion = createDto.version.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `${safeName}-${safeVersion}-${checksum.slice(0, 8)}${ext}`;
    const filePath = path.join(UPLOAD_DIR, filename);

    // Write file to disk
    fs.writeFileSync(filePath, file.buffer);

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
    const saved = await this.repo.save(pkg);
    this.logger.log(
      `Created executor package: ${saved.name}@${saved.version} [${saved.id}], file=${filename}, size=${file.size}, checksum=${checksum}`,
    );
    return saved;
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

    // Sync-delete file from disk (best-effort, does not block DB deletion)
    if (pkg.filePath && fs.existsSync(pkg.filePath)) {
      try {
        fs.unlinkSync(pkg.filePath);
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
   * Read file content for a given package (used by download endpoint).
   */
  async getFileBuffer(
    id: string,
  ): Promise<{ buffer: Buffer; pkg: ExecutorPackage }> {
    const pkg = await this.findOne(id);
    if (!pkg.filePath || !fs.existsSync(pkg.filePath)) {
      throw new NotFoundException(
        `File for ExecutorPackage ${id} not found on disk`,
      );
    }
    const buffer = fs.readFileSync(pkg.filePath);
    return { buffer, pkg };
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
    executorRepo?: import('../executor/entities/executor.entity').Executor[],
    sharedToken?: string,
  ): Promise<{ executorId: string; address: string; success: boolean; error?: string }[]> {
    const pkg = await this.findOne(id);

    const targets = executorIds && executorIds.length > 0
      ? (executorRepo ?? []).filter((e) => executorIds.includes(e.id))
      : (executorRepo ?? []);

    if (targets.length === 0) {
      throw new Error('No target executors found for push');
    }

    const adminApiBaseUrl = this.configService.get<string>("ADMIN_API_BASE_URL", "");
    const downloadUrl = `${adminApiBaseUrl}/api/executor-packages/${pkg.id}/download`;
    const results = await Promise.allSettled(
      targets.map(async (executor) => {
        const url = executor.address.startsWith('http')
          ? executor.address
          : `http://${executor.address}`;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (sharedToken) headers['Authorization'] = `Bearer ${sharedToken}`;
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
        this.logger.log(`Pushed package ${pkg.name}@${pkg.version} to executor ${executor.address}`);
        return { executorId: executor.id, address: executor.address, success: true };
      }),
    );

    return results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { executorId: targets[i].id, address: targets[i].address, success: false, error: (r.reason as Error)?.message ?? String(r.reason) },
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
      .createQueryBuilder('pkg')
      .where('pkg.status = :status', { status: ExecutorPackageStatus.ACTIVE })
      .andWhere('pkg.type = :type', { type })
      .orderBy('pkg.createdAt', 'DESC');
    if (platform) {
      qb.andWhere('pkg.platform = :platform', { platform });
    }
    return qb.getOne();
  }

  /**
   * Generate one-time install token (random 32-byte hex, TTL 1 hour).
   * Used by frontend install wizard to authorize script download without login.
   */
  generateInstallToken(executorId?: string): { token: string; expiresIn: number; expiresAt: string } {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresIn = 3600; // seconds
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    this.logger.log(`Generated install token${executorId ? ` for executor ${executorId}` : ''}`);
    return { token, expiresIn, expiresAt };
  }
}
