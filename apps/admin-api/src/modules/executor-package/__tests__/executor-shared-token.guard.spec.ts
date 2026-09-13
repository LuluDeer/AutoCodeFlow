import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * WIKI-PKG-GUARD: the guard is a thin pipeline adapter around
 * verify-executor-token.util — the suites below pin both halves of that
 * contract:
 *  1) delegation: canActivate passes the raw `authorization` header value and
 *     both injected services through to verifyExecutorToken verbatim, and
 *     whatever the util throws propagates unchanged (byte-for-byte the same
 *     401 the former inline call produced);
 *  2) end-to-end semantics: with the REAL util wired in, valid tokens pass,
 *     invalid/missing ones reject with exactly the util's UnauthorizedException
 *     payloads ("Invalid executor token" / not-configured message).
 */

jest.mock("../../../common/utils/verify-executor-token.util", () => ({
  // Guard only consumes verifyExecutorToken; keep the sibling export so any
  // transitive importer of the util module keeps resolving.
  getExecutorSharedToken: jest.fn(),
  verifyExecutorToken: jest.fn(),
}));

import { ExecutorSharedTokenGuard } from "../executor-shared-token.guard";
import { verifyExecutorToken } from "../../../common/utils/verify-executor-token.util";

const mockedVerify = jest.mocked(verifyExecutorToken);
// Real util logic for the end-to-end suite below (the file-level jest.mock
// replaces the module for the delegation suite above).
const actualUtil = jest.requireActual<
  typeof import("../../../common/utils/verify-executor-token.util")
>("../../../common/utils/verify-executor-token.util");

const makeContext = (authorization?: string): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        headers: authorization === undefined ? {} : { authorization },
      }),
    }),
  }) as unknown as ExecutionContext;

describe("ExecutorSharedTokenGuard (delegation to verifyExecutorToken)", () => {
  let guard: ExecutorSharedTokenGuard;
  const configService = { get: jest.fn() } as unknown as ConfigService;
  const systemConfigService = { findOne: jest.fn() } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new ExecutorSharedTokenGuard(configService, systemConfigService);
  });

  it("passes the raw authorization header and both services through verbatim", async () => {
    mockedVerify.mockResolvedValue(undefined);
    const header = "Bearer db-token";
    await expect(guard.canActivate(makeContext(header))).resolves.toBe(true);
    expect(mockedVerify).toHaveBeenCalledTimes(1);
    expect(mockedVerify).toHaveBeenCalledWith(
      header,
      configService,
      systemConfigService,
    );
  });

  it("forwards a missing header as undefined (same as the former @Headers param)", async () => {
    mockedVerify.mockResolvedValue(undefined);
    await expect(guard.canActivate(makeContext(undefined))).resolves.toBe(true);
    expect(mockedVerify).toHaveBeenCalledWith(
      undefined,
      configService,
      systemConfigService,
    );
  });

  it("propagates the util's UnauthorizedException unchanged (invalid token)", async () => {
    const thrown = new UnauthorizedException("Invalid executor token");
    mockedVerify.mockRejectedValue(thrown);
    await expect(guard.canActivate(makeContext("Bearer wrong"))).rejects.toBe(
      thrown,
    );
  });

  it("propagates the util's UnauthorizedException unchanged (missing header)", async () => {
    const thrown = new UnauthorizedException("Invalid executor token");
    mockedVerify.mockRejectedValue(thrown);
    await expect(guard.canActivate(makeContext(undefined))).rejects.toBe(
      thrown,
    );
  });
});

describe("ExecutorSharedTokenGuard (real util end-to-end semantics)", () => {
  const SECRET = "guard-spec-shared-secret";

  // Route the mocked seam through the genuine util implementation so this
  // suite exercises the exact verification logic the old inline call used.
  beforeEach(() => {
    jest.clearAllMocks();
    mockedVerify.mockImplementation(actualUtil.verifyExecutorToken);
  });

  const buildGuard = (
    systemConfig: { findOne: jest.Mock },
    env?: Record<string, string>,
  ) =>
    new ExecutorSharedTokenGuard(
      new ConfigService(env ?? { "executor.sharedToken": SECRET }),
      systemConfig as any,
    );

  it("allows a request carrying the effective (DB) shared token", async () => {
    const systemConfig = {
      findOne: jest.fn().mockResolvedValue({ value: "db-token" }),
    };
    const guard = buildGuard(systemConfig);
    await expect(
      guard.canActivate(makeContext("Bearer db-token")),
    ).resolves.toBe(true);
    expect(systemConfig.findOne).toHaveBeenCalledWith("executor.sharedToken");
  });

  it("allows the raw token form without the Bearer prefix (util parity)", async () => {
    const systemConfig = { findOne: jest.fn().mockRejectedValue(new Error()) };
    const guard = buildGuard(systemConfig);
    await expect(guard.canActivate(makeContext(SECRET))).resolves.toBe(true);
  });

  it("rejects an invalid token with the util's exact 401 message", async () => {
    const guard = buildGuard({
      findOne: jest.fn().mockRejectedValue(new Error()),
    });
    await expect(
      guard.canActivate(makeContext("Bearer wrong-token")),
    ).rejects.toMatchObject({
      status: 401,
      message: "Invalid executor token",
    });
  });

  it("rejects a missing authorization header with 401 Invalid executor token", async () => {
    const guard = buildGuard({
      findOne: jest.fn().mockRejectedValue(new Error()),
    });
    await expect(
      guard.canActivate(makeContext(undefined)),
    ).rejects.toMatchObject({
      status: 401,
      message: "Invalid executor token",
    });
  });

  it("fails closed when no shared token is configured at all", async () => {
    const guard = buildGuard(
      { findOne: jest.fn().mockRejectedValue(new Error("key not found")) },
      {},
    );
    await expect(
      guard.canActivate(makeContext("Bearer anything")),
    ).rejects.toMatchObject({
      status: 401,
      message:
        "Executor shared token is not configured; refusing unauthenticated executor access",
    });
  });
});
