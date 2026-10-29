import { gzip, createGunzip } from "node:zlib";
import { Readable, Transform } from "node:stream";
import { promisify } from "node:util";
import { Logger } from "@nestjs/common";
import { Client } from "minio";
import type { ConfigService } from "@nestjs/config";

export interface S3LogStorageOptions {
  bucket: string;
  /** host or host:port of the S3-compatible endpoint (RustFS by default) */
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
 * rt-2 止血（runtime-perf 第 3 轮）：写面的 gzip 一律走 libuv 线程池的异步版。
 *
 * 为什么：`gzipSync` 在**请求路径**上（执行器终态回调 → handleCallback →
 * backfillFullLogsFromExecutor → storeLogLines → put）同步压缩整个日志对象。
 * 多页回填每页都把 S3 已有对象读回、拼全量、再整段压缩，40 万行日志的末页
 * 是 ~40MB 文本，同步压缩按 50-100MB/s 量级估算即 0.4-0.8s 的**进程级停摆**
 * （期间连执行器回调本身都进不来）。异步版把同样的 CPU 放到线程池，事件循环
 * 继续服务其他请求：调用方仍然要等这次压缩完成（请求延迟不变差，甚至更稳），
 * 但等待从「全进程停摆」变成「本请求 / 本 worker 线程忙」。
 *
 * 字节一致性（已实测+单测锁定，见 s3-log-storage.spec.ts 的 rt-2 用例）：
 * zlib 的 gzip header mtime 在同步/异步两条路径上都是 0（默认不写时间戳，
 * 头部第 4-7 字节恒为 00 00 00 00），输出分块方式也不影响压缩流字节，
 * 因此 `await gzipAsync(x)` 与 `gzipSync(x)` 逐字节相同——换实现不会改变
 * 已有对象的可读性，也不会让同一输入产生不同 key 指纹。
 */
const gzipAsync = promisify(gzip) as (buf: Buffer) => Promise<Buffer>;

/**
 * Stores execution logs as gzipped objects in an S3-compatible store (RustFS by default) (opt-in via
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
    // rt-2：异步压缩（libuv 线程池），不在事件循环上做同步 gzip。字节输出
    // 与 gzipSync 完全一致，故对象格式与既有读取面零变化。
    const body = await gzipAsync(Buffer.from(content, "utf-8"));
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
   *
   * W-5（DEEP_REVIEW 0ef3bbe）：深翻页复杂度 O(n×页数)——S3 对象无行索引，
   * getStream 每次从头解压整个 gzipped 对象，paginateLogStream 按 fromLine
   * 跳过前 n 行。对 400k 行 level=ERROR 深翻页（如第 300k 行起），每页都重扫
   * 300k 行。MAX_LOG_BYTES 100MB 硬帽防 OOM，但不解决深翻页延迟。已知限制：
   * 建议前端限制 S3 日志最大翻页深度（如 ≤10 页），或未来改用行索引/分块存储。
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
          `日志对象 ${key} 超过 MAX_LOG_BYTES（${MAX_LOG_BYTES}）`,
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
