import type { Request } from "express";
import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import {
  extractJwtFromRequest,
  JwtStrategy,
  SSE_QUERY_TOKEN_PARAM,
} from "../strategies/jwt.strategy";

/**
 * P1-6: EventSource cannot send Authorization headers, so the SSE log stream
 * may carry the JWT as ?access_token=... The extractor must accept a query
 * token ONLY on the log-stream path and fall back to the bearer header
 * everywhere else.
 */
const makeReq = (partial: Partial<Record<string, any>>): Request =>
  partial as unknown as Request;

const STREAM_PATH = "/api/tasks/some-task-id/executions/exec-1/logs/stream";

describe("jwt.strategy — extractJwtFromRequest (P1-6 SSE query token)", () => {
  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  it("extracts access_token from the query on a /logs/stream path", () => {
    const req = makeReq({
      headers: {},
      originalUrl: `${STREAM_PATH}?access_token=jwt-value`,
      query: { [SSE_QUERY_TOKEN_PARAM]: "jwt-value" },
    });
    expect(extractJwtFromRequest(req)).toBe("jwt-value");
  });

  it("extracts access_token when the URL is path-only (query parsed off by passport)", () => {
    const req = makeReq({
      headers: {},
      originalUrl: STREAM_PATH,
      url: STREAM_PATH,
      query: { [SSE_QUERY_TOKEN_PARAM]: "jwt-value" },
    });
    expect(extractJwtFromRequest(req)).toBe("jwt-value");
  });

  it("rejects query token on non-stream paths (returns null without Authorization header)", () => {
    const req = makeReq({
      headers: {},
      originalUrl: "/api/tasks?access_token=jwt-value",
      query: { [SSE_QUERY_TOKEN_PARAM]: "jwt-value" },
    });
    expect(extractJwtFromRequest(req)).toBeNull();
  });

  it("rejects query token on nested task-detail paths", () => {
    const req = makeReq({
      headers: {},
      originalUrl: "/api/tasks/abc/executions?access_token=jwt-value",
      query: { [SSE_QUERY_TOKEN_PARAM]: "jwt-value" },
    });
    expect(extractJwtFromRequest(req)).toBeNull();
  });

  it("does not treat a stream-looking query value on a plain GET as stream access when path differs", () => {
    // /logs/streaming does NOT end with /logs/stream
    const req = makeReq({
      headers: {},
      originalUrl: "/api/tasks/a/executions/b/logs/streaming?access_token=x",
      query: { [SSE_QUERY_TOKEN_PARAM]: "x" },
    });
    expect(extractJwtFromRequest(req)).toBeNull();
  });

  it("prefers the Authorization bearer header over the query parameter", () => {
    const req = makeReq({
      headers: { authorization: "Bearer header-token" },
      originalUrl: `${STREAM_PATH}?access_token=query-token`,
      query: { [SSE_QUERY_TOKEN_PARAM]: "query-token" },
    });
    expect(extractJwtFromRequest(req)).toBe("header-token");
  });

  it("returns null when neither header nor (on stream paths) a non-empty query token is present", () => {
    const req = makeReq({
      headers: {},
      originalUrl: STREAM_PATH,
      query: {},
    });
    expect(extractJwtFromRequest(req)).toBeNull();
  });

  it("ignores a non-string query value", () => {
    const req = makeReq({
      headers: {},
      originalUrl: STREAM_PATH,
      query: { [SSE_QUERY_TOKEN_PARAM]: ["array"] },
    });
    expect(extractJwtFromRequest(req)).toBeNull();
  });

  it("does not throw on a request without url/originalUrl", () => {
    const req = makeReq({ headers: {} });
    expect(extractJwtFromRequest(req)).toBeNull();
  });

  // FEAT-16：/executions/stream（执行列表终态推送流）加入 query-token 白名单
  it("accepts access_token on the /executions/stream SSE path (FEAT-16)", () => {
    const req = makeReq({
      headers: {},
      originalUrl: "/api/executions/stream?access_token=jwt-value",
      query: { [SSE_QUERY_TOKEN_PARAM]: "jwt-value" },
    });
    expect(extractJwtFromRequest(req)).toBe("jwt-value");
  });

  it("still rejects query token on other /executions subpaths", () => {
    const req = makeReq({
      headers: {},
      originalUrl: "/api/executions/all?access_token=jwt-value",
      query: { [SSE_QUERY_TOKEN_PARAM]: "jwt-value" },
    });
    expect(extractJwtFromRequest(req)).toBeNull();
  });
});

// ─── WIKI-AUTH-REVOC: 会话版本校验（validate） ─────────────────────────────
// ver 是签发时刻 sessionVersion 的快照；logout/改密会把库中版本原子 +1，
// 快照失配即「会话已撤销」。存量旧令牌无 ver claim → 兼容放行。
describe("jwt.strategy — validate 会话版本（WIKI-AUTH-REVOC）", () => {
  const buildStrategy = () => {
    // R-04: validate 消费 findByIdOrNull（null = 用户已删除）——mock 同时
    // 保留 findById 并令其抛 404：若实现回退到 findById，用例会以
    // NotFoundException（404）而非 UnauthorizedException（401）失败，
    // 精确钉住「401 而非 404」的存在性泄漏语义。
    const usersService = {
      findById: jest.fn().mockImplementation((id: number) => {
        throw new NotFoundException(`User #${id} not found`);
      }),
      findByIdOrNull: jest.fn(),
    };
    const configService = {
      get: jest.fn().mockReturnValue("unit-test-secret"),
    };
    const strategy = new JwtStrategy(
      configService as never,
      usersService as never,
    );
    return { strategy, usersService };
  };

  const activeUser = (sessionVersion: number) => ({
    id: 1,
    username: "alice",
    isActive: true,
    sessionVersion,
  });

  it("ver 与库中 sessionVersion 匹配 → 放行", async () => {
    const { strategy, usersService } = buildStrategy();
    usersService.findByIdOrNull.mockResolvedValue(activeUser(3) as never);

    await expect(
      strategy.validate({
        sub: 1,
        username: "alice",
        type: "access",
        ver: 3,
      }),
    ).resolves.toMatchObject({ id: 1, sessionVersion: 3 });
  });

  it("ver 与库中 sessionVersion 不匹配（logout/改密后）→ 401 Session has been revoked", async () => {
    const { strategy, usersService } = buildStrategy();
    usersService.findByIdOrNull.mockResolvedValue(activeUser(4) as never);

    await expect(
      strategy.validate({
        sub: 1,
        username: "alice",
        type: "access",
        ver: 3,
      }),
    ).rejects.toThrow(new UnauthorizedException("Session has been revoked"));
  });

  it("无 ver claim 的存量旧令牌 → 兼容放行（到期自然失效，不被新逻辑立即打死）", async () => {
    const { strategy, usersService } = buildStrategy();
    usersService.findByIdOrNull.mockResolvedValue(activeUser(0) as never);

    await expect(
      strategy.validate({ sub: 1, username: "alice", type: "access" }),
    ).resolves.toMatchObject({ id: 1 });
  });

  it("isActive 校验仍先于会话版本校验（停用账号维持既有 401 语义）", async () => {
    const { strategy, usersService } = buildStrategy();
    usersService.findByIdOrNull.mockResolvedValue({
      ...activeUser(3),
      isActive: false,
    } as never);

    await expect(
      strategy.validate({
        sub: 1,
        username: "alice",
        type: "access",
        ver: 3,
      }),
    ).rejects.toThrow(new UnauthorizedException("Account is disabled"));
  });

  // R-04: H-3 半修复的收口——已删除用户仍持有效 access token 时必须 401
  //（UnauthorizedException），而不是经 findById 泄漏 404 "User #N not
  // found"（存在性 + 数字 id 泄漏）。findByIdOrNull 返回 null 是唯一取数路径。
  it("R-04: 已删除用户（findByIdOrNull → null）的有效令牌 → 401 User not found，不走 404 的 findById", async () => {
    const { strategy, usersService } = buildStrategy();
    usersService.findByIdOrNull.mockResolvedValue(null as never);

    await expect(
      strategy.validate({
        sub: 1,
        username: "alice",
        type: "access",
        ver: 3,
      }),
    ).rejects.toThrow(new UnauthorizedException("User not found"));
    expect(usersService.findByIdOrNull).toHaveBeenCalledWith(1);
    // 404 泄漏面（findById）必须保持零调用
    expect(usersService.findById).not.toHaveBeenCalled();
  });
});
