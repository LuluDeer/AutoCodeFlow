import type { Repository } from "typeorm";

import { TelemetryOptin } from "../../entities/telemetry-optin.entity";
import {
  REVOKE_SOURCE,
  TelemetryOptinService,
  TTFV_SYSTEM_GATE_KEY,
} from "../telemetry-optin.service";

type StoredRow = {
  installId: string;
  userIdHash: string | null;
  optIn: boolean;
  optedAt: Date;
  source: string;
};

/** 内存替身：findOne 在缺键时抛 CONFIG_ITEM_NOT_FOUND（与真服务一致）。 */
class MemoryConfigService {
  value: string | null = null;
  shouldThrow = false;

  findOne = jest.fn(async (key: string) => {
    if (this.shouldThrow) throw new Error("config service unavailable");
    if (this.value === null) {
      throw Object.assign(new Error("CONFIG_ITEM_NOT_FOUND"), {
        code: "CONFIG_ITEM_NOT_FOUND",
        key,
      });
    }
    return { key, value: this.value };
  });
}

/** 内存替身：upsert 按 installId 收敛成一行，模拟唯一索引。 */
class MemoryOptinRepo {
  readonly rows = new Map<string, StoredRow>();
  shouldThrow = false;

  findOneBy = jest.fn(async (where: { installId: string }) => {
    if (this.shouldThrow) throw new Error("optin table unavailable");
    return this.rows.get(where.installId) ?? null;
  });

  upsert = jest.fn(
    async (
      entity: Partial<TelemetryOptin>,
      options: { conflictPaths: string[] },
    ) => {
      const installId = entity.installId as string;
      this.rows.set(installId, {
        installId,
        userIdHash: entity.userIdHash ?? null,
        optIn: entity.optIn === true,
        optedAt: entity.optedAt as Date,
        source: entity.source as string,
      });
      return { generatedMaps: [], raw: [], identifiers: [], options };
    },
  );
}

type OptionalConfig = ConstructorParameters<typeof TelemetryOptinService>[1];

const makeService = (
  repo: MemoryOptinRepo,
  config: MemoryConfigService | null = new MemoryConfigService(),
): TelemetryOptinService =>
  new TelemetryOptinService(
    repo as unknown as Repository<TelemetryOptin>,
    config as unknown as OptionalConfig,
  );

const enabledConfig = (): MemoryConfigService => {
  const config = new MemoryConfigService();
  config.value = "true";
  return config;
};

describe("TelemetryOptinService.isOptedIn — 双闸 fail-closed", () => {
  it("总闸缺 key（CONFIG_ITEM_NOT_FOUND）→ false，且不查授权表", async () => {
    const repo = new MemoryOptinRepo();
    const config = new MemoryConfigService(); // value=null ⇒ findOne 抛缺键

    const verdict = await makeService(repo, config).isOptedIn("inst-1");

    expect(verdict).toBe(false);
    expect(config.findOne).toHaveBeenCalledWith(TTFV_SYSTEM_GATE_KEY);
    expect(repo.findOneBy).not.toHaveBeenCalled();
  });

  it("总闸读取抛异常 → false（不中断），且不查授权表", async () => {
    const repo = new MemoryOptinRepo();
    const config = new MemoryConfigService();
    config.shouldThrow = true;

    await expect(makeService(repo, config).isOptedIn("inst-1")).resolves.toBe(
      false,
    );
    expect(repo.findOneBy).not.toHaveBeenCalled();
  });

  it("配置服务缺席（@Optional 降级为 null）→ false，且不查授权表", async () => {
    const repo = new MemoryOptinRepo();

    await expect(makeService(repo, null).isOptedIn("inst-1")).resolves.toBe(
      false,
    );
    expect(repo.findOneBy).not.toHaveBeenCalled();
  });

  it("总闸为 false / 非法值 → false，且不查授权表", async () => {
    for (const value of ["false", "yes", "", "2"]) {
      const repo = new MemoryOptinRepo();
      const config = new MemoryConfigService();
      config.value = value;

      await expect(makeService(repo, config).isOptedIn("inst-1")).resolves.toBe(
        false,
      );
      expect(repo.findOneBy).not.toHaveBeenCalled();
    }
  });

  it("总闸 true + opt_in=true → true", async () => {
    const repo = new MemoryOptinRepo();
    repo.rows.set("inst-1", {
      installId: "inst-1",
      userIdHash: "user-hash-1",
      optIn: true,
      optedAt: new Date("2026-11-21T03:00:00.000Z"),
      source: "settings",
    });

    await expect(
      makeService(repo, enabledConfig()).isOptedIn("inst-1"),
    ).resolves.toBe(true);
    expect(repo.findOneBy).toHaveBeenCalledWith({ installId: "inst-1" });
  });

  it("总闸 true + opt_in=false（显式撤销）→ false", async () => {
    const repo = new MemoryOptinRepo();
    repo.rows.set("inst-1", {
      installId: "inst-1",
      userIdHash: null,
      optIn: false,
      optedAt: new Date("2026-11-21T03:00:00.000Z"),
      source: REVOKE_SOURCE,
    });

    await expect(
      makeService(repo, enabledConfig()).isOptedIn("inst-1"),
    ).resolves.toBe(false);
  });

  it("总闸 true + 授权表无该 install → false", async () => {
    const repo = new MemoryOptinRepo();

    await expect(
      makeService(repo, enabledConfig()).isOptedIn("never-seen"),
    ).resolves.toBe(false);
  });

  it("总闸 true 但授权表读取抛异常 → false（不中断）", async () => {
    const repo = new MemoryOptinRepo();
    repo.shouldThrow = true;

    await expect(
      makeService(repo, enabledConfig()).isOptedIn("inst-1"),
    ).resolves.toBe(false);
  });

  it('总闸值 "1" 与 " TRUE " 同样视为开启（与仓库布尔解析同口径）', async () => {
    const repo = new MemoryOptinRepo();
    repo.rows.set("inst-1", {
      installId: "inst-1",
      userIdHash: null,
      optIn: true,
      optedAt: new Date(),
      source: "settings",
    });
    for (const value of ["1", " TRUE "]) {
      const config = new MemoryConfigService();
      config.value = value;
      await expect(makeService(repo, config).isOptedIn("inst-1")).resolves.toBe(
        true,
      );
    }
  });
});

describe("TelemetryOptinService.grant / revoke — 状态 upsert", () => {
  it("grant：按 installId upsert optIn=true / userIdHash / source / optedAt=now", async () => {
    const repo = new MemoryOptinRepo();

    await makeService(repo).grant("inst-2", "user-hash-2", "install-wizard");

    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        installId: "inst-2",
        userIdHash: "user-hash-2",
        optIn: true,
        optedAt: expect.any(Date),
        source: "install-wizard",
      }),
      { conflictPaths: ["installId"] },
    );
    expect(repo.rows.get("inst-2")).toMatchObject({
      optIn: true,
      userIdHash: "user-hash-2",
      source: "install-wizard",
    });
  });

  it("revoke：按 installId upsert optIn=false / optedAt=now / source=revoke", async () => {
    const repo = new MemoryOptinRepo();

    await makeService(repo).revoke("inst-3");

    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        installId: "inst-3",
        optIn: false,
        optedAt: expect.any(Date),
        source: REVOKE_SOURCE,
      }),
      { conflictPaths: ["installId"] },
    );
    expect(repo.rows.get("inst-3")).toMatchObject({
      optIn: false,
      source: REVOKE_SOURCE,
    });
  });

  it("grant → revoke → grant 收敛到同一行（install_id 唯一）", async () => {
    const repo = new MemoryOptinRepo();
    const service = makeService(repo);

    await service.grant("inst-4", "hash-a", "settings");
    await service.revoke("inst-4");
    await service.grant("inst-4", "hash-b", "settings");

    expect(repo.rows.size).toBe(1);
    expect(repo.rows.get("inst-4")).toMatchObject({
      installId: "inst-4",
      userIdHash: "hash-b",
      optIn: true,
      source: "settings",
    });
  });
});
