import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { ConfigService } from "@nestjs/config";
import { S3LogStorage } from "./s3-log-storage";

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
});
