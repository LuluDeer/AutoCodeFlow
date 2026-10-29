import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ReadStream } from "node:fs";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { createResponseReadStream } from "../../common/utils/response-stream.util";
import { AiMedia } from "./entities/ai-media.entity";
import {
  safeMediaFileName,
  videoExtension,
  mimeForFileName,
} from "./ai-media-url";

/**
 * 视频转 SOP 的媒体存储（上传 / 读取 / 范围请求）。
 *
 * 纪律与既有 `SopMediaService` 对齐（**不重学教训**）：
 *   · 单文件 ≤100MB，扩展名白名单（mp4/webm/mov/m4v）；
 *   · 文件名只允许 `[A-Za-z0-9._-]`，不以点开头（防穿越/隐藏文件）；
 *   · **原子写**：先写 `.tmp-xxx` 再 rename——下载端永远看不到半截文件，
 *     且写盘期间不阻塞事件循环（`fs.promises`）；
 *   · 存**相对路径**（换部署目录不失效），解析后再校验前缀（纵深防御）。
 */

/** 单文件上限（与执行器媒体对齐）。 */
export const AI_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

export function getAiMediaRootDir(): string {
  return path.join(process.cwd(), "uploads", "ai-media");
}

export interface MediaByteRange {
  start: number;
  end: number;
}

/**
 * 解析 `Range: bytes=start-end`（纯函数，导出以便单测）。
 *
 * 只支持单段（多段 `bytes=0-1,5-6` 直接拒绝——视频 fetcher 不会这么请求，
 * 而实现多段 multipart 响应的复杂度与收益不成比例）。
 * 返回 `null` = 无/可忽略的 Range（按整文件响应）；`"invalid"` = 越界/不可解析。
 */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): MediaByteRange | null | "invalid" {
  const raw = (header ?? "").trim();
  if (!raw) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(raw);
  if (!m) return "invalid";
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return "invalid";

  if (rawStart === "") {
    // 后缀形态：bytes=-N（最后 N 字节）
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return "invalid";
    return { start: Math.max(0, size - n), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start < 0 || start >= size) return "invalid";
  if (rawEnd === "") return { start, end: size - 1 };

  const end = Number(rawEnd);
  if (!Number.isFinite(end) || end < start) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

@Injectable()
export class AiMediaService {
  private readonly logger = new Logger(AiMediaService.name);

  constructor(
    @InjectRepository(AiMedia)
    private readonly repo: Repository<AiMedia>,
  ) {}

  /** 落盘 + 登记（校验失败抛 4xx 语义的 AppError）。 */
  async save(input: {
    name: string;
    buf: Buffer;
    uploadedBy: string;
  }): Promise<AiMedia> {
    const name = safeMediaFileName(input.name);
    if (!name) throw new AppError(ErrorCode.AI_MEDIA_NAME_INVALID);
    if (!videoExtension(name)) {
      throw new AppError(ErrorCode.AI_MEDIA_TYPE_NOT_ALLOWED);
    }
    if (!input.buf || input.buf.length === 0) {
      throw new AppError(ErrorCode.AI_MEDIA_EMPTY);
    }
    if (input.buf.length > AI_MEDIA_MAX_BYTES) {
      throw new AppError(ErrorCode.AI_MEDIA_TOO_LARGE, {
        max: AI_MEDIA_MAX_BYTES,
      });
    }

    const storedPath = path.join(
      crypto.randomUUID(),
      `${crypto.randomUUID()}-${name}`,
    );
    const abs = path.join(getAiMediaRootDir(), storedPath);
    if (
      !path
        .resolve(abs)
        .startsWith(path.resolve(getAiMediaRootDir()) + path.sep)
    ) {
      throw new AppError(ErrorCode.AI_MEDIA_PATH_ESCAPED);
    }

    const dir = path.dirname(abs);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.tmp-${crypto.randomBytes(6).toString("hex")}`);
    await fs.promises.writeFile(tmp, input.buf);
    // 原子发布：下载端只可能看到完整文件
    await fs.promises.rename(tmp, abs);

    const row = await this.repo.save(
      this.repo.create({
        name,
        mime: mimeForFileName(name),
        sizeBytes: input.buf.length,
        storedPath,
        uploadedBy: input.uploadedBy,
      }),
    );
    this.logger.log(
      `AI media stored: id=${row.id} name=${name} bytes=${row.sizeBytes} by=${input.uploadedBy}`,
    );
    return row;
  }

  async findById(id: string): Promise<AiMedia | null> {
    return this.repo.findOne({ where: { id } });
  }

  async requireById(id: string): Promise<AiMedia> {
    const row = await this.findById(id);
    if (!row) throw new AppError(ErrorCode.AI_MEDIA_NOT_FOUND, { mediaId: id });
    return row;
  }

  /** 打开读流（支持范围；越界抛 416 语义由调用方处理）。 */
  openStream(
    row: AiMedia,
    range: MediaByteRange | null,
  ): {
    stream: ReadStream;
    start: number;
    end: number;
    size: number;
  } {
    const root = path.resolve(getAiMediaRootDir());
    const abs = path.resolve(root, row.storedPath);
    if (!abs.startsWith(root + path.sep)) {
      throw new AppError(ErrorCode.AI_MEDIA_PATH_ESCAPED);
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : row.sizeBytes - 1;
    // P1-2（ARCH-008）：裸 createReadStream 的 open 是异步的——行存在但文件
    // 刚被保留期清理掉时，ENOENT 会以 'error' 事件发出；无监听即
    // uncaughtException，代价是整个实例 graceful shutdown。走统一封装把
    // 「进程级事故」降级为「这一次下载失败」（warn + destroy）。
    // 调用方（控制器）另挂自己的 error 处理改写 HTTP 语义（未发头则 500）。
    return {
      stream: createResponseReadStream(abs),
      start,
      end,
      size: row.sizeBytes,
    };
  }
}
