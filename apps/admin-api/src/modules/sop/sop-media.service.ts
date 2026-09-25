import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { createReadStream, existsSync, mkdirSync, statSync } from "fs";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Repository } from "typeorm";

import { AgentMedia } from "./entities/agent-media.entity";
import { getEnvVar } from "../../config/env";

/**
 * P7b（agent-and-deployment）：Agent 媒体存储（截图/录屏回传的落盘与读取）。
 *
 * ## 存储根
 * `AGENT_MEDIA_DIR` 可覆盖（模块求值期读 env，经 getEnvVar 集中放行——
 * ARCH-27/W-22 同款豁免位）；默认 `<cwd>/uploads/agent-media`（与 artifacts
 * 根模式一致）。盘上结构 `<assignmentId>/<uuid>-<name>`——uuid 前缀防同名
 * 覆盖，assignmentId 分层让 30 天保留清理按目录整删。
 *
 * ## 边界
 * · 文件名过封闭字符集（同 artifacts 的 SAFE_ARTIFACT_NAME_RE），**不承担
 *   路径语义**（盘上名以 uuid 前缀重建）；
 * · 单文件 ≤100MB（与 MAX_ARTIFACT_SIZE_BYTES 对齐）；
 * · 上传前必须确认指派归属（调用方负责鉴权，本服务只管字节）。
 */

/** 单媒体文件上限（与 artifacts 的 100MB 对齐；录屏的真实上界）。 */
export const MAX_AGENT_MEDIA_BYTES = 100 * 1024 * 1024;

const SAFE_MEDIA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export function getAgentMediaRootDir(): string {
  const override = getEnvVar("AGENT_MEDIA_DIR");
  if (override && override.trim()) return override.trim();
  return path.join(process.cwd(), "uploads", "agent-media");
}

export interface StoredMedia {
  id: string;
  name: string;
  mime: string | null;
  sizeBytes: number;
  /** 对客户端暴露的平台路径（mediaRefs 引用它——绝不接受其它形态）。 */
  mediaPath: string;
}

@Injectable()
export class SopMediaService {
  private readonly logger = new Logger(SopMediaService.name);

  constructor(
    @InjectRepository(AgentMedia)
    private readonly mediaRepo: Repository<AgentMedia>,
  ) {}

  /** 落盘 + 登记。sizeBytes=0 或超限直接拒。 */
  async save(input: {
    assignmentId: string;
    name: string;
    mime?: string | null;
    buf: Buffer;
    uploadedBy: string;
  }): Promise<StoredMedia> {
    const name = input.name ?? "";
    if (!SAFE_MEDIA_NAME_RE.test(name)) {
      throw new BadRequestException(
        "媒体名必须是 1..255 的 [A-Za-z0-9._-]（不含路径语义）",
      );
    }
    if (!input.buf || input.buf.length === 0) {
      throw new BadRequestException("空媒体文件");
    }
    if (input.buf.length > MAX_AGENT_MEDIA_BYTES) {
      throw new BadRequestException(
        `媒体超过 ${MAX_AGENT_MEDIA_BYTES} 字节上限`,
      );
    }

    // assignmentId 由 controller 从 UUID 路由参数取得，但这里仍不信任拼接：
    // 二次校验 uuid 形态，防目录穿越变体。
    if (!/^[0-9a-fA-F-]{36}$/.test(input.assignmentId)) {
      throw new BadRequestException("assignmentId 必须是 UUID");
    }
    const diskName = `${crypto.randomUUID()}-${name}`;
    const storedPath = path.join(input.assignmentId, diskName);
    const abs = path.join(getAgentMediaRootDir(), storedPath);
    // 终检：解析后必须仍在根内（防御性——上面两道已封死，这里兜底）
    if (
      !path
        .resolve(abs)
        .startsWith(path.resolve(getAgentMediaRootDir()) + path.sep)
    ) {
      throw new BadRequestException("存储路径越界");
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, input.buf);

    const row = await this.mediaRepo.save(
      this.mediaRepo.create({
        assignmentId: input.assignmentId,
        name,
        mime: input.mime ?? null,
        sizeBytes: input.buf.length,
        storedPath,
        uploadedBy: input.uploadedBy,
      }),
    );
    this.logger.log(
      `Agent media stored: id=${row.id} assignment=${input.assignmentId} name=${name} bytes=${input.buf.length}`,
    );
    return {
      id: row.id,
      name,
      mime: input.mime ?? null,
      sizeBytes: input.buf.length,
      mediaPath: `/api/agent-collab/media/${row.id}`,
    };
  }

  /** 读元数据（下载端点先取它定位盘上文件）。 */
  async requireById(id: string): Promise<AgentMedia> {
    const row = await this.mediaRepo.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`媒体 ${id} 不存在`);
    return row;
  }

  /** 打开已存媒体的只读流（下载端点用）。路径越界/文件丢失一律 404/400。 */
  openStream(row: AgentMedia): {
    stream: ReturnType<typeof createReadStream>;
    size: number;
    mime: string | null;
    name: string;
  } {
    const root = path.resolve(getAgentMediaRootDir());
    const abs = path.resolve(root, row.storedPath);
    if (!abs.startsWith(root + path.sep)) {
      throw new BadRequestException("存储路径越界");
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new NotFoundException("媒体文件缺失（可能已被保留期清理）");
    }
    return {
      stream: createReadStream(abs),
      size: statSync(abs).size,
      mime: row.mime,
      name: row.name,
    };
  }

  /** 列出一次指派的媒体（ADMIN 面展示用）。 */
  async listByAssignment(assignmentId: string): Promise<AgentMedia[]> {
    return this.mediaRepo.find({
      where: { assignmentId },
      order: { createdAt: "DESC" },
      take: 100,
    });
  }
}
