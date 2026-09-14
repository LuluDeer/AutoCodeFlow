import { getMetadataArgsStorage } from "typeorm";
import { AuditLog } from "../entities/audit-log.entity";

/**
 * R-19（DEEP_REVIEW 0ef3bbe）: audit_logs 实体曾声明
 * `@Index("idx_audit_log_detail_gin", ["detail"])`，注释自称 GIN 覆盖索引——
 * 但 synchronize=false 下实体装饰器不物化，全部迁移（含 InitialSchema 的裸
 * JSONB 列）均未创建该索引，且查询面（audit.service）从未用 @> 包含操作符。
 * 属死声明（误导后来者以为有覆盖索引），已删除。
 *
 * 本 spec 为回归守卫：钉住该幽灵索引不被重新声明（如未来确需 detail 检索，
 * 须先经正式迁移 CREATE INDEX ... USING GIN 再补回声明）。
 */
describe("R-19: AuditLog 索引声明与实际迁移一致", () => {
  const declaredIndexNames = (): string[] =>
    getMetadataArgsStorage()
      .indices.filter((i) => i.target === AuditLog)
      .map((i) => i.name)
      .filter((n): n is string => typeof n === "string");

  it("不再声明不存在的 idx_audit_log_detail_gin 幽灵索引", () => {
    expect(declaredIndexNames()).not.toContain("idx_audit_log_detail_gin");
  });

  it("保留迁移 1790000000022 已创建的 (action, createdAt) 复合索引声明", () => {
    expect(declaredIndexNames()).toContain("idx_audit_logs_action_created_at");
  });
});
