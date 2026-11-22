import "reflect-metadata";
import { createHash } from "crypto";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import type { Repository } from "typeorm";

import type { AuthUser } from "../../../common/interfaces/auth-user.interface";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import type { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";
import type { SystemConfigService } from "../../config/config.service";
import { UserRole } from "../../users/entities/user.entity";
import { AgentController } from "../agent.controller";
import { AgentTelemetryConsentDto } from "../dto/agent-telemetry.dto";
import { TelemetryOptin } from "../entities/telemetry-optin.entity";
import type { TelemetryOptinService } from "../runtime/telemetry-optin.service";
import { TTFV_SYSTEM_GATE_KEY } from "../runtime/telemetry-optin.service";
import { Executor } from "../../executor/entities/executor.entity";

type GateUpsertDto = {
  key: string;
  value: string;
  valueType?: string;
  description?: string;
};

type OptinRow = {
  installId: string;
  userIdHash: string | null;
  optIn: boolean;
  optedAt: Date;
  source: string;
};

/** 和 SecretsCryptoService.deriveAnonymousId 同形态的 opaque 派生（不含输入子串）。 */
const derive = (input: string, purpose: string): string =>
  createHash("sha256").update(`${purpose}:${input}`).digest("hex").slice(0, 16);

class MemoryConfigService {
  value: string | null = null;

  upsert = jest.fn(
    async (
      dto: GateUpsertDto,
      _options?: { userId?: number; username?: string; ipAddress?: string },
    ) => {
      this.value = dto.value;
      return { key: dto.key, value: dto.value };
    },
  );

  findOne = jest.fn(async (key: string) => {
    if (this.value === null) {
      throw Object.assign(new Error("CONFIG_ITEM_NOT_FOUND"), {
        errorCode: "CONFIG_ITEM_NOT_FOUND",
        key,
      });
    }
    return { key, value: this.value };
  });
}

class MemoryTelemetryOptinService {
  grant = jest.fn(
    async (_installId: string, _userIdHash: string, _source: string) => {},
  );
  revoke = jest.fn(async (_installId: string) => {});
}

class MemorySecretsCryptoService {
  failDerivation = false;

  deriveAnonymousId = jest.fn((input: string, purpose: string) =>
    this.failDerivation ? null : derive(input, purpose),
  );
}

class MemoryExecutorRepo {
  find = jest.fn(async () => this.rows);

  constructor(
    public readonly rows: Array<{ deviceFingerprint: string | null }> = [],
  ) {}
}

class MemoryOptinRepo {
  rows: OptinRow[] = [];

  find = jest.fn(
    async (options?: {
      where?: { optIn?: boolean };
      order?: { optedAt?: "ASC" | "DESC" };
    }) => {
      let result = [...this.rows];
      if (options?.where?.optIn !== undefined) {
        result = result.filter((row) => row.optIn === options.where?.optIn);
      }
      if (options?.order?.optedAt === "DESC") {
        result.sort((a, b) => b.optedAt.getTime() - a.optedAt.getTime());
      }
      return result;
    },
  );
}

const user: AuthUser = {
  id: 7,
  username: "alice",
  email: "alice@example.test",
  role: UserRole.ADMIN,
  isActive: true,
  sid: "sid-1",
};

const makeController = (deps: {
  config: MemoryConfigService;
  optin: MemoryTelemetryOptinService;
  crypto: MemorySecretsCryptoService;
  executors?: MemoryExecutorRepo | null;
  optinRows?: MemoryOptinRepo;
}): AgentController =>
  new AgentController(
    {} as never,
    {} as never,
    {} as never,
    null as never,
    null,
    null,
    null,
    null,
    null,
    deps.config as unknown as SystemConfigService,
    deps.optin as unknown as TelemetryOptinService,
    deps.crypto as unknown as SecretsCryptoService,
    (deps.executors === undefined
      ? new MemoryExecutorRepo()
      : deps.executors) as unknown as Repository<Executor>,
    (deps.optinRows ??
      new MemoryOptinRepo()) as unknown as Repository<TelemetryOptin>,
  );

const fixtures = () => ({
  config: new MemoryConfigService(),
  optin: new MemoryTelemetryOptinService(),
  crypto: new MemorySecretsCryptoService(),
});

describe("AgentController — TTFV opt-in consent (R308)", () => {
  it("installId: grants directly and switches the system gate on", async () => {
    const { config, optin, crypto } = fixtures();
    const controller = makeController({ config, optin, crypto });

    const result = await controller.setTelemetryConsent(
      { optIn: true, installId: "inst-1", source: "api" },
      user,
    );

    expect(config.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: TTFV_SYSTEM_GATE_KEY,
        value: "true",
        valueType: "boolean",
      }),
      { userId: user.id },
    );
    expect(config.upsert.mock.calls[0][1]).not.toHaveProperty("username");
    expect(optin.grant).toHaveBeenCalledWith(
      "inst-1",
      derive("alice", "ttfv-user"),
      "api",
    );
    expect(result).toEqual({
      systemEnabled: true,
      optedIn: true,
      installIds: ["inst-1"],
      count: 1,
      source: "api",
    });
  });

  it("deviceFingerprint: derives an anonymous install id before granting", async () => {
    const { config, optin, crypto } = fixtures();
    const controller = makeController({ config, optin, crypto });

    const result = await controller.setTelemetryConsent(
      { optIn: true, deviceFingerprint: "fp-abc" },
      user,
    );

    expect(crypto.deriveAnonymousId).toHaveBeenCalledWith(
      "fp-abc",
      "ttfv-install",
    );
    expect(crypto.deriveAnonymousId).toHaveBeenCalledWith("alice", "ttfv-user");
    const installId = derive("fp-abc", "ttfv-install");
    expect(optin.grant).toHaveBeenCalledWith(
      installId,
      derive("alice", "ttfv-user"),
      "admin-ui",
    );
    expect(result.installIds).toEqual([installId]);
    expect(JSON.stringify(result)).not.toContain("fp-abc");
  });

  it("no target: batch-grants every distinct executor fingerprint", async () => {
    const { config, optin, crypto } = fixtures();
    const executors = new MemoryExecutorRepo([
      { deviceFingerprint: "fp-1" },
      { deviceFingerprint: "fp-1" },
      { deviceFingerprint: null },
      { deviceFingerprint: "fp-2" },
    ]);
    const controller = makeController({ config, optin, crypto, executors });

    const result = await controller.setTelemetryConsent({ optIn: true }, user);

    expect(executors.find).toHaveBeenCalled();
    expect(optin.grant).toHaveBeenCalledTimes(2);
    expect(optin.grant).toHaveBeenCalledWith(
      derive("fp-1", "ttfv-install"),
      derive("alice", "ttfv-user"),
      "admin-ui",
    );
    expect(optin.grant).toHaveBeenCalledWith(
      derive("fp-2", "ttfv-install"),
      derive("alice", "ttfv-user"),
      "admin-ui",
    );
    expect(result.count).toBe(2);
    expect(config.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ value: "true" }),
      { userId: user.id },
    );
  });

  it("userIdHash is opaque: raw username never reaches the grant", async () => {
    const { config, optin, crypto } = fixtures();
    const controller = makeController({ config, optin, crypto });

    await controller.setTelemetryConsent(
      { optIn: true, installId: "inst-1" },
      user,
    );

    const userIdHash = optin.grant.mock.calls[0][1];
    expect(userIdHash).not.toContain("alice");
    expect(userIdHash).toBe(derive("alice", "ttfv-user"));
  });

  it("derivation failure is fail-closed: no grant and no gate write", async () => {
    const { config, optin, crypto } = fixtures();
    crypto.failDerivation = true;
    const controller = makeController({ config, optin, crypto });

    await expect(
      controller.setTelemetryConsent(
        { optIn: true, installId: "inst-1" },
        user,
      ),
    ).rejects.toMatchObject({ errorCode: "DEPENDENCY_UNAVAILABLE" });
    expect(optin.grant).not.toHaveBeenCalled();
    expect(config.upsert).not.toHaveBeenCalled();
  });

  it("optIn=false with explicit install: gate off then revoke", async () => {
    const { config, optin, crypto } = fixtures();
    const controller = makeController({ config, optin, crypto });

    const result = await controller.setTelemetryConsent(
      { optIn: false, installId: "inst-1" },
      user,
    );

    expect(config.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ value: "false" }),
      { userId: user.id },
    );
    expect(optin.revoke).toHaveBeenCalledWith("inst-1");
    expect(optin.grant).not.toHaveBeenCalled();
    expect(result).toEqual({
      systemEnabled: false,
      optedIn: false,
      installIds: ["inst-1"],
      count: 1,
      source: "admin-ui",
    });
  });

  it("optIn=false without target: revokes stored opt-ins plus derived installs", async () => {
    const { config, optin, crypto } = fixtures();
    const optinRows = new MemoryOptinRepo();
    optinRows.rows = [
      {
        installId: "stored-on",
        userIdHash: null,
        optIn: true,
        optedAt: new Date("2026-01-01T00:00:00Z"),
        source: "admin-ui",
      },
      {
        installId: "stored-off",
        userIdHash: null,
        optIn: false,
        optedAt: new Date("2026-01-01T00:00:00Z"),
        source: "revoke",
      },
    ];
    const executors = new MemoryExecutorRepo([{ deviceFingerprint: "fp-9" }]);
    const controller = makeController({
      config,
      optin,
      crypto,
      optinRows,
      executors,
    });

    await controller.setTelemetryConsent({ optIn: false }, user);

    expect(config.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ value: "false" }),
      { userId: user.id },
    );
    expect(optin.revoke).toHaveBeenCalledWith("stored-on");
    expect(optin.revoke).toHaveBeenCalledWith(derive("fp-9", "ttfv-install"));
    expect(optin.revoke).not.toHaveBeenCalledWith("stored-off");
  });

  it("status: reports gate, opted-in count and latest optedAt", async () => {
    const { config, optin, crypto } = fixtures();
    config.value = "true";
    const optinRows = new MemoryOptinRepo();
    optinRows.rows = [
      {
        installId: "a",
        userIdHash: "hash-a",
        optIn: true,
        optedAt: new Date("2026-01-02T00:00:00Z"),
        source: "admin-ui",
      },
      {
        installId: "b",
        userIdHash: null,
        optIn: false,
        optedAt: new Date("2026-01-03T00:00:00Z"),
        source: "revoke",
      },
      {
        installId: "c",
        userIdHash: "hash-c",
        optIn: true,
        optedAt: new Date("2026-01-01T00:00:00Z"),
        source: "api",
      },
    ];
    const controller = makeController({ config, optin, crypto, optinRows });

    const status = await controller.telemetryStatus();

    expect(config.findOne).toHaveBeenCalledWith(TTFV_SYSTEM_GATE_KEY);
    expect(status).toEqual({
      systemEnabled: true,
      count: 2,
      latestOptedAt: "2026-01-02T00:00:00.000Z",
      installs: [
        {
          installId: "b",
          optIn: false,
          optedAt: "2026-01-03T00:00:00.000Z",
          userIdHash: null,
          source: "revoke",
        },
        {
          installId: "a",
          optIn: true,
          optedAt: "2026-01-02T00:00:00.000Z",
          userIdHash: "hash-a",
          source: "admin-ui",
        },
        {
          installId: "c",
          optIn: true,
          optedAt: "2026-01-01T00:00:00.000Z",
          userIdHash: "hash-c",
          source: "api",
        },
      ],
      knownExecutorCount: 0,
      coverage: "no_executors",
    });
  });

  it("status with missing gate key degrades to systemEnabled=false, not 200-empty, not throw", async () => {
    const { config, optin, crypto } = fixtures();
    const controller = makeController({ config, optin, crypto });

    await expect(controller.telemetryStatus()).resolves.toEqual({
      systemEnabled: false,
      count: 0,
      latestOptedAt: null,
      installs: [],
      knownExecutorCount: 0,
      coverage: "gate_off",
    });
  });

  it("status: gate off reports gate_off with honest knownExecutorCount, never authorizes", async () => {
    const { config, optin, crypto } = fixtures();
    config.value = "false";
    const executors = new MemoryExecutorRepo([
      { deviceFingerprint: "fp-1" },
      { deviceFingerprint: "fp-2" },
    ]);
    const optinRows = new MemoryOptinRepo();
    optinRows.rows = [
      {
        installId: derive("fp-1", "ttfv-install"),
        userIdHash: "hash-1",
        optIn: true,
        optedAt: new Date("2026-01-01T00:00:00Z"),
        source: "admin-ui",
      },
    ];
    const controller = makeController({
      config,
      optin,
      crypto,
      executors,
      optinRows,
    });

    const status = await controller.telemetryStatus();

    expect(status.systemEnabled).toBe(false);
    expect(status.knownExecutorCount).toBe(2);
    expect(status.coverage).toBe("gate_off");
    // 纯只读：status 不授权、不写总闸。
    expect(optin.grant).not.toHaveBeenCalled();
    expect(config.upsert).not.toHaveBeenCalled();
  });

  it("status: gate on + zero known executors reports no_executors (audit B2)", async () => {
    const { config, optin, crypto } = fixtures();
    config.value = "true";
    // 典型静默零采集态：总闸开、无已知执行器、count=0。
    const optinRows = new MemoryOptinRepo();
    const controller = makeController({ config, optin, crypto, optinRows });

    const status = await controller.telemetryStatus();

    expect(status.systemEnabled).toBe(true);
    expect(status.count).toBe(0);
    expect(status.knownExecutorCount).toBe(0);
    expect(status.coverage).toBe("no_executors");
  });

  it("status: gate on + all known executors authorized reports full", async () => {
    const { config, optin, crypto } = fixtures();
    config.value = "true";
    const executors = new MemoryExecutorRepo([
      { deviceFingerprint: "fp-1" },
      { deviceFingerprint: "fp-2" },
    ]);
    const optinRows = new MemoryOptinRepo();
    optinRows.rows = [
      {
        installId: derive("fp-1", "ttfv-install"),
        userIdHash: "hash-1",
        optIn: true,
        optedAt: new Date("2026-01-02T00:00:00Z"),
        source: "admin-ui",
      },
      {
        installId: derive("fp-2", "ttfv-install"),
        userIdHash: "hash-2",
        optIn: true,
        optedAt: new Date("2026-01-01T00:00:00Z"),
        source: "api",
      },
    ];
    const controller = makeController({
      config,
      optin,
      crypto,
      executors,
      optinRows,
    });

    const status = await controller.telemetryStatus();

    expect(status.knownExecutorCount).toBe(2);
    expect(status.count).toBe(2);
    expect(status.coverage).toBe("full");
  });

  it("status: gate on + one of two executors authorized reports partial", async () => {
    const { config, optin, crypto } = fixtures();
    config.value = "true";
    const executors = new MemoryExecutorRepo([
      { deviceFingerprint: "fp-1" },
      { deviceFingerprint: "fp-2" },
    ]);
    const optinRows = new MemoryOptinRepo();
    optinRows.rows = [
      {
        installId: derive("fp-1", "ttfv-install"),
        userIdHash: "hash-1",
        optIn: true,
        optedAt: new Date("2026-01-02T00:00:00Z"),
        source: "admin-ui",
      },
      // fp-2 无授权行 ⇒ 覆盖率 partial。
    ];
    const controller = makeController({
      config,
      optin,
      crypto,
      executors,
      optinRows,
    });

    const status = await controller.telemetryStatus();

    expect(status.knownExecutorCount).toBe(2);
    expect(status.count).toBe(1);
    expect(status.coverage).toBe("partial");
  });

  it("status: derivation failure degrades to partial, never fakes full", async () => {
    const { config, optin, crypto } = fixtures();
    config.value = "true";
    crypto.failDerivation = true;
    const executors = new MemoryExecutorRepo([
      { deviceFingerprint: "fp-1" },
      { deviceFingerprint: "fp-2" },
    ]);
    const optinRows = new MemoryOptinRepo();
    // 即便有两条看起来"够数"的授权行，派生失败时也不能报 full。
    optinRows.rows = [
      {
        installId: "stale-1",
        userIdHash: null,
        optIn: true,
        optedAt: new Date("2026-01-01T00:00:00Z"),
        source: "api",
      },
      {
        installId: "stale-2",
        userIdHash: null,
        optIn: true,
        optedAt: new Date("2026-01-01T00:00:00Z"),
        source: "api",
      },
    ];
    const controller = makeController({
      config,
      optin,
      crypto,
      executors,
      optinRows,
    });

    const status = await controller.telemetryStatus();

    expect(crypto.deriveAnonymousId).toHaveBeenCalledWith(
      "fp-1",
      "ttfv-install",
    );
    expect(status.knownExecutorCount).toBe(2);
    expect(status.count).toBe(2);
    expect(status.coverage).toBe("partial");
  });

  it("status: knownExecutorCount dedupes fingerprints and never leaks them", async () => {
    const { config, optin, crypto } = fixtures();
    config.value = "true";
    const executors = new MemoryExecutorRepo([
      { deviceFingerprint: "fp-1" },
      { deviceFingerprint: "fp-1" }, // 重复指纹
      { deviceFingerprint: null }, // 空指纹不计
      { deviceFingerprint: "fp-2" },
    ]);
    const optinRows = new MemoryOptinRepo();
    optinRows.rows = [
      {
        installId: derive("fp-1", "ttfv-install"),
        userIdHash: null,
        optIn: true,
        optedAt: new Date("2026-01-01T00:00:00Z"),
        source: "api",
      },
      {
        installId: derive("fp-2", "ttfv-install"),
        userIdHash: null,
        optIn: true,
        optedAt: new Date("2026-01-01T00:00:00Z"),
        source: "api",
      },
    ];
    const controller = makeController({
      config,
      optin,
      crypto,
      executors,
      optinRows,
    });

    const status = await controller.telemetryStatus();

    expect(status.knownExecutorCount).toBe(2);
    expect(status.coverage).toBe("full");
    // 隐私：响应只含 HMAC 匿名 id 与计数，绝不出现原始指纹。
    expect(JSON.stringify(status)).not.toContain("fp-1");
    expect(JSON.stringify(status)).not.toContain("fp-2");
  });

  it("partial dependency loss (executors repo) fails closed on no-target consent", async () => {
    const { config, optin, crypto } = fixtures();
    const controller = makeController({
      config,
      optin,
      crypto,
      executors: null,
    });

    await expect(
      controller.setTelemetryConsent({ optIn: true }, user),
    ).rejects.toMatchObject({ errorCode: "DEPENDENCY_UNAVAILABLE" });
    expect(config.upsert).not.toHaveBeenCalled();
    expect(optin.grant).not.toHaveBeenCalled();
  });

  it("absent optional dependencies surface 503 instead of a fake success", async () => {
    const controller = new AgentController(
      {} as never,
      {} as never,
      {} as never,
      null as never,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );

    await expect(
      controller.setTelemetryConsent({ optIn: true }, user),
    ).rejects.toMatchObject({ errorCode: "DEPENDENCY_UNAVAILABLE" });
    await expect(controller.telemetryStatus()).rejects.toMatchObject({
      errorCode: "DEPENDENCY_UNAVAILABLE",
    });
  });

  it("controller class carries ADMIN role at class level", () => {
    expect(Reflect.getMetadata(ROLES_KEY, AgentController)).toEqual([
      UserRole.ADMIN,
    ]);
  });
});

/**
 * R330（审计 B3）：consent DTO 的 installId 形状守卫。
 *
 * 既有 18 个用例直接调 controller 方法（不经 ValidationPipe），故这里用
 * class-validator validate() 直接验 DTO——与仓库其它 dto.spec 同口径。
 */
describe("AgentTelemetryConsentDto — installId 原始指纹形状拦截（R330）", () => {
  const RAW_FP_GUIDE =
    "installId 不接受原始设备指纹（64 位 hex）；请改传 deviceFingerprint 由服务端派生，或传已派生的匿名 installId";

  const validateInstallId = (installId: string) =>
    validate(
      plainToInstance(AgentTelemetryConsentDto, { optIn: true, installId }),
    );

  it("① installId=64hex（小写原始指纹形状）⇒ 校验失败并给出逐字引导文案", async () => {
    const errors = await validateInstallId("a".repeat(64));
    const installIdError = errors.find((e) => e.property === "installId");

    expect(installIdError).toBeDefined();
    expect(Object.values(installIdError?.constraints ?? {})).toContain(
      RAW_FP_GUIDE,
    );
  });

  it("② installId=32hex（listener 写入的 HMAC 匿名 ID）⇒ 通过", async () => {
    expect(await validateInstallId("b".repeat(32))).toHaveLength(0);
  });

  it("③ installId='inst-1' / 'ttfv-e2e-<uuid>'（合法自定义 ID）⇒ 通过", async () => {
    expect(await validateInstallId("inst-1")).toHaveLength(0);
    expect(
      await validateInstallId("ttfv-e2e-3f2a1b0c-9d8e-4a7b-8c6d-5e4f3a2b1c0d"),
    ).toHaveLength(0);
  });

  it("④ installId=64hex 但含大写 ⇒ 通过（FINGERPRINT_RE 是小写 hex）", async () => {
    expect(await validateInstallId("A".repeat(64))).toHaveLength(0);
  });
});
