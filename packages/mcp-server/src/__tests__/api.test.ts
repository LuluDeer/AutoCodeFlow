/**
 * Unit tests for the MCP server HTTP layer: envelope unwrapping and the
 * apiRequest fetch plumbing (path / method / body / Authorization header),
 * with node-fetch mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("node-fetch", () => ({ default: fetchMock }));

import {
  apiRequest,
  unwrap,
  apiGet,
  apiPost,
  apiPut,
  apiDelete,
  REQUEST_TIMEOUT_MS,
} from "../api";
import contract from "../../../contract-fixtures/contract.json";
// R145：已知错误码的「成因 + 下一步」层（api.ts 的 buildHttpError 里接进来）。
import { BACKEND_ERROR_HINTS, formatBackendErrorHint } from "../error-hints";
import { registerTaskTools, withStructuredToolErrors } from "../tools";

function jsonResponse(ok: boolean, body: unknown, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    jsonResponse(true, { code: 0, message: "success", data: null }),
  );
});

describe("unwrap", () => {
  it("strips the { code, message, data } envelope", () => {
    expect(unwrap({ code: 0, message: "ok", data: { a: 1 } })).toEqual({
      a: 1,
    });
  });

  it("unwraps code 0 too — 0 is a valid numeric code (full-shape entity edge)", () => {
    expect(unwrap({ code: 0, message: "y", data: "x", extra: 1 })).toBe("x");
  });

  it("strips an envelope that carries only a numeric code (message optional)", () => {
    expect(unwrap({ code: 200, data: { a: 1 } })).toEqual({ a: 1 });
  });

  it("returns an entity with data+message but no numeric code unchanged (WIKI-OPT-4)", () => {
    // 旧判据 data+(code|message) 会把这种实体误解包截断成 data 值；
    // 收紧后 message 不再作为判据，实体原样透传。
    const entity = { message: "ok", data: [1, 2] };
    expect(unwrap(entity)).toEqual(entity);
  });

  it("passes through non-envelope payloads", () => {
    const raw = { data: "x", extra: 1 };
    expect(unwrap(raw)).toEqual(raw);
    // WIKI-OPT-4: an entity carrying BOTH data and message but no numeric
    // code is no longer mistaken for an envelope — returned as-is instead of
    // being truncated to its data value (the old R4 P3 heuristic edge).
    const entity = { data: "x", message: "y", extra: 1 };
    expect(unwrap(entity)).toEqual(entity);
  });

  it("does not treat a non-numeric code as an envelope", () => {
    // typeof code !== 'number'（如字符串 "200"）→ 不满足信封判据，原样返回。
    const entity = { data: "x", code: "200" };
    expect(unwrap(entity)).toEqual(entity);
  });

  it("maps envelope data:null to null", () => {
    expect(unwrap({ code: 0, message: "ok", data: null })).toBeNull();
  });
});

describe("apiRequest", () => {
  it("sends GET with the Authorization header and unwraps the envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(true, { code: 0, message: "success", data: { id: "t1" } }),
    );
    const result = await apiRequest<{ id: string }>("GET", "/tasks/t1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3105/api/tasks/t1"); // normalizeApiBase：默认 URL 补 /api（TOTP-PTY-smoke 修复）
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toMatch(/^Bearer /);
    expect(result).toEqual({ id: "t1" });
  });

  it("sends POST with a JSON body", async () => {
    await apiRequest("POST", "/tasks/t1/trigger", { params: { a: 1 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3105/api/tasks/t1/trigger");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ params: { a: 1 } });
  });

  it("omits the body entirely when none is given", async () => {
    await apiRequest("GET", "/audit");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBeUndefined();
  });

  it("throws a descriptive error including method, path and status on HTTP errors", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(false, { statusCode: 401, message: "Unauthorized" }, 401),
    );
    // N12: the envelope message is extracted instead of dumping raw JSON.
    await expect(apiRequest("GET", "/audit")).rejects.toThrow(
      /Unauthorized \(401\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// N12: timeout control + envelope error message extraction
// ---------------------------------------------------------------------------
describe("apiRequest timeout (N12)", () => {
  it("passes an AbortSignal with the default 30s budget", async () => {
    await apiRequest("GET", "/tasks");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeDefined();
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it("rejects with a friendly timeout error when the request exceeds the budget", async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_res, rej) => {
          init.signal.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            rej(err);
          });
        }),
    );
    // 注入极短超时，避免测试真等 30s
    await expect(apiRequest("GET", "/slow", undefined, 30)).rejects.toThrow(
      /timed out after 30ms/,
    );
  });

  it("rethrows non-timeout network errors unchanged", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(apiRequest("GET", "/x")).rejects.toThrow("ECONNREFUSED");
  });
});

describe("apiRequest error extraction (N12)", () => {
  it("401: surfaces the envelope message and the token hint", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        false,
        { code: 401, message: "jwt expired", data: null },
        401,
      ),
    );
    await expect(apiRequest("GET", "/tasks")).rejects.toThrow(
      /Unauthorized \(401\): jwt expired.*AUTOCODEFLOW_API_TOKEN/,
    );
  });

  it("403: mentions the ADMIN role requirement", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(false, { code: 403, message: "Forbidden", data: null }, 403),
    );
    await expect(apiRequest("POST", "/executors/e1/install")).rejects.toThrow(
      /Forbidden \(403\): Forbidden.*ADMIN/,
    );
  });

  // 404 也带下一步动作（对齐 401/403 的可恢复性口径）：id 已在 MCP 入站
  // 做过 UUID 白名单校验，404 基本意味着资源不存在/被删——指引 agent 用
  // 对应 list 工具重新解析 id，而不是盲目重试。
  it("404: appends the resolve-id-via-list-tool next step", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(false, { code: 404, message: "Task not found" }, 404),
    );
    await expect(apiRequest("GET", "/tasks/missing")).rejects.toThrow(
      /API error \(404\): Task not found — confirm the resource exists; resolve the ID with the matching list_\* tool/,
    );
  });

  it("400: joins class-validator message arrays", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        false,
        {
          statusCode: 400,
          message: ["name should not be empty", "runtime must be a string"],
        },
        400,
      ),
    );
    await expect(apiRequest("POST", "/tasks")).rejects.toThrow(
      /API error \(400\): name should not be empty; runtime must be a string/,
    );
  });

  it("falls back to the raw text when the body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
      text: async () => "Bad Gateway from nginx",
    });
    await expect(apiRequest("GET", "/tasks")).rejects.toThrow(
      /API GET \/tasks → 502: Bad Gateway from nginx/,
    );
  });

  it("falls back to raw text when JSON parses but carries no message", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(false, { timestamp: "2026-01-01", path: "/tasks" }, 500),
    );
    await expect(apiRequest("GET", "/tasks")).rejects.toThrow(
      /API GET \/tasks → 500/,
    );
  });
});

describe("method helpers", () => {
  it("apiGet / apiPost / apiPut / apiDelete use the right verbs", async () => {
    await apiGet("/x");
    await apiPost("/y", { k: 1 });
    await apiPut("/z", { k: 2 });
    await apiDelete("/w");
    expect(fetchMock.mock.calls.map((c) => c[1].method)).toEqual([
      "GET",
      "POST",
      "PUT",
      "DELETE",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ k: 1 });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ k: 2 });
    expect(fetchMock.mock.calls[3][1].body).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// BUG-14: 401 单飞刷新自愈（长驻 MCP 进程，access token 15m 过期）
// ---------------------------------------------------------------------------

describe("401 refresh self-heal (BUG-14)", () => {
  beforeEach(() => {
    vi.stubEnv("AUTOCODEFLOW_API_REFRESH_TOKEN", "env-refresh");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("on 401 with a refresh token: POSTs /auth/refresh once and replays the request", async () => {
    fetchMock
      // 第一次业务请求 401
      .mockResolvedValueOnce(
        jsonResponse(false, { message: "jwt expired" }, 401),
      )
      // 刷新成功（原子轮换返回新双 token）
      .mockResolvedValueOnce(
        jsonResponse(
          true,
          {
            code: 0,
            message: "success",
            data: { accessToken: "new-access", refreshToken: "new-refresh" },
          },
          201,
        ),
      )
      // 重放成功
      .mockResolvedValueOnce(
        jsonResponse(true, { code: 0, message: "success", data: { ok: 1 } }),
      );

    const result = await apiGet<{ ok: number }>("/tasks");

    expect(result).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [refreshUrl, refreshInit] = fetchMock.mock.calls[1];
    // P1-4 回归：必须带 `/api` 前缀（admin-api 的全局前缀）——此前固定的是
    // 裸 `${API_URL}/auth/refresh`，默认配置下恒 404，自愈永久失效。
    expect(String(refreshUrl)).toMatch(/\/api\/auth\/refresh$/);
    expect(JSON.parse(String(refreshInit.body))).toEqual({
      refreshToken: "env-refresh",
    });
    // 重放请求携带换发后的新 token
    const [replayUrl, replayInit] = fetchMock.mock.calls[2];
    expect(replayUrl).not.toContain("/auth/");
    expect((replayInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer new-access",
    );
  });

  it("keeps the rotated refresh token in memory for the next expiry (process-lifetime self-heal)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(false, { message: "jwt expired" }, 401),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          true,
          {
            code: 0,
            message: "success",
            data: { accessToken: "a2", refreshToken: "r2" },
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(true, { code: 0, message: "success", data: { ok: 1 } }),
      )
      // 第二轮过期：必须用内存中轮换后的 r2（不是 env 里的 env-refresh）
      .mockResolvedValueOnce(
        jsonResponse(false, { message: "jwt expired" }, 401),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          true,
          {
            code: 0,
            message: "success",
            data: { accessToken: "a3", refreshToken: "r3" },
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(true, { code: 0, message: "success", data: { ok: 2 } }),
      );

    await apiGet("/tasks");
    await apiGet("/tasks");

    expect(fetchMock).toHaveBeenCalledTimes(6);
    const secondRefreshBody = JSON.parse(
      String(fetchMock.mock.calls[4][1].body),
    );
    expect(secondRefreshBody).toEqual({ refreshToken: "r2" });
  });

  it("without a refresh token: fails with the 401 error as before", async () => {
    // 本用例要求"全新进程"语义（currentRefreshToken 为空）。同文件前序用例
    // 的轮换会把模块级内存 token 污染为 'r3'，refreshAccessToken 的
    // `currentRefreshToken || envRefresh` 会短路 env 判空——用 resetModules
    // + 动态导入取一个干净模块实例（vi.mock('node-fetch') 对新导入仍生效）。
    vi.stubEnv("AUTOCODEFLOW_API_REFRESH_TOKEN", "");
    vi.resetModules();
    const fresh = await import("../api");
    fetchMock.mockResolvedValueOnce(
      jsonResponse(false, { message: "jwt expired" }, 401),
    );

    await expect(fresh.apiGet("/tasks")).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when the 401 comes from an /auth/* path", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(false, { message: "Invalid credentials" }, 401),
    );

    await expect(
      apiPost("/auth/login", { username: "u", password: "p" }),
    ).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on 403 — forbidden is an authorization failure, not token expiry", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(false, { message: "Forbidden" }, 403),
    );

    await expect(apiPost("/executors/e1/install")).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes("/auth/refresh")),
    ).toBe(false);
  });

  it("does not send the expired access token to /auth/refresh", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(false, { message: "jwt expired" }, 401),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          true,
          {
            code: 0,
            message: "success",
            data: { accessToken: "new-access", refreshToken: "new-refresh" },
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(true, { code: 0, message: "success", data: { ok: 1 } }),
      );

    await apiGet("/tasks");

    const [, refreshInit] = fetchMock.mock.calls[1];
    expect(refreshInit.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("refresh failure surfaces the original 401 error", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(false, { message: "jwt expired" }, 401),
      )
      .mockResolvedValueOnce(
        jsonResponse(false, { message: "refresh token expired" }, 401),
      );

    await expect(apiGet("/tasks")).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("concurrent 401s share a single refresh flight", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(false, { message: "jwt expired" }, 401),
      )
      .mockResolvedValueOnce(
        jsonResponse(false, { message: "jwt expired" }, 401),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          true,
          {
            code: 0,
            message: "success",
            data: { accessToken: "new-access", refreshToken: "new-refresh" },
          },
          201,
        ),
      )
      .mockResolvedValue(
        jsonResponse(true, { code: 0, message: "success", data: { ok: 1 } }),
      );

    await Promise.all([apiGet("/tasks"), apiGet("/executors")]);

    expect(
      fetchMock.mock.calls.filter(([u]) => String(u).includes("/auth/refresh")),
    ).toHaveLength(1);
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
    // full-shape 向量带 code:0（数值）——WIKI-OPT-4 收紧判据后仍被解包，
    // 与 fixture 文档一致；实体不得同时携带 code+message+data 三键的结论不变。
    expect(unwrap(contract.knownHeuristicEdge.raw)).toEqual(
      contract.knownHeuristicEdge.unwrapped,
    );
  });

  it("knownDivergence: mcp tightened to numeric-code unwrap — data+message without code is preserved (aligns with node/py-sdk)", () => {
    // WIKI-OPT-4：mcp 弃用 fixture 记录的 data+(code|message) 宽松判据
    // （cli_mcp_unwrapped 描述的是 cli 侧旧行为），改为数值 code 判据——
    // 该向量在 mcp 侧原样保留，与 node/py 语义一致。fixture 为 append-only
    // 共享契约，故用其 node_py 向量断言 mcp 的新行为。
    expect(unwrap(contract.knownDivergence.raw)).toEqual(
      contract.knownDivergence.node_py_unwrapped_preserved,
    );
  });

  it("error-body vectors yield the documented detail (extractDetail order: message > message[] > error)", async () => {
    for (const v of contract.errorBody) {
      // extractDetail/buildHttpError 未导出——经 apiRequest 的可见错误路径断言同一提取顺序。
      fetchMock.mockResolvedValueOnce(jsonResponse(false, v.raw, 400));
      if (v.detail) {
        await expect(apiRequest("GET", "/tasks")).rejects.toThrow(v.detail);
      } else {
        await expect(apiRequest("GET", "/tasks")).rejects.toThrow(/400/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// R31-E2: 稳定错误码透出（admin-api 错误体 { code, message, errorCode, params }）
// ---------------------------------------------------------------------------
describe("R31-E2 errorCode / params passthrough", () => {
  /** 抓住 apiRequest 抛出的错误（保留 Error 实例与挂载字段）。 */
  async function captureError(): Promise<Error & Record<string, unknown>> {
    try {
      await apiRequest("GET", "/tasks");
    } catch (e) {
      return e as Error & Record<string, unknown>;
    }
    throw new Error("expected apiRequest to reject");
  }

  it("attaches errorCode and params to the thrown Error, message unchanged", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        false,
        {
          code: 404,
          message: "任务不存在",
          errorCode: "TASK_NOT_FOUND",
          params: { taskId: "t-1" },
        },
        404,
      ),
    );
    const err = await captureError();
    // 既有文案逐字节不变（含 MCP 专属的 404 下一步提示）
    expect(err.message).toBe(
      "API error (404): 任务不存在 — confirm the resource exists; resolve the ID with the matching list_* tool and retry",
    );
    expect(err.errorCode).toBe("TASK_NOT_FOUND");
    expect(err.params).toEqual({ taskId: "t-1" });
    expect(err).toBeInstanceOf(Error);
  });

  it("只读挂载：外部赋值不改变已挂的码", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(false, { code: 409, message: "冲突", errorCode: "TASK_NAME_CONFLICT" }, 409),
    );
    const err = await captureError();
    expect(() => {
      (err as Record<string, unknown>).errorCode = "HACKED";
    }).toThrow(TypeError);
    expect(err.errorCode).toBe("TASK_NAME_CONFLICT");
  });

  it("无码 / 无参时对象形状与旧行为完全一致（键不存在）", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(false, { code: 500, message: "内部错误" }, 500),
    );
    const err = await captureError();
    expect("errorCode" in err).toBe(false);
    expect("params" in err).toBe(false);
    expect(err.message).toBe("API error (500): 内部错误");
  });

  it("params 非普通对象 / errorCode 非字符串 → 丢弃（不写 undefined 键）", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        false,
        { code: 400, message: "参数错", errorCode: 42, params: ["a", "b"] },
        400,
      ),
    );
    const err = await captureError();
    expect("errorCode" in err).toBe(false);
    expect("params" in err).toBe(false);
    expect(err.message).toBe("API error (400): 参数错");
  });

  it("非 JSON 错误体：既有原始文本兜底不变，且不产生机读键", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(false, "<html>bad gateway</html>", 502),
    );
    const err = await captureError();
    expect(err.message).toBe("API GET /tasks → 502: <html>bad gateway</html>");
    expect("errorCode" in err).toBe(false);
    expect("params" in err).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R145：已知错误码 → 成因 + 下一步（error-hints.ts，接在 buildHttpError 里）
//
// ## 这三条用例各自钉住什么（有反证）
//
// ① **409 `TASK_FIRE_POINT_ALREADY_CONSUMED`** ⇒ 文本里出现「成因」（已有一条未消耗的
//    登记）与「下一步」（到点自动清 / 改 cron 清 / 普通触发不清），而不是只有
//    `API error (409): …`。
// ② **400 `TASK_FIRE_POINT_NOT_CRON`**（以及同族的 `_UNRESOLVABLE`）⇒ 同上：说清
//    「只有 cron 有落点」并给出「去掉入参」或「改成 cron」两条出路。
// ③ **未知码 / 无码 ⇒ 逐字节不变**：这是本层**不许**越界的地方。既有用例把旧文案
//    钉死了，若新映射顺手改写未知码，那些用例会全红——但更糟的是反方向：如果这里
//    不写死「未知码原样」，将来某次"优化查表"把未知码也吞进默认分支就没人发现。
//
// ## 为什么断言片段而不是整句
//
// 文案会随措辞调整；把整句钉住只会让「改一个副词」变成改测试。这里钉的是**语义锚点**：
// `cause:` / `next:` 两个标签 + 关键事实（cron、未消耗、update_task、WITHOUT …）。
// ---------------------------------------------------------------------------
describe("R145 已知错误码 ⇒ 成因 + 处置建议（未知码不动）", () => {
  /** 走一次 trigger（body 带 consumeNextFirePoint），抓住抛出的错误。 */
  async function captureTriggerError(): Promise<Error & Record<string, unknown>> {
    try {
      await apiRequest("POST", "/tasks/t-1/trigger", { consumeNextFirePoint: true });
    } catch (e) {
      return e as Error & Record<string, unknown>;
    }
    throw new Error("expected apiRequest to reject");
  }

  it("① 409 TASK_FIRE_POINT_ALREADY_CONSUMED：含成因、登记的落点与‘不要重发’的下一步", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        false,
        {
          code: 409,
          message: "该任务已有一条未消耗的计划落点登记",
          errorCode: "TASK_FIRE_POINT_ALREADY_CONSUMED",
          params: { firePointAt: "2026-11-08T01:00:00.000Z" },
        },
        409,
      ),
    );
    const err = await captureTriggerError();
    const text = err.message;

    // 既有骨架保留（不是把 HTTP 状态换掉，而是在它之上补）
    expect(text.startsWith("API error (409): ")).toBe(true);
    // 码本身可搜（用户报障时贴一行就够）
    expect(text).toContain("TASK_FIRE_POINT_ALREADY_CONSUMED");
    // 成因
    expect(text).toContain("cause:");
    expect(text).toContain("unconsumed fire-point registration");
    expect(text).toContain("2026-11-08T01:00:00.000Z");
    // 下一步（三条消解路径：到点自动清 / 改 cron 清 / 普通触发不清）
    expect(text).toContain("next:");
    expect(text).toContain("WITHOUT consumeNextFirePoint");
    expect(text).toContain("update_task");
    // 机读面照旧（结构化字段不因文案增强而丢失）
    expect(err.errorCode).toBe("TASK_FIRE_POINT_ALREADY_CONSUMED");
    expect(err.params).toEqual({ firePointAt: "2026-11-08T01:00:00.000Z" });
  });

  it("② 400 TASK_FIRE_POINT_NOT_CRON：说清‘只有 cron 有落点’并给出两条出路", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        false,
        {
          code: 400,
          message: "只有 cron 任务可以消耗计划落点",
          errorCode: "TASK_FIRE_POINT_NOT_CRON",
          params: { triggerType: "fixed_rate" },
        },
        400,
      ),
    );
    const text = (await captureTriggerError()).message;

    expect(text.startsWith("API error (400): ")).toBe(true);
    expect(text).toContain("[TASK_FIRE_POINT_NOT_CRON · validation]");
    expect(text).toContain("only cron tasks have scheduled fire points");
    // 后端 params 被如实带进成因（不是又一句泛泛的报错）
    expect(text).toContain('"fixed_rate"');
    expect(text).toContain("next:");
    expect(text).toContain("update_task");
    // 反证锚点：重复同一请求不会变好，必须明说
    expect(text).toContain("same way");
  });

  it("② 400 TASK_FIRE_POINT_UNRESOLVABLE：说清‘算不出落点’并指向 cronExpression", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        false,
        {
          code: 400,
          message: "无法计算下一个计划落点",
          errorCode: "TASK_FIRE_POINT_UNRESOLVABLE",
          params: { cronExpression: "not-a-cron" },
        },
        400,
      ),
    );
    const text = (await captureTriggerError()).message;

    expect(text).toContain("TASK_FIRE_POINT_UNRESOLVABLE");
    expect(text).toContain("cannot be computed");
    expect(text).toContain('"not-a-cron"');
    expect(text).toContain("next:");
    expect(text).toContain("cronExpression");
  });

  it("③ 未知错误码：既有文案一字不改，码仍透传", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        false,
        { code: 400, message: "参数错", errorCode: "TASK_SOMETHING_UNKNOWN" },
        400,
      ),
    );
    const err = await captureTriggerError();
    expect(err.message).toBe("API error (400): 参数错");
    expect(err.message).not.toContain("cause:");
    expect(err.errorCode).toBe("TASK_SOMETHING_UNKNOWN");
  });

  it("③ 真实但不在本表里的 409 码：同样一字不改（不做全量码表的直接后果）", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        false,
        {
          code: 409,
          message: "冲突",
          errorCode: "TASK_TRIGGER_CONCURRENT",
          params: { name: "nightly" },
        },
        409,
      ),
    );
    const err = await captureTriggerError();
    expect(err.message).toBe("API error (409): 冲突");
  });

  it("③ formatBackendErrorHint：空串 / 非字符串 / 原型键 ⇒ null（不把 constructor 当已知码）", () => {
    expect(formatBackendErrorHint(undefined)).toBeNull();
    expect(formatBackendErrorHint("")).toBeNull();
    expect(formatBackendErrorHint(42)).toBeNull();
    expect(formatBackendErrorHint("constructor")).toBeNull();
    expect(formatBackendErrorHint("toString")).toBeNull();
  });

  it("分类口径与 CLI 一致：两条 400 属 validation，409 属 conflict", () => {
    expect(BACKEND_ERROR_HINTS.TASK_FIRE_POINT_NOT_CRON.category).toBe("validation");
    expect(BACKEND_ERROR_HINTS.TASK_FIRE_POINT_UNRESOLVABLE.category).toBe("validation");
    expect(BACKEND_ERROR_HINTS.TASK_FIRE_POINT_ALREADY_CONSUMED.category).toBe("conflict");
  });
});

// ---------------------------------------------------------------------------
// R145 端到端：模型真正读到的那层文本（withStructuredToolErrors 的 text = err.message）
// ---------------------------------------------------------------------------
describe("R145 端到端：trigger_task 被拒时模型读到的文本", () => {
  const UUID = "33333333-3333-4333-8333-333333333333";

  function setupWrapped() {
    const registered = new Map<
      string,
      {
        handler: (args: Record<string, unknown>) => Promise<{
          content: Array<{ type: string; text: string }>;
          isError?: boolean;
          structuredContent?: Record<string, unknown>;
        }>;
      }
    >();
    const fakeServer = {
      tool: (
        name: string,
        _description: string,
        _schema: Record<string, unknown>,
        fourth: unknown,
        fifth?: unknown,
      ) => {
        registered.set(name, { handler: (fifth ?? fourth) as never });
      },
    };
    const wrapped = withStructuredToolErrors(fakeServer as never);
    registerTaskTools(wrapped as never, apiRequest);
    return registered;
  }

  it("409 已知码 ⇒ content[0].text 含成因与处置，isError + structuredContent 都在", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        false,
        {
          code: 409,
          message: "该任务已有一条未消耗的计划落点登记",
          errorCode: "TASK_FIRE_POINT_ALREADY_CONSUMED",
          params: { firePointAt: "2026-11-08T01:00:00.000Z" },
        },
        409,
      ),
    );
    const registered = setupWrapped();
    const result = await registered
      .get("trigger_task")!
      .handler({ taskId: UUID, consumeNextFirePoint: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unconsumed fire-point registration");
    expect(result.content[0].text).toContain("next:");
    expect(result.structuredContent).toEqual({
      errorCode: "TASK_FIRE_POINT_ALREADY_CONSUMED",
      params: { firePointAt: "2026-11-08T01:00:00.000Z" },
    });
  });

  it("未知码 ⇒ 模型读到的文本与旧行为逐字节一致", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        false,
        { code: 400, message: "参数错", errorCode: "TASK_SOMETHING_UNKNOWN" },
        400,
      ),
    );
    const registered = setupWrapped();
    const result = await registered.get("trigger_task")!.handler({ taskId: UUID });

    expect(result.content[0].text).toBe("API error (400): 参数错");
    expect(result.structuredContent).toEqual({ errorCode: "TASK_SOMETHING_UNKNOWN" });
  });
});
