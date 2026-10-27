import type { NextFunction, Request, Response } from "express";
import {
  SlidingWindowCeiling,
  createIpCeilingMiddleware,
  resolveClientIp,
} from "../ip-ceiling.middleware";

/**
 * F1（2026-10-27 审计轮 #7）：回调面 per-IP 硬顶。
 *
 * 钉住的三件事：
 *   1. 滑动窗口计数正确（恰好 limit 放行、第 limit+1 拒绝、窗口滑过后恢复）；
 *   2. **换 x-executor-address 头不产生新桶**（这正是原缺陷的绕过形态：
 *      分桶键来自客户端可伪造的头，聚合速率因此无上限）；
 *   3. 拒绝发生在 body 解析之前（中间件只回 429，不触碰 body），并带 Retry-After。
 */
describe("SlidingWindowCeiling", () => {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  beforeEach(() => {
    clock.t = 1_000_000;
  });

  it("恰好 limit 次放行，第 limit+1 次拒绝", () => {
    const ceiling = new SlidingWindowCeiling({
      limit: 3,
      windowMs: 60_000,
      now,
    });
    expect(ceiling.consume("1.2.3.4").allowed).toBe(true);
    expect(ceiling.consume("1.2.3.4").allowed).toBe(true);
    expect(ceiling.consume("1.2.3.4").allowed).toBe(true);
    const denied = ceiling.consume("1.2.3.4");
    expect(denied.allowed).toBe(false);
    // Retry-After 必须指向"最早那次滑出窗口"的时刻，而不是一个魔数
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("窗口滑过后恢复（滑动窗口，不是固定窗口）", () => {
    const ceiling = new SlidingWindowCeiling({
      limit: 2,
      windowMs: 10_000,
      now,
    });
    expect(ceiling.consume("a").allowed).toBe(true);
    expect(ceiling.consume("a").allowed).toBe(true);
    expect(ceiling.consume("a").allowed).toBe(false);
    clock.t += 10_001;
    expect(ceiling.consume("a").allowed).toBe(true);
  });

  it("不同键互不影响（NAT 后的多台执行器不会被彼此挤占）", () => {
    const ceiling = new SlidingWindowCeiling({
      limit: 1,
      windowMs: 60_000,
      now,
    });
    expect(ceiling.consume("10.0.0.1").allowed).toBe(true);
    expect(ceiling.consume("10.0.0.2").allowed).toBe(true);
    expect(ceiling.consume("10.0.0.1").allowed).toBe(false);
  });

  it("跟踪键有上界（随机源 IP 不能把内存撑爆）", () => {
    const ceiling = new SlidingWindowCeiling({
      limit: 1,
      windowMs: 60_000,
      now,
      maxTrackedKeys: 2,
    });
    ceiling.consume("k1");
    ceiling.consume("k2");
    ceiling.consume("k3");
    expect(ceiling.size()).toBeLessThanOrEqual(2);
  });
});

describe("resolveClientIp", () => {
  it("优先 req.ips[0]（trust proxy 开启时 express 已解析），其次 req.ip，最后 socket", () => {
    expect(
      resolveClientIp({ ips: ["203.0.113.9"], ip: "10.0.0.1" } as never),
    ).toBe("203.0.113.9");
    expect(resolveClientIp({ ip: "10.0.0.1" } as never)).toBe("10.0.0.1");
    expect(
      resolveClientIp({ socket: { remoteAddress: "192.0.2.5" } } as never),
    ).toBe("192.0.2.5");
    expect(resolveClientIp({} as never)).toBe("unknown");
  });
});

/** 极简 express 替身：只记录 status/header/json。 */
function fakeRes() {
  const state = {
    status: 200,
    headers: {} as Record<string, string>,
    body: null as unknown,
  };
  const res = {
    setHeader(name: string, value: string) {
      state.headers[name] = value;
    },
    status(code: number) {
      state.status = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    },
  };
  return { res: res as unknown as Response, state };
}

describe("接线顺序（main.ts）", () => {
  /**
   * 结构性判据：中间件必须注册在 55MB parser **之前**。
   * 为什么值得钉：顺序写反不会报错、不会让任何行为单测变红，只会让
   * "拒绝发生在解析前"这个承诺悄悄失效——本仓对这类静默失效已有多次前科
   * （守卫分母归零、测试没进收集面）。
   */
  it("per-IP 硬顶注册在 55MB body parser 之前", () => {
    const fs = jest.requireActual("node:fs") as typeof import("node:fs");
    const pathMod = jest.requireActual(
      "node:path",
    ) as typeof import("node:path");
    const mainTs = fs.readFileSync(
      pathMod.join(__dirname, "..", "..", "..", "main.ts"),
      "utf-8",
    );
    const ceilingAt = mainTs.indexOf("createIpCeilingMiddleware(");
    const parserAt = mainTs.indexOf('limit: "55mb"');
    expect(ceilingAt).toBeGreaterThan(0);
    expect(parserAt).toBeGreaterThan(0);
    expect(ceilingAt).toBeLessThan(parserAt);
  });
});

describe("createIpCeilingMiddleware", () => {
  const clock = { t: 5_000_000 };
  const now = () => clock.t;
  beforeEach(() => {
    clock.t = 5_000_000;
  });

  it("未超限：调用 next，不写响应", () => {
    const mw = createIpCeilingMiddleware({
      limit: 2,
      now,
      logger: { warn: () => undefined },
    });
    const next = jest.fn() as unknown as NextFunction;
    const { res, state } = fakeRes();
    mw({ ip: "1.1.1.1", headers: {} } as unknown as Request, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(state.status).toBe(200);
  });

  it("超限：429 + Retry-After，且**不调用 next**（body 不会被解析）", () => {
    const mw = createIpCeilingMiddleware({
      limit: 1,
      now,
      logger: { warn: () => undefined },
    });
    const next = jest.fn() as unknown as NextFunction;
    const first = fakeRes();
    mw({ ip: "1.1.1.1", headers: {} } as unknown as Request, first.res, next);
    const second = fakeRes();
    mw({ ip: "1.1.1.1", headers: {} } as unknown as Request, second.res, next);

    expect(next).toHaveBeenCalledTimes(1); // 只有第一次放行
    expect(second.state.status).toBe(429);
    expect(second.state.headers["Retry-After"]).toBeDefined();
    expect(Number(second.state.headers["Retry-After"])).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("换 x-executor-address 头不能换来新桶（原缺陷的绕过形态）", () => {
    const mw = createIpCeilingMiddleware({
      limit: 2,
      now,
      logger: { warn: () => undefined },
    });
    const next = jest.fn() as unknown as NextFunction;
    const ip = "198.51.100.7";
    for (let i = 0; i < 2; i++) {
      mw(
        {
          ip,
          headers: { "x-executor-address": "host-" + i + ":8002" },
        } as unknown as Request,
        fakeRes().res,
        next,
      );
    }
    expect(next).toHaveBeenCalledTimes(2);

    // 第 3 次：换成全新地址值——仍然必须被同一个 IP 桶拒掉
    const third = fakeRes();
    mw(
      {
        ip,
        headers: { "x-executor-address": "brand-new-host:9000" },
      } as unknown as Request,
      third.res,
      next,
    );
    expect(next).toHaveBeenCalledTimes(2);
    expect(third.state.status).toBe(429);
  });

  it("告警按 IP 节流（同一 IP 10 分钟内只告警一次）", () => {
    const warns: string[] = [];
    const mw = createIpCeilingMiddleware({
      limit: 1,
      now,
      logger: { warn: (m: string) => warns.push(m) },
    });
    const next = jest.fn() as unknown as NextFunction;
    const req = { ip: "203.0.113.1", headers: {} } as unknown as Request;
    mw(req, fakeRes().res, next);
    mw(req, fakeRes().res, next);
    mw(req, fakeRes().res, next);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("per-IP ceiling hit");
    // 10 分钟后：窗口已滑过 ⇒ 第一次放行、第二次再被拒 ⇒ 允许再告警一条
    // （注意不能只发一次：窗口滑过后它是合法请求，不该告警——这正是节流判据
    //  必须挂在"拒绝分支"上的原因）
    clock.t += 10 * 60 * 1000 + 1;
    mw(req, fakeRes().res, next);
    expect(warns).toHaveLength(1);
    mw(req, fakeRes().res, next);
    expect(warns).toHaveLength(2);
  });
});
