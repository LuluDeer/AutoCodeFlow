import type { Request } from "express";
import {
  extractJwtFromRequest,
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
