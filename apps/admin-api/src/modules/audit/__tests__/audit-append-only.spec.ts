import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource, ObjectLiteral } from "typeorm";
import { AuditService } from "../audit.service";
import { AuditLog } from "../entities/audit-log.entity";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = (p: string) => readFileSync(p, "utf8");

/**
 * SEC-10: append-only 旁路封堵断言。
 *
 * 迁移 1790000000006 给 audit_logs 挂了 BEFORE UPDATE OR DELETE 触发器
 * （RAISE EXCEPTION，P0001）。应用层的纵深要求：
 *  1. AuditService 公开 API 只暴露 log（INSERT）与查询面——无任何 UPDATE/
 *     DELETE audit 行的方法（唯一 DELETE 是 retention 清理，且必须走 bypass
 *     事务）；
 *  2. 全仓库消费方（auth/task/executor/api-keys/application/users 等）只调
 *     auditService.log / findAll / exportCsv——本 spec 以源码静态扫描兜底；
 *  3. cleanupOldAuditLogs（Q7 retention）经
 *     `SET LOCAL app.bypass_audit_guard = 'on'` 的单个事务执行，绕过面收敛
 *     到这一处（真机行为已由 scripts/audit-verify.mjs 连库验证）。
 */

describe("AuditService — SEC-10 append-only 旁路封堵", () => {
  /** 源码静态扫描：AuditService 本体 + 全仓库消费方，不得出现 bypass 事务之外的 audit 行写删。 */

  it("AuditService 公开方法面 = { log, findAll, exportCsv, cleanupOldAuditLogs }，无任何其他写删入口", () => {
    const publicMethods = Object.getOwnPropertyNames(
      AuditService.prototype,
    ).filter((m) => m !== "constructor");
    // 白名单 = 公开 API + 私有助手（retentionDelete/applyExtraFilters，
    // TS private 在运行时仍是原型属性）；白名单外出现新方法即审计缺口
    const allowed = [
      "log",
      "findAll",
      "exportCsv",
      "cleanupOldAuditLogs",
      "retentionDelete",
      "applyExtraFilters",
    ];
    const unexpected = publicMethods.filter((m) => !allowed.includes(m));
    expect(unexpected).toEqual([]);
  });

  it("AuditService 源码：唯一 repo.delete 调用点在 retentionDelete 内（bypass 事务包裹）", () => {
    const src = SRC(join(__dirname, "../audit.service.ts"));
    // 1) repo.save 只出现在 log()（INSERT 入口）
    const saveCalls = src.match(/this\.repo\.save\(/g)?.length ?? 0;
    expect(saveCalls).toBe(1);
    // 2) 直接 repo.delete 调用点应为 0——清理走 dataSource.transaction + em.getRepository
    expect(src.match(/this\.repo\.delete\(/g) ?? []).toEqual([]);
    // 3) 可执行 SQL 常量（反引号内）只出现一次；注释中的提法不算写点
    const codeNoComments = src
      .split("\n")
      .filter(
        (l) =>
          !l.trim().startsWith("*") &&
          !l.trim().startsWith("//") &&
          !l.trim().startsWith("/*"),
      )
      .join("\n");
    const bypassCount =
      codeNoComments.match(/app\.bypass_audit_guard = 'on'/g) ?? [];
    expect(bypassCount).toHaveLength(1);
    // bypass 常量定义先于 retentionDelete 使用点
    expect(codeNoComments.indexOf("AUDIT_GUARD_BYPASS_SQL")).toBeLessThan(
      codeNoComments.indexOf("private async retentionDelete"),
    );
  });

  it("全仓库消费方静态扫描：除 audit 模块外，无人对 AuditLog/AuditService 调 update/delete/restore", () => {
    const root = resolve(__dirname, "../../../..");
    const out = execSync(
      `grep -rn --include="*.ts" -l "AuditService" ${root}/src/modules | grep -v "modules/audit/" | grep -v spec || true`,
      { encoding: "utf8" },
    ).trim();
    const consumers = out ? out.split("\n") : [];
    expect(consumers.length).toBeGreaterThan(5); // auth/task/executor/api-keys/application/users 等确有消费
    const offenders = consumers.filter((f) => {
      const content = SRC(f);
      // 消费方只允许 log/findAll/exportCsv 形态；出现 update(/delete(/save( 作用于 audit 服务即违规
      return (
        /auditService\.(update|delete|save|restore|softRemove)\(/i.test(
          content,
        ) || /audit\.(update|delete|save)\(/i.test(content)
      );
    });
    expect(offenders).toEqual([]);
  });

  it("cleanupOldAuditLogs 走 bypass 事务（em.getRepository(AuditLog).delete，SET LOCAL 先行）", async () => {
    const calls: string[] = [];
    const emQuery = jest.fn(async (sql: string) => {
      calls.push(sql);
      return [];
    });
    const emDelete = jest.fn(async () => ({ affected: 3 }));
    const emRepo = { delete: emDelete };
    const em = {
      query: emQuery,
      getRepository: jest.fn(() => emRepo),
    } as unknown as ObjectLiteral & { query: typeof emQuery };
    const dataSource = {
      transaction: jest.fn(async (cb: (em: unknown) => Promise<number>) =>
        cb(em),
      ),
    } as unknown as DataSource;

    const module = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: getRepositoryToken(AuditLog), useValue: {} },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    const service = module.get(AuditService);

    await service.cleanupOldAuditLogs();
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    // 顺序：先 SET LOCAL bypass，再 delete
    expect(emQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET LOCAL app.bypass_audit_guard = 'on'"),
    );
    expect(emDelete).toHaveBeenCalledWith({ createdAt: expect.anything() });
    // delete 发生在 SET LOCAL 之后
    expect(emQuery.mock.invocationCallOrder[0]).toBeLessThan(
      emDelete.mock.invocationCallOrder[0],
    );
  });

  it("log() 仍是 INSERT 唯一入口（repo.create + repo.save，行为不变）", async () => {
    const repo = {
      create: jest.fn((d: unknown) => d),
      save: jest.fn(async (e: unknown) => e),
      createQueryBuilder: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: getRepositoryToken(AuditLog), useValue: repo },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
      ],
    }).compile();
    const service = module.get(AuditService);

    await service.log({ action: "auth.login", username: "u1" });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.login", result: "success" }),
    );
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it("retentionDelete 在无 bypass 场景外的 repo 使用保持只读查询面（findAll/exportCsv 用 QB，不写）", async () => {
    // 查询面（findAll/exportCsv）经 createQueryBuilder——从不出 UPDATE/DELETE SQL
    const serviceProtoSrc = SRC(join(__dirname, "../audit.service.ts"));
    expect(serviceProtoSrc).not.toContain(".update(");
    expect(serviceProtoSrc.match(/\.delete\(/g) ?? []).toHaveLength(1); // 仅 retentionDelete 的 em.getRepository(...).delete
    expect(serviceProtoSrc).not.toContain(".softRemove(");
    expect(serviceProtoSrc).not.toContain(".restore(");
  });
});
