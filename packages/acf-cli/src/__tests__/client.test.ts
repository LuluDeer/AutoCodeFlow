/**
 * Unit tests for the CLI HTTP client: envelope unwrapping, method/path
 * plumbing (via a mocked axios instance) and readable error formatting
 * that distinguishes 401 from 403. BUG-13 adds the 401 single-flight
 * refresh self-heal (access token expired → /auth/refresh → replay once).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { axiosInstance, requestInterceptors, responseInterceptors, tokenState } =
  vi.hoisted(() => ({
    axiosInstance: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
    },
    requestInterceptors: { use: vi.fn() },
    responseInterceptors: { use: vi.fn() },
    tokenState: { access: "test-token", refresh: "" },
  }));

vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => ({
      ...axiosInstance,
      interceptors: {
        request: requestInterceptors,
        response: responseInterceptors,
      },
    })),
    post: vi.fn(),
    isAxiosError: (e: unknown) =>
      !!e &&
      typeof e === "object" &&
      (e as { isAxiosError?: boolean }).isAxiosError === true,
  },
}));

vi.mock("../config", () => ({
  getApiUrl: () => "http://localhost:3105",
  getToken: () => tokenState.access,
  getRefreshToken: () => tokenState.refresh,
  setToken: (t: string) => {
    tokenState.access = t;
  },
  setRefreshToken: (t: string) => {
    tokenState.refresh = t;
  },
  clearAuth: () => {
    tokenState.access = "";
    tokenState.refresh = "";
  },
}));

import axios from "axios";
import {
  get,
  post,
  put,
  patch,
  del,
  unwrap,
  resetClient,
  formatApiError,
} from "../client";
import contract from "../../../contract-fixtures/contract.json";

const envelope = (data: unknown) => ({
  data: { code: 0, message: "success", data },
});

beforeEach(() => {
  resetClient();
  vi.clearAllMocks();
  tokenState.access = "test-token";
  tokenState.refresh = "";
});

/** 创建 client（注册拦截器）并取出 response onRejected 回调 */
function getOnRejected(): (err: unknown) => Promise<unknown> {
  axiosInstance.get.mockResolvedValueOnce(envelope(null));
  // mock 就位后再触发 client 创建；probe 请求自消化（唯一注册的 resolved 值）
  void get("/__probe__", {}).catch(() => undefined);
  const onRejected = responseInterceptors.use.mock.calls.at(-1)?.[1];
  expect(typeof onRejected).toBe("function");
  return onRejected as (err: unknown) => Promise<unknown>;
}

describe("unwrap", () => {
  it("strips the { code, message, data } envelope", () => {
    expect(unwrap({ code: 0, message: "ok", data: { a: 1 } })).toEqual({
      a: 1,
    });
  });

  it("strips an envelope that only has data+message", () => {
    expect(unwrap({ message: "ok", data: [1, 2] })).toEqual([1, 2]);
  });

  it("passes through non-envelope payloads", () => {
    const raw = { data: "x", extra: true };
    expect(unwrap(raw)).toEqual(raw);
    expect(unwrap("plain")).toBe("plain");
  });

  it("maps envelope data:null to null", () => {
    expect(unwrap({ code: 0, message: "ok", data: null })).toBeNull();
  });
});

describe("client methods (mocked axios)", () => {
  it("get passes path and params through", async () => {
    axiosInstance.get.mockResolvedValueOnce(envelope({ list: [], total: 0 }));
    const result = await get<{ list: unknown[]; total: number }>("/tasks", {
      page: 1,
      pageSize: 20,
    });
    expect(axiosInstance.get).toHaveBeenCalledWith("/tasks", {
      params: { page: 1, pageSize: 20 },
    });
    expect(result).toEqual({ list: [], total: 0 });
  });

  it("post sends the body and unwraps the envelope", async () => {
    axiosInstance.post.mockResolvedValueOnce(envelope({ id: "a1" }));
    const result = await post<{ id: string }>("/tasks", { name: "n" });
    expect(axiosInstance.post).toHaveBeenCalledWith("/tasks", { name: "n" });
    expect(result).toEqual({ id: "a1" });
  });

  it("put sends the body (application update uses PUT)", async () => {
    axiosInstance.put.mockResolvedValueOnce(envelope({ id: "a1" }));
    const result = await put<{ id: string }>("/applications/a1", {
      version: "2.0.0",
    });
    expect(axiosInstance.put).toHaveBeenCalledWith("/applications/a1", {
      version: "2.0.0",
    });
    expect(result).toEqual({ id: "a1" });
  });

  it("patch sends the body", async () => {
    axiosInstance.patch.mockResolvedValueOnce(envelope({ id: "t1" }));
    await patch("/tasks/t1", { cronExpression: "* * * * *" });
    expect(axiosInstance.patch).toHaveBeenCalledWith("/tasks/t1", {
      cronExpression: "* * * * *",
    });
  });

  it("del sends the path", async () => {
    axiosInstance.delete.mockResolvedValueOnce(envelope(undefined));
    await del("/tasks/t1");
    expect(axiosInstance.delete).toHaveBeenCalledWith("/tasks/t1");
  });
});

// ---------------------------------------------------------------------------
// BUG-13: 401 单飞刷新自愈
// ---------------------------------------------------------------------------

function axiosError(
  status?: number,
  data?: unknown,
  message = "Request failed",
  config?: unknown,
) {
  return {
    isAxiosError: true,
    message,
    ...(status !== undefined ? { response: { status, data } } : {}),
    ...(config !== undefined ? { config } : {}),
  };
}

describe("401 refresh self-heal (BUG-13)", () => {
  const retriable401 = () =>
    axiosError(
      401,
      { message: "jwt expired" },
      "Request failed with status code 401",
      {
        url: "/tasks",
        headers: { Authorization: "Bearer test-token" },
      },
    );

  it("on 401 with a stored refresh token: refreshes once and replays the request", async () => {
    const onRejected = getOnRejected();
    tokenState.refresh = "refresh-token";

    (axios.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      envelope({ accessToken: "new-access", refreshToken: "new-refresh" }),
    );
    axiosInstance.request.mockResolvedValueOnce(envelope({ ok: true }));

    const result = (await onRejected(retriable401())) as { data: unknown };

    // 单飞刷新：POST {base}/auth/refresh，双 token 均换发入库
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      "http://localhost:3105/auth/refresh",
      { refreshToken: "refresh-token" },
      expect.objectContaining({ timeout: 10_000 }),
    );
    expect(tokenState.access).toBe("new-access");
    expect(tokenState.refresh).toBe("new-refresh");
    // 原请求经 instance.request 重放（request 拦截器会重写 Authorization）
    expect(axiosInstance.request).toHaveBeenCalledTimes(1);
    expect(axiosInstance.request.mock.calls[0][0]).toMatchObject({
      url: "/tasks",
    });
    expect(result).toEqual(envelope({ ok: true }));
  });

  it("refresh failure wipes local credentials and rethrows (no replay)", async () => {
    const onRejected = getOnRejected();
    tokenState.refresh = "stale-refresh";

    (axios.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("401 on refresh"),
    );

    await expect(onRejected(retriable401())).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(tokenState.access).toBe("");
    expect(tokenState.refresh).toBe("");
    expect(axiosInstance.request).not.toHaveBeenCalled();
  });

  it("without a stored refresh token: fails fast without calling /auth/refresh", async () => {
    const onRejected = getOnRejected();

    await expect(onRejected(retriable401())).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(axios.post).not.toHaveBeenCalled();
    expect(axiosInstance.request).not.toHaveBeenCalled();
  });

  it("does not refresh for /auth/* paths (login failure is not token expiry)", async () => {
    const onRejected = getOnRejected();
    tokenState.refresh = "refresh-token";

    const err = axiosError(401, { message: "Invalid credentials" }, "401", {
      url: "/auth/login",
      headers: {},
    });
    await expect(onRejected(err)).rejects.toBeTruthy();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("concurrent 401s share a single refresh flight, each replays", async () => {
    const onRejected = getOnRejected();
    tokenState.refresh = "refresh-token";

    (axios.post as ReturnType<typeof vi.fn>).mockResolvedValue(
      envelope({ accessToken: "new-access", refreshToken: "new-refresh" }),
    );
    axiosInstance.request.mockResolvedValue(envelope({ ok: true }));

    const errA = axiosError(401, undefined, "401", {
      url: "/tasks",
      headers: {},
    });
    const errB = axiosError(401, undefined, "401", {
      url: "/executors",
      headers: {},
    });
    await Promise.all([onRejected(errA), onRejected(errB)]);

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axiosInstance.request).toHaveBeenCalledTimes(2);
  });

  it("non-401 errors are rethrown untouched (DR-06: no business retry)", async () => {
    const onRejected = getOnRejected();
    tokenState.refresh = "refresh-token";

    const err = axiosError(500, { message: "boom" }, "500", {
      url: "/tasks",
      headers: {},
    });
    await expect(onRejected(err)).rejects.toBe(err);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe("formatApiError", () => {
  it("401 → tells the user to log in", () => {
    const msg = formatApiError(axiosError(401, { message: "Unauthorized" }));
    expect(msg).toContain("401");
    expect(msg).toContain("acf login");
  });

  it("401 without detail still gets a readable hint", () => {
    const msg = formatApiError(axiosError(401));
    expect(msg).toContain("Unauthorized");
    expect(msg).toContain("acf login");
  });

  it("403 → distinguishes permission problem from bad token", () => {
    const msg = formatApiError(
      axiosError(403, { message: "Forbidden resource" }),
    );
    expect(msg).toContain("403");
    expect(msg).toContain("Forbidden");
    expect(msg).not.toContain("acf login");
  });

  it("403 default hint mentions the ADMIN role requirement", () => {
    const msg = formatApiError(axiosError(403));
    expect(msg).toContain("ADMIN");
  });

  it("400 surfaces the backend message", () => {
    const msg = formatApiError(
      axiosError(400, { message: "property name should not exist" }),
    );
    expect(msg).toContain("400");
    expect(msg).toContain("property name should not exist");
  });

  it("400 joins class-validator message arrays", () => {
    const msg = formatApiError(
      axiosError(400, {
        message: ["name must be a string", "version should not be empty"],
      }),
    );
    expect(msg).toContain("name must be a string; version should not be empty");
  });

  it("404 / 409 get their own labels", () => {
    expect(
      formatApiError(axiosError(404, { message: "Task not found" })),
    ).toContain("not found");
    expect(
      formatApiError(axiosError(409, { message: "already exists" })),
    ).toContain("Conflict");
  });

  it("other statuses keep the backend detail", () => {
    const msg = formatApiError(axiosError(500, { message: "boom" }));
    expect(msg).toContain("500");
    expect(msg).toContain("boom");
  });

  it("network errors mention the API URL", () => {
    const msg = formatApiError(
      axiosError(undefined, undefined, "getaddrinfo ENOTFOUND"),
    );
    expect(msg).toContain("Network error");
    expect(msg).toContain("http://localhost:3105");
  });

  it("non-axios errors pass their message through", () => {
    expect(formatApiError(new Error("plain failure"))).toBe("plain failure");
    expect(formatApiError("raw string")).toBe("raw string");
  });
});

// ---------------------------------------------------------------------------
// QA-07 共享契约向量（packages/contract-fixtures/contract.json 单一事实源）
// ---------------------------------------------------------------------------
describe("contract-fixtures (QA-07 shared vectors)", () => {
  it("envelope vectors unwrap to the documented payload", () => {
    for (const [name, v] of Object.entries(contract.envelope)) {
      expect(unwrap((v as any).raw), `envelope.${name}`).toEqual(
        (v as any).unwrapped,
      );
    }
  });

  it("passthrough vectors are returned unchanged", () => {
    for (const [name, v] of Object.entries(contract.passthrough)) {
      expect(unwrap((v as any).raw), `passthrough.${name}`).toEqual(
        (v as any).unwrapped,
      );
    }
  });

  it("knownHeuristicEdge behaves exactly as documented", () => {
    expect(unwrap(contract.knownHeuristicEdge.raw)).toEqual(
      contract.knownHeuristicEdge.unwrapped,
    );
  });

  it("knownDivergence: cli/mcp loose heuristic unwraps data+message without code (flagged for unification)", () => {
    expect(unwrap(contract.knownDivergence.raw)).toEqual(
      contract.knownDivergence.cli_mcp_unwrapped,
    );
  });

  it("error-body vectors yield the documented detail via detailFromData semantics", () => {
    // detailFromData 未导出——经由 formatApiError 的可见行为断言同一提取顺序
    //（status 从向量 statusCode/errorBody 语境取，而非固定 400）。
    for (const v of contract.errorBody) {
      const status =
        (v.raw as { statusCode?: number; code?: number }).statusCode ??
        (v.raw as { code?: number }).code ??
        400;
      const msg = formatApiError(axiosError(status, v.raw));
      if (v.detail) expect(msg).toContain(v.detail);
      else expect(msg).not.toMatch(/undefined/);
    }
  });
});
