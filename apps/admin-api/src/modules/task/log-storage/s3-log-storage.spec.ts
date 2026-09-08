import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { ConfigService } from "@nestjs/config";
import { MAX_LOG_BYTES, S3LogStorage } from "./s3-log-storage";

const minioClient = {
  bucketExists: jest.fn(),
  makeBucket: jest.fn(),
  putObject: jest.fn(),
  getObject: jest.fn(),
  removeObject: jest.fn(),
};

jest.mock("minio", () => ({
  Client: jest.fn(() => minioClient),
}));

const makeConfig = (overrides: Record<string, unknown> = {}) =>
  ({
    get: jest.fn((key: string) => overrides[key]),
  }) as unknown as ConfigService;

const storage = () =>
  new S3LogStorage({
    bucket: "autoflow-logs",
    endpoint: "minio:9000",
    accessKey: "AK",
    secretKey: "SK",
    useSSL: false,
  });

beforeEach(() => {
  jest.clearAllMocks();
  minioClient.bucketExists.mockResolvedValue(true);
  minioClient.makeBucket.mockResolvedValue(undefined);
  minioClient.putObject.mockResolvedValue(undefined);
  minioClient.removeObject.mockResolvedValue(undefined);
});

describe("S3LogStorage", () => {
  it("is disabled unless driver is s3 with an endpoint", () => {
    expect(S3LogStorage.fromConfig(makeConfig())).toBeNull();
    expect(
      S3LogStorage.fromConfig(
        makeConfig({ "logStorage.driver": "s3", "logStorage.endpoint": "" }),
      ),
    ).toBeNull();
    expect(
      S3LogStorage.fromConfig(
        makeConfig({
          "logStorage.driver": "db",
          "logStorage.endpoint": "minio:9000",
        }),
      ),
    ).toBeNull();
  });

  it("builds from config when enabled", () => {
    expect(
      S3LogStorage.fromConfig(
        makeConfig({
          "logStorage.driver": "s3",
          "logStorage.endpoint": "minio:9000",
          "logStorage.bucket": "b",
          "logStorage.accessKey": "AK",
          "logStorage.secretKey": "SK",
          "logStorage.useSSL": true,
        }),
      ),
    ).toBeInstanceOf(S3LogStorage);
  });

  it("put() uploads a gzip object and returns the key", async () => {
    const key = await storage().put("exec-1", "hello\nworld");
    expect(key).toBe("execution-logs/exec-1.log.gz");
    expect(minioClient.bucketExists).toHaveBeenCalledWith("autoflow-logs");
    expect(minioClient.makeBucket).not.toHaveBeenCalled();
    const [bucket, objKey, body, size, meta] =
      minioClient.putObject.mock.calls[0];
    expect(bucket).toBe("autoflow-logs");
    expect(objKey).toBe(key);
    expect(gunzipSync(body).toString("utf-8")).toBe("hello\nworld");
    expect(size).toBe(body.length);
    expect(meta["Content-Encoding"]).toBe("gzip");
  });

  it("creates the bucket once when missing", async () => {
    minioClient.bucketExists.mockResolvedValue(false);
    const s = storage();
    await s.put("exec-1", "a");
    await s.put("exec-2", "b");
    expect(minioClient.makeBucket).toHaveBeenCalledTimes(1);
  });

  it("retries bucket creation after a failure", async () => {
    minioClient.bucketExists
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(true);
    const s = storage();
    await expect(s.put("exec-1", "a")).rejects.toThrow("down");
    await expect(s.put("exec-2", "b")).resolves.toBe(
      "execution-logs/exec-2.log.gz",
    );
  });

  it("get() gunzips the stored object", async () => {
    // split the gzip payload across two chunks to cover the concat path
    const gz = gzipSync(Buffer.from("line1\nline2"));
    minioClient.getObject.mockResolvedValue(
      Readable.from([gz.subarray(0, 5), gz.subarray(5)]),
    );
    const text = await storage().get("execution-logs/exec-1.log.gz");
    expect(text).toBe("line1\nline2");
  });

  it("remove() deletes the object", async () => {
    await storage().remove("k");
    expect(minioClient.removeObject).toHaveBeenCalledWith("autoflow-logs", "k");
  });

  it("put() propagates S3 errors with a readable message and resets the bucket cache", async () => {
    minioClient.bucketExists.mockResolvedValue(true);
    minioClient.putObject.mockRejectedValueOnce(
      Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
    );
    await expect(storage().put("exec-1", "payload")).rejects.toThrow(
      "ECONNREFUSED",
    );
    // The next put should retry ensureBucket (the cached promise was nulled by the catch).
    minioClient.putObject.mockResolvedValueOnce(undefined);
    await expect(storage().put("exec-2", "payload")).resolves.toBe(
      "execution-logs/exec-2.log.gz",
    );
  });

  it("put() surfaces a readable error when the endpoint is unreachable (makeBucket fails)", async () => {
    minioClient.bucketExists.mockResolvedValue(false);
    minioClient.makeBucket.mockRejectedValueOnce(
      Object.assign(new Error("getaddrinfo ENOTFOUND minio"), {
        code: "ENOTFOUND",
      }),
    );
    await expect(storage().put("exec-1", "x")).rejects.toThrow(
      "getaddrinfo ENOTFOUND minio",
    );
  });

  it("get() rejects with a readable error when the object is missing", async () => {
    minioClient.getObject.mockRejectedValueOnce(
      Object.assign(new Error("NoSuchKey"), { code: "NoSuchKey" }),
    );
    await expect(storage().get("missing-key")).rejects.toThrow("NoSuchKey");
  });

  it("remove() rejects when the client cannot reach the server", async () => {
    minioClient.removeObject.mockRejectedValueOnce(
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    );
    await expect(storage().remove("k")).rejects.toThrow("socket hang up");
  });

  it("put() handles multi-megabyte payloads (chunked gzip body)", async () => {
    // 4 MB of repeated text — exercises the chunk concat path inside gzipSync
    // and ensures the stored byte length matches body.length.
    const big = "x".repeat(4 * 1024 * 1024);
    const key = await storage().put("exec-big", big);
    const [, , body, size] = minioClient.putObject.mock.calls[0];
    expect(key).toBe("execution-logs/exec-big.log.gz");
    expect(body.length).toBe(size);
    expect(gunzipSync(body).toString("utf-8").length).toBe(big.length);
  });

  // LOG-11: getStream() is the streaming read path used by the SSE log
  // viewer — its over-cap guard and error propagation semantics must hold
  // independently of the materializing get().
  describe("getStream() bounds and error propagation", () => {
    it("returns a readable stream that yields the gunzipped content", async () => {
      const gz = gzipSync(Buffer.from("chunk-a\nchunk-b"));
      minioClient.getObject.mockResolvedValue(Readable.from([gz]));
      const stream = await storage().getStream("execution-logs/exec-1.log.gz");
      const parts: Buffer[] = [];
      for await (const c of stream) parts.push(c as Buffer);
      expect(Buffer.concat(parts).toString("utf-8")).toBe("chunk-a\nchunk-b");
    });

    // AUTH-05 轮注记：本例在 coverage 全量跑（压测机器 CPU 满载）下偶发
    // 5s 默认超时——gzip 同步压缩 2MB+ 零缓冲与 coverage 插桩叠加拖慢了
    // 流水线。显式放宽到 15s，仅影响测试执行窗，断言本体不变。
    it("rejects when the decompressed payload exceeds MAX_LOG_BYTES (cap transform)", async () => {
      // A valid gzip stream of zeros larger than the cap: the first gunzipped
      // chunk alone crosses MAX_LOG_BYTES, so the running tally guard must
      // fire before the consumer has buffered the whole payload.
      minioClient.getObject.mockResolvedValue(
        Readable.from([gzipSync(Buffer.alloc(MAX_LOG_BYTES + 1))]),
      );
      const stream = await storage().getStream("execution-logs/exec-1.log.gz");
      await expect(async () => {
        for await (const _c of stream) {
          /* drain until the cap transform errors */
        }
      }).rejects.toThrow(/exceeds MAX_LOG_BYTES/);
    }, 15_000);

    it("propagates an S3 read error to the stream consumer (raw error path)", async () => {
      // Simulate a mid-flight storage failure: the raw readable errors after
      // piping has started. The consumer must see the rejection.
      const failing = new Readable({
        read() {
          this.destroy(new Error("S3 socket reset"));
        },
      });
      minioClient.getObject.mockResolvedValue(failing);
      const stream = await storage().getStream("execution-logs/exec-1.log.gz");
      await expect(async () => {
        for await (const _c of stream) {
          /* drain until the raw error surfaces */
        }
      }).rejects.toThrow("S3 socket reset");
    });

    it("propagates a gunzip error for corrupt payloads", async () => {
      // Not a gzip stream — the gunzip transform errors and the consumer
      // sees the rejection instead of an empty body.
      minioClient.getObject.mockResolvedValue(
        Readable.from([Buffer.from("this is not gzip")]),
      );
      const stream = await storage().getStream("execution-logs/exec-1.log.gz");
      await expect(async () => {
        for await (const _c of stream) {
          /* drain until gunzip errors */
        }
      }).rejects.toThrow();
    });
  });

  it("get() rejects when the materialized payload exceeds MAX_LOG_BYTES", async () => {
    // spec 188 行先例），第三参显式放宽到 15s——断言本体不变，仅放宽执行窗。 // coverage 全量并发跑下 gzip 2MB 同步压缩叠加插桩，默认 5s 偶发不足（同
    minioClient.getObject.mockResolvedValue(
      Readable.from([gzipSync(Buffer.alloc(MAX_LOG_BYTES + 1))]),
    );
    await expect(storage().get("execution-logs/exec-1.log.gz")).rejects.toThrow(
      /exceeds MAX_LOG_BYTES/,
    );
  }, 15_000);

  it("get() aggregates content delivered in many small chunks", async () => {
    // The get() loop re-checks its own tally per chunk; several small chunks
    // exercise the per-chunk bytes branch below the cap.
    const gz = gzipSync(Buffer.from("l0\nl1\nl2"));
    const chunks = [gz.subarray(0, 8), gz.subarray(8, 16), gz.subarray(16)];
    minioClient.getObject.mockResolvedValue(Readable.from(chunks));
    const text = await storage().get("execution-logs/exec-1.log.gz");
    expect(text).toBe("l0\nl1\nl2");
  });
});
