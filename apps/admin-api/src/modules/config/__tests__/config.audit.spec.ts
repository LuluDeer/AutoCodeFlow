/**
 * R83：配置写动作的审计（config.create / config.update / config.delete）。
 *
 * 背景：`config` 模块此前**完全没有审计** —— 改一次 `executor.sharedToken` 只能靠
 * `config_history` 那条**会被保留期清理**的行回答「谁改的」；而 `audit_logs` 是 append-only、
 * 触发器拒绝 UPDATE/DELETE。也就是说：最敏感的那类配置，恰恰没有不可篡改的留痕。
 *
 * 本 spec 钉三件事：
 *  ① 三个动作各落一条，action / resource / resourceId 正确；
 *  ② **detail 里没有值**（只有长度与元数据）——配置项的价值往往就在那个值里；
 *  ③ 审计抛错时配置写入**照常成功**，且 `logger.error` 有痕（fail-open，但绝不静默）。
 */
import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { SystemConfigService } from "../config.service";
import { SystemConfig } from "../entities/system-config.entity";
import { ConfigHistory } from "../entities/config-history.entity";
import { AuditService } from "../../audit/audit.service";

const mockRepo = () => {
  const rows = new Map<string, any>();
  return {
    rows,
    findOneBy: jest.fn(async ({ key }: any) => rows.get(key) ?? null),
    upsert: jest.fn(async (v: any) => {
      rows.set(v.key, { ...(rows.get(v.key) ?? {}), ...v });
      return {};
    }),
    remove: jest.fn(async (v: any) => {
      rows.delete(v.key);
      return v;
    }),
    find: jest.fn(async () => [...rows.values()]),
    createQueryBuilder: jest.fn(() => ({
      delete: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn(async () => ({ affected: 0 })),
    })),
  };
};

const mockHistoryRepo = () => ({
  create: jest.fn((v: any) => v),
  save: jest.fn(async (v: any) => v),
  findOne: jest.fn(async () => null),
  find: jest.fn(async () => []),
  createQueryBuilder: jest.fn(() => ({
    delete: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn(async () => ({ affected: 0 })),
  })),
});

async function harness(auditService?: { log: jest.Mock }) {
  const repo = mockRepo();
  const historyRepo = mockHistoryRepo();
  const audit = auditService ?? { log: jest.fn(async () => undefined) };
  const module = await Test.createTestingModule({
    providers: [
      SystemConfigService,
      { provide: getRepositoryToken(SystemConfig), useValue: repo },
      { provide: getRepositoryToken(ConfigHistory), useValue: historyRepo },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  return { svc: module.get(SystemConfigService), repo, audit };
}

describe("R83 · 配置写动作落审计", () => {
  it("create 落 config.create，detail 只有元数据没有值", async () => {
    const h = await harness();
    await h.svc.upsert({
      key: "executor.sharedToken",
      value: "super-secret-token-value",
      isSecret: true,
      description: "集群共享口令",
    } as any);

    const call = (h.audit.log as jest.Mock).mock.calls[0][0];
    expect(call.action).toBe("config.create");
    expect(call.resource).toBe("config");
    expect(call.resourceId).toBe("executor.sharedToken");
    expect(call.detail.isSecret).toBe(true);
    expect(call.detail.valueLength).toBe("super-secret-token-value".length);
    // 硬约束：值不得进审计（哪怕 key 本身不敏感）
    expect(JSON.stringify(call.detail)).not.toContain(
      "super-secret-token-value",
    );
    // ADR-028 / R83：**键集合**也钉死 —— 只允许这几个元数据字段。
    // 只断言「不含这个值」不够：将来有人加一个 value/raw 字段，换个值就漏过去了。
    expect(Object.keys(call.detail).sort()).toEqual([
      "isSecret",
      "maskSentinelResolved",
      "previousValueLength",
      "valueLength",
      "valueType",
    ]);
  });

  it("已有密钥 + 提交掩码哨兵 → config.update 且 maskSentinelResolved=true（值仍不入审计）", async () => {
    const h = await harness();
    h.repo.rows.set("executor.sharedToken", {
      key: "executor.sharedToken",
      value: "real-value-kept",
      valueType: "string",
      isSecret: true,
      description: "d",
    });

    await h.svc.upsert({
      key: "executor.sharedToken",
      value: "***",
      description: "改了描述",
    } as any);

    const call = (h.audit.log as jest.Mock).mock.calls[0][0];
    expect(call.action).toBe("config.update");
    expect(call.detail.maskSentinelResolved).toBe(true);
    expect(JSON.stringify(call.detail)).not.toContain("real-value-kept");
    // 哨兵被解析回真值，库里的值没被 *** 覆盖
    expect(h.repo.rows.get("executor.sharedToken").value).toBe(
      "real-value-kept",
    );
  });

  it("remove 落 config.delete", async () => {
    const h = await harness();
    h.repo.rows.set("smtp.password", {
      key: "smtp.password",
      value: "pw",
      valueType: "string",
      isSecret: true,
    });

    await h.svc.remove("smtp.password");

    const call = (h.audit.log as jest.Mock).mock.calls[0][0];
    expect(call.action).toBe("config.delete");
    expect(call.resourceId).toBe("smtp.password");
    expect(JSON.stringify(call.detail)).not.toContain("pw");
  });

  it("审计抛错 → 配置写入仍成功，且 logger.error 有痕（fail-open 但绝不静默）", async () => {
    const boom = {
      log: jest.fn(async () => {
        throw new Error("audit down");
      }),
    };
    const errSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const h = await harness(boom);

    await expect(
      h.svc.upsert({ key: "k1", value: "v1" } as any),
    ).resolves.toBeDefined();
    expect(h.repo.rows.get("k1").value).toBe("v1");
    expect(errSpy).toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0][0])).toContain(
      "config audit write failed",
    );
    errSpy.mockRestore();
  });
});
