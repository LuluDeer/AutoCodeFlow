/**
 * N10 workbench 大字段 blob 后端。
 *
 * 复用 task/log-storage 的 S3LogStorage：driver≠s3 时 fromConfig 返回 null，
 * 这里退回进程内内存替身，接口逐字一致，不新起外部系统。S3 侧的对象 key 由
 * S3LogStorage.objectKey 统一派生，逻辑 blobKey（part:<id>:<field>）只出现在
 * BlobRef 与本层对外契约里。
 */
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { S3LogStorage } from "../task/log-storage/s3-log-storage";
import type { BlobRef } from "./part-model";

export interface WorkbenchBlobStoreLike {
  put(blobKey: string, content: string, mimeType?: string): Promise<BlobRef>;
  get(blobKey: string): Promise<string>;
  remove(blobKey: string): Promise<void>;
}

@Injectable()
export class WorkbenchBlobStore implements WorkbenchBlobStoreLike {
  private readonly s3: S3LogStorage | null;
  private readonly memory = new Map<
    string,
    { content: string; mimeType?: string }
  >();

  constructor(config: ConfigService) {
    this.s3 = S3LogStorage.fromConfig(config as never);
  }

  async put(
    blobKey: string,
    content: string,
    mimeType?: string,
  ): Promise<BlobRef> {
    if (this.s3) {
      await this.s3.put(blobKey, content);
    } else {
      this.memory.set(blobKey, { content, ...(mimeType ? { mimeType } : {}) });
    }
    return {
      blobKey,
      byteLength: Buffer.byteLength(content, "utf8"),
      ...(mimeType ? { mimeType } : {}),
    };
  }

  async get(blobKey: string): Promise<string> {
    if (this.s3) {
      return this.s3.get(this.s3.objectKey(blobKey));
    }
    const hit = this.memory.get(blobKey);
    if (!hit) {
      throw new Error(`工作台分片不存在：${blobKey}`);
    }
    return hit.content;
  }

  async remove(blobKey: string): Promise<void> {
    if (this.s3) {
      await this.s3.remove(this.s3.objectKey(blobKey));
      return;
    }
    this.memory.delete(blobKey);
  }
}
