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
import {
  ExecutorPackage,
  ExecutorPackageStatus,
} from "./executor-package.entity";
import {
  CreateExecutorPackageDto,
  UpdateExecutorPackageDto,
  QueryExecutorPackageDto,
} from "./dto/executor-package.dto";

/** 执行器包文件的上传目录（相对于进程工作目录） */
const UPLOAD_DIR = path.join(process.cwd(), "uploads", "executor-packages");

@Injectable()
export class ExecutorPackageService {
  private readonly logger = new Logger(ExecutorPackageService.name);

  constructor(
    @InjectRepository(ExecutorPackage)
    private readonly repo: Repository<ExecutorPackage>,
  ) {
    // 启动时确保上传目录存在
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
  }

  /**
   * 创建执行器包，同时将上传的文件保存到磁盘并记录 SHA-256 校验和。
   */
  async create(
    createDto: CreateExecutorPackageDto,
    file: Express.Multer.File,
    uploadedBy?: string,
  ): Promise<ExecutorPackage> {
    if (!file) {
      throw new BadRequestException("Package file is required");
    }

    // 检查同名/同版本/同类型是否已存在
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

    // 计算 SHA-256 校验和
    const checksum = crypto
      .createHash("sha256")
      .update(file.buffer)
      .digest("hex");

    // 构造唯一文件名：<name>-<version>-<checksum前8位>.<ext>
    const ext = path.extname(file.originalname) || ".zip";
    const safeName = createDto.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeVersion = createDto.version.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `${safeName}-${safeVersion}-${checksum.slice(0, 8)}${ext}`;
    const filePath = path.join(UPLOAD_DIR, filename);

    // 将文件写入磁盘
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

    // 同步删除磁盘上的文件（尽力而为，不阻断 DB 删除）
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
   * 读取指定包的文件内容（用于下载接口）。
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
   * 返回上传目录的绝对路径（供静态文件服务使用）。
   */
  getUploadDir(): string {
    return UPLOAD_DIR;
  }

  async deprecate(id: string): Promise<ExecutorPackage> {
    return this.update(id, { status: ExecutorPackageStatus.DEPRECATED });
  }

  async activate(id: string): Promise<ExecutorPackage> {
    return this.update(id, { status: ExecutorPackageStatus.ACTIVE });
  }

  /**
   * 查找指定类型（和可选平台）下最新的 ACTIVE 包（按创建时间倒序取第一条）。
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
}
