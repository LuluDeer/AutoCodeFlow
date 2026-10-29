import { UnauthorizedException } from "@nestjs/common";

import { ExecutorController } from "../executor.controller";
import type { ExecutorService } from "../executor.service";

/**
 * SEC-R3-1/2（第 3 轮并行审计 P1）：共享令牌 ≠ per-executor 身份。
 *
 * 共享令牌证明「某台合法执行器」，不证明「你就是请求里那台」。本轮把三处
 * 私有面/凭据面收紧：
 *   · pull          —— 响应含已解密任务密钥，且 RPOP 会把载荷移出队列；
 *   · terminal-states —— 返回该行私有执行记录；
 *   · heartbeat/register —— tokenHash 是回调 HMAC 密钥本体；register 还能
 *     换发新明文令牌（用别人的 address + 新 startupId 即可身份接管）。
 */
function makeSvc(overrides: Record<string, unknown> = {}) {
  return {
    authenticateMachineRequest: jest.fn(),
    heartbeat: jest.fn(),
    registerExecutor: jest.fn(),
    isSharedToken: jest.fn(async () => false),
    getCallbackSecretById: jest.fn(async () => "$2b$12$callback-secret"),
    validateTokenByAddress: jest.fn(async () => true),
    getTerminalStates: jest.fn(async () => ({
      items: [],
      hasMore: false,
      serverTime: new Date().toISOString(),
    })),
    ...overrides,
  } as unknown as ExecutorService & Record<string, jest.Mock>;
}

const config = {
  get: (key: string) =>
    key === "executor.sharedToken" ? "shared-secret" : undefined,
} as never;
const systemConfig = { findOne: jest.fn(async () => null) } as never;

const pullService = {
  pullWork: jest.fn(async () => ({ task: null, commands: [] })),
};

function build(svc: ExecutorService) {
  return new ExecutorController(
    svc,
    config,
    systemConfig,
    pullService as never,
  );
}

describe("ExecutorController · 共享令牌不得代表某一行（SEC-R3-1/2）", () => {
  it("pull：共享令牌 → 401，绝不触达 pullService（不得收割他人派发/明文 secrets）", async () => {
    const svc = makeSvc({
      authenticateMachineRequest: jest.fn(async () => ({
        ok: true,
        executor: { id: "victim-row", dispatchMode: "pull" },
        via: "shared",
        resolvedBy: "address",
      })),
    });
    const res = { on: jest.fn(), destroyed: false, writableEnded: false };
    await expect(
      build(svc).pullDispatch(
        { address: "victim:3002", waitMs: 0 } as never,
        "Bearer shared-secret",
        res as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("pull：per-executor 身份放行到取件（不再被新闸拦截）", async () => {
    const svc = makeSvc({
      authenticateMachineRequest: jest.fn(async () => ({
        ok: true,
        executor: { id: "row-a", dispatchMode: "push" },
        via: "per-executor",
        resolvedBy: "fingerprint",
      })),
    });
    const res = { on: jest.fn(), destroyed: false, writableEnded: false };
    await expect(
      build(svc).pullDispatch(
        { address: "a:3002", waitMs: 0 } as never,
        "Bearer tok",
        res as never,
      ),
    ).resolves.toMatchObject({ task: null });
  });

  it("heartbeat：共享令牌 → tokenHash 为 null（回调 HMAC 密钥不外发）", async () => {
    const svc = makeSvc({
      isSharedToken: jest.fn(async () => true),
      heartbeat: jest.fn(async () => ({
        id: "e1",
        address: "10.0.0.9:3002",
        status: "online",
      })),
    });
    const out = (await build(svc).heartbeat(
      { address: "10.0.0.9:3002" } as never,
      "Bearer shared-secret",
    )) as { tokenHash: string | null };
    expect(out.tokenHash).toBeNull();
  });

  it("heartbeat：per-executor 令牌仍回传 tokenHash（既有执行器不退化）", async () => {
    const svc = makeSvc({
      heartbeat: jest.fn(async () => ({
        id: "e1",
        address: "10.0.0.9:3002",
        status: "online",
      })),
    });
    const out = (await build(svc).heartbeat(
      { address: "10.0.0.9:3002" } as never,
      "Bearer per-executor",
    )) as { tokenHash: string | null };
    expect(out.tokenHash).toBe("$2b$12$callback-secret");
  });

  it("register：共享令牌 → 禁止换发凭据且不回传 tokenHash（堵身份接管）", async () => {
    const svc = makeSvc({
      isSharedToken: jest.fn(async () => true),
      registerExecutor: jest.fn(async () => ({
        executor: { id: "victim-row" },
        perExecutorToken: null,
        credentialWithheld: true,
      })),
    });
    const out = (await build(svc).register(
      { appName: "executor-node", address: "victim:3002" } as never,
      "Bearer shared-secret",
    )) as { tokenHash: string | null; perExecutorToken: string | null };

    expect(svc.registerExecutor).toHaveBeenCalledWith(expect.anything(), {
      allowCredentialIssuance: false,
    });
    expect(out.tokenHash).toBeNull();
    expect(out.perExecutorToken).toBeNull();
  });

  it("register：首次注册（该行尚无凭据）→ 仍发放令牌与 tokenHash（引导不退化）", async () => {
    const svc = makeSvc({
      // 共享令牌是 register 的唯一入口凭据（新执行器此时还没有 per-executor
      // 令牌）——所以「共享 ⇒ 一律不发凭据」会打断引导。正确判据是
      // 「该行是否已有凭据」：没有则发放，有则拒绝轮换并扣留 tokenHash。
      isSharedToken: jest.fn(async () => true),
      registerExecutor: jest.fn(async () => ({
        executor: { id: "new-row" },
        perExecutorToken: "fresh-token",
        credentialWithheld: false,
      })),
    });
    const out = (await build(svc).register(
      { appName: "executor-node", address: "new:3002" } as never,
      "Bearer shared-secret",
    )) as { tokenHash: string | null; perExecutorToken: string | null };

    expect(svc.registerExecutor).toHaveBeenCalledWith(expect.anything(), {
      allowCredentialIssuance: false,
    });
    expect(out.perExecutorToken).toBe("fresh-token");
    expect(out.tokenHash).toBe("$2b$12$callback-secret");
  });
});
