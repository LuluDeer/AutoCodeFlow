import {
  buildExecutorConfigPayload,
  computeExecutorConfigFingerprint,
} from "../executor-config-fingerprint.util";

/**
 * R12-fix（pull-mode 自检根因）：`app.adminApiUrl` 未配置时 payload 必须
 * **省略**该字段而非下发 ""。空字符串会让执行器 /config/reload 把 admin
 * client 列表重建为 []，pull 长轮询/心跳从此永久失败（retryCount=0 →
 * "Request failed after all retries"），执行器被误判 OFFLINE。
 */

function makeConfig(adminApiUrl?: string): { get: <T>(k: string) => T | undefined } {
  return {
    get: <T>(key: string): T | undefined => {
      if (key === "executor.heartbeatInterval") return 30_000 as T;
      if (key === "app.adminApiUrl") return (adminApiUrl ?? "") as T;
      return undefined;
    },
  };
}

describe("buildExecutorConfigPayload — adminApiUrl omission (R12-fix)", () => {
  it("omits adminApiUrl when app.adminApiUrl is not configured", () => {
    const payload = buildExecutorConfigPayload(
      makeConfig(undefined) as never,
      { maxConcurrentTasks: 4 },
    );
    expect(payload.adminApiUrl).toBeUndefined();
    expect(payload.maxConcurrentTasks).toBe(4);
    expect(payload.heartbeatIntervalSeconds).toBe(30);
  });

  it("omits adminApiUrl when app.adminApiUrl is an empty string", () => {
    const payload = buildExecutorConfigPayload(
      makeConfig("") as never,
      { maxConcurrentTasks: 4 },
    );
    expect(payload.adminApiUrl).toBeUndefined();
  });

  it("includes adminApiUrl when configured", () => {
    const payload = buildExecutorConfigPayload(
      makeConfig("http://admin.example.com:3105") as never,
      { maxConcurrentTasks: 4 },
    );
    expect(payload.adminApiUrl).toBe("http://admin.example.com:3105");
  });

  it("fingerprint is stable across empty vs omitted adminApiUrl", () => {
    const withEmpty = computeExecutorConfigFingerprint(
      makeConfig("") as never,
      { maxConcurrentTasks: 4 },
    );
    const withOmitted = computeExecutorConfigFingerprint(
      makeConfig(undefined) as never,
      { maxConcurrentTasks: 4 },
    );
    expect(withEmpty).toBe(withOmitted);
  });

  it("fingerprint changes when adminApiUrl changes", () => {
    const a = computeExecutorConfigFingerprint(
      makeConfig("http://a.example.com") as never,
      { maxConcurrentTasks: 4 },
    );
    const b = computeExecutorConfigFingerprint(
      makeConfig("http://b.example.com") as never,
      { maxConcurrentTasks: 4 },
    );
    expect(a).not.toBe(b);
  });
});
