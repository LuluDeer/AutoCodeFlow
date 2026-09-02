import { gzipSync, createGunzip } from "node:zlib";
import { Readable, Transform } from "node:stream";
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

/** Hard cap on the gunzipped payload we are willing to materialize in memory.
 *  Protects admin-api from OOM if an executor writes a runaway log; ~100 MB
 *  is well above the callback log cap (512 KB compressed) and supports
 *  long-running task tails. */
export const MAX_LOG_BYTES = 100 * 1024 * 1024;

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

  /**
   * Download the gunzipped log text as a `Readable` of Buffer chunks so the
   * caller can page through lines without ever holding the whole thing in
   * memory. Throws if the decompressed payload exceeds MAX_LOG_BYTES.
   */
  async getStream(key: string): Promise<Readable> {
    const raw = await this.client.getObject(this.bucket, key);
    const gunzip = createGunzip();
    const cap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        // Running tally lives on the Transform's internal state via `bytes`.
        // `this` here is the Transform instance.
        const t = this as unknown as { bytes?: number };
        t.bytes = (t.bytes ?? 0) + chunk.length;
        if (t.bytes > MAX_LOG_BYTES) {
          cb(
            new Error(
              `Log object ${key} exceeds MAX_LOG_BYTES (${MAX_LOG_BYTES}); refusing to materialize`,
            ),
          );
          return;
        }
        cb(null, chunk);
      },
    });
    // Manual plumbing (rather than stream.pipeline()) so we can return the
    // downstream readable to the caller. Errors propagate through the standard
    // Node stream error path so for-await consumers will see the rejection.
    raw.pipe(gunzip).pipe(cap);
    raw.on("error", (e) => cap.destroy(e));
    gunzip.on("error", (e) => cap.destroy(e));
    return cap;
  }

  /** Backwards-compatible full-materialize helper — still used by tests and
   *  by the LOG-11 streaming SSE flush path. Throws on over-cap. */
  async get(key: string): Promise<string> {
    const stream = await this.getStream(key);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      bytes += buf.length;
      if (bytes > MAX_LOG_BYTES) {
        throw new Error(
          `Log object ${key} exceeds MAX_LOG_BYTES (${MAX_LOG_BYTES})`,
        );
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  async remove(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, key);
  }
}
