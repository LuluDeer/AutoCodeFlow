/**
 * N10 workbench Part 投影服务：把 part-model 的纯投影接到 blob 后端与服务端 Part 源。
 *
 * 纪律：
 * - Part 只从 WorkbenchPartProvider 取（服务端注入），HTTP 入参只给 partId；
 * - currentGeneration 由控制器从既有 PolicyGenerationService 读取，不信任客户端；
 * - viewerIsOwner 由 @CurrentUser + Part.sessionId 归属判定，可见性仍由
 *   part-model.isPartVisible 决定；
 * - blob 正文只在 visible=true 时读回并放进 blobContent，private 且非 owner
 *   时连 store.get 都不调用。
 */
import { Injectable } from "@nestjs/common";

import {
  isBlobBackedKind,
  projectPart,
  type BlobBackedKind,
  type GenerationToken,
  type PartProjection,
  type ProjectionContext,
  type WorkbenchPart,
} from "./part-model";
import { WorkbenchBlobStore } from "./workbench-blob.store";

/** 与 commit/rewind 端点同形的 @CurrentUser 最小面。 */
export interface WorkbenchViewer {
  id: number | string;
  username?: string;
}

export interface ProjectedPart extends PartProjection {
  /** 仅 visible=true 时出现；key 与 blobRefs[i].blobKey 一一对应。 */
  blobContent?: Readonly<Record<string, string>>;
}

export interface IngestPartInput {
  part: WorkbenchPart;
  /** 服务端持有的大字段；显式传入时优先于 part 上的内联同名字段。 */
  fields?: Readonly<Record<string, string>>;
  /** 覆盖 mimeType；file 类未传时取 part.mime。 */
  mimeType?: string;
}

export interface ProjectionOptions {
  /** 默认 true；false 时只回投影与 blobRefs，不读 blob 正文。 */
  includeBlobContent?: boolean;
}

/** DI token：生产装配可把默认内存实现 override 成真实 Part 仓储。 */
export abstract class WorkbenchPartProvider {
  abstract getPart(partId: string): Promise<WorkbenchPart | null>;
  abstract listParts(sessionId: string): Promise<readonly WorkbenchPart[]>;
  abstract savePart(part: WorkbenchPart): Promise<void>;
  abstract isOwner(
    sessionId: string,
    viewer: WorkbenchViewer | undefined,
  ): Promise<boolean>;
}

/** 缺省服务端 Part 源：进程内、只由服务端代码写入，HTTP 入参碰不到。 */
export class InMemoryWorkbenchPartProvider implements WorkbenchPartProvider {
  private readonly parts = new Map<string, WorkbenchPart>();
  private readonly owners = new Map<string, Set<string>>();

  async getPart(partId: string): Promise<WorkbenchPart | null> {
    return this.parts.get(partId) ?? null;
  }

  async listParts(sessionId: string): Promise<readonly WorkbenchPart[]> {
    return [...this.parts.values()].filter(
      (part) => part.sessionId === sessionId,
    );
  }

  async savePart(part: WorkbenchPart): Promise<void> {
    this.parts.set(part.id, part);
  }

  /** 测试/裁剪装配的归属标记；生产由 WorkbenchModule 的 factory 覆盖。 */
  setOwners(sessionId: string, identities: readonly (string | number)[]): void {
    this.owners.set(sessionId, new Set(identities.map((item) => String(item))));
  }

  async isOwner(
    sessionId: string,
    viewer: WorkbenchViewer | undefined,
  ): Promise<boolean> {
    if (!viewer) return false;
    const markers = this.owners.get(sessionId);
    if (!markers) return false;
    return (
      markers.has(String(viewer.id)) ||
      markers.has(String(viewer.username)) ||
      markers.has(`user:${viewer.id}`) ||
      markers.has(`user:${viewer.username}`)
    );
  }
}

/** 大字段字段名：与 part-model 的四类 BlobBackedKind 一一对应。 */
const BLOB_FIELD_BY_KIND: Record<BlobBackedKind, string> = {
  tool: "output",
  file: "content",
  compaction: "summary",
  patch: "diff",
};

function readInline(part: WorkbenchPart, field: string): string | undefined {
  const value = (part as unknown as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

@Injectable()
export class PartProjectionService {
  constructor(
    private readonly blobs: WorkbenchBlobStore,
    private readonly parts: WorkbenchPartProvider,
  ) {}

  /**
   * 写入大字段并把 Part 内联内容替换为 BlobRef；无大字段的 kind 原样入 provider。
   * 只处理服务端传入的 WorkbenchPart，调用方不得把 HTTP body 直接当 part。
   */
  async ingestPart(input: IngestPartInput): Promise<WorkbenchPart> {
    const part = input.part;
    if (!isBlobBackedKind(part.kind)) {
      await this.parts.savePart(part);
      return part;
    }

    const kind = part.kind as BlobBackedKind;
    const field = BLOB_FIELD_BY_KIND[kind];
    const content = input.fields?.[field] ?? readInline(part, field);
    if (content === undefined) {
      await this.parts.savePart(part);
      return part;
    }

    const mimeType =
      input.mimeType ??
      (kind === "file" ? readInline(part, "mime") : undefined);
    const ref = await this.blobs.put(
      `part:${part.id}:${field}`,
      content,
      mimeType,
    );

    // 复制后删内联字段，绝不改调用方持有的入参对象。
    const stripped = { ...(part as unknown as Record<string, unknown>) };
    delete stripped[field];
    const stored = {
      ...stripped,
      blobRefs: [...(part.blobRefs ?? []), ref],
    } as unknown as WorkbenchPart;
    await this.parts.savePart(stored);
    return stored;
  }

  /** 单 Part 投影。visible=false 时不触碰 blob 后端。 */
  async projectOne(
    part: WorkbenchPart,
    ctx: ProjectionContext,
    options: ProjectionOptions = {},
  ): Promise<ProjectedPart> {
    const projection = projectPart(part, ctx);
    if (!projection.visible || options.includeBlobContent === false) {
      return projection;
    }

    const content: Record<string, string> = {};
    for (const ref of projection.blobRefs) {
      try {
        content[ref.blobKey] = await this.blobs.get(ref.blobKey);
      } catch {
        // blob 已过期/被清理：保留引用标记，正文缺席，不让整个投影失败。
      }
    }
    return Object.keys(content).length > 0
      ? { ...projection, blobContent: content }
      : projection;
  }

  /** 批量投影（12 类 kind 走同一条路径）。 */
  async projectMany(
    parts: readonly WorkbenchPart[],
    ctx: ProjectionContext,
    options: ProjectionOptions = {},
  ): Promise<ProjectedPart[]> {
    const out: ProjectedPart[] = [];
    for (const part of parts) {
      out.push(await this.projectOne(part, ctx, options));
    }
    return out;
  }

  /** 端点入口：只收 partId + 服务端代际 + @CurrentUser。 */
  async projectById(
    partId: string,
    currentGeneration: GenerationToken,
    viewer: WorkbenchViewer | undefined,
    options: ProjectionOptions = {},
  ): Promise<ProjectedPart | null> {
    const part = await this.parts.getPart(partId);
    if (!part) return null;
    const viewerIsOwner = await this.parts.isOwner(part.sessionId, viewer);
    return this.projectOne(part, { currentGeneration, viewerIsOwner }, options);
  }

  async removeBlob(blobKey: string): Promise<void> {
    await this.blobs.remove(blobKey);
  }
}
