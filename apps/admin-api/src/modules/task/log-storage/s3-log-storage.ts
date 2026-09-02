import { gzipSync, gunzipSync } from "node:zlib";
import { Logger } from "@nestjs/common";
import { Client } from "minio";
import type { ConfigService } from "@nestjs/config";

export interface S3LogStorageOptions {
  bucket: string;
  /** host or host:port of the MinIO/S3 endpoint */
  endpoint: string;
  accessKey: string;
  secretKey: string;
  useSSL: boolean;
  region?: string;
}

/**
 * Stores execution logs as gzipped objects in MinIO/S3 (opt-in via
 * LOG_STORAGE_DRIVER=s3). Callers must fall back to the DB path on error,
 * so the callback flow never breaks when object storage is unavailable.
 */
export class S3LogStorage {
  private readonly logger = new Logger(S3LogStorage.name);
  private readonly client: Client;
  private readonly bucket: string;
  private bucketReady: Promise<void> | null = null;

  constructor(opts: S3LogStorageOptions) {
    const [endPoint, portStr] = opts.endpoint.split(":");
    this.client = new Client({
      endPoint,
      port: portStr ? parseInt(portStr, 10) : undefined,
      useSSL: opts.useSSL,
      accessKey: opts.accessKey,
      secretKey: opts.secretKey,
      region: opts.region || undefined,
    });
    this.bucket = opts.bucket;
  }

  /** Returns null when the feature is off or misconfigured. */
  static fromConfig(config: ConfigService): S3LogStorage | null {
    const driver = config.get<string>("logStorage.driver");
    const endpoint = config.get<string>("logStorage.endpoint");
    if (driver !== "s3" || !endpoint) return null;
    return new S3LogStorage({
      bucket: config.get<string>("logStorage.bucket") || "autoflow-logs",
      endpoint,
      accessKey: config.get<string>("logStorage.accessKey") || "",
      secretKey: config.get<string>("logStorage.secretKey") || "",
      useSSL: config.get<boolean>("logStorage.useSSL") ?? false,
      region: config.get<string>("logStorage.region") || undefined,
    });
  }

  objectKey(executionId: string): string {
    return `execution-logs/${executionId}.log.gz`;
  }

  private ensureBucket(): Promise<void> {
    if (!this.bucketReady) {
      this.bucketReady = (async () => {
        const exists = await this.client.bucketExists(this.bucket);
        if (!exists) await this.client.makeBucket(this.bucket, "");
      })().catch((err) => {
        // allow a later retry instead of caching the failure forever
        this.bucketReady = null;
        throw err;
      });
    }
    return this.bucketReady;
  }

  /** Upload the full log text; resolves to the object key. */
  async put(executionId: string, content: string): Promise<string> {
    await this.ensureBucket();
    const key = this.objectKey(executionId);
    const body = gzipSync(Buffer.from(content, "utf-8"));
    await this.client.putObject(this.bucket, key, body, body.length, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Encoding": "gzip",
    });
    this.logger.debug(`stored log object ${key} (${body.length} bytes gz)`);
    return key;
  }

  /** Download and gunzip the full log text. */
  async get(key: string): Promise<string> {
    const stream = await this.client.getObject(this.bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return gunzipSync(Buffer.concat(chunks)).toString("utf-8");
  }

  async remove(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, key);
  }
}
