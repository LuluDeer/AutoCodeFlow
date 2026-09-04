import { getMetadataArgsStorage } from "typeorm";
import { getMetadataStorage } from "class-validator";
import { User } from "../users/entities/user.entity";
import { SystemConfig } from "../config/entities/system-config.entity";
import { ExecutionLogLine } from "../task/entities/execution-log-line.entity";
import { ApplicationVersion } from "../application/entities/application-version.entity";

/**
 * Stream D（DB-002/004/006/007）entity 元数据回归测试：
 * 校验实体装饰器产物与审查报告要求的约束一致，防止后续重构回退。
 */

describe("DB-004: ApplicationVersion 唯一索引", () => {
  it("(applicationId, version) 组合索引为 unique", () => {
    const index = getMetadataArgsStorage()
      .indices.filter((i) => i.target === ApplicationVersion)
      .find(
        (i) =>
          i.columns.length === 2 &&
          i.columns[0] === "applicationId" &&
          i.columns[1] === "version",
      );
    expect(index).toBeDefined();
    expect(index!.unique).toBe(true);
  });
});

describe("DB-006: User.username 长度约束", () => {
  it("列长度显式为 128", () => {
    const column = getMetadataArgsStorage()
      .columns.filter((c) => c.target === User)
      .find((c) => c.propertyName === "username");
    expect(column).toBeDefined();
    expect(column!.options.length).toBe(128);
  });

  it("@Length(3, 128) 注册到 class-validator 元数据", () => {
    // getTargetValidationMetadatas 需要 groups 相关参数；非严格模式取全部元数据。
    // class-validator 0.14 将 @Length 注册为 customValidation，约束为 [min, max]
    const metas = getMetadataStorage().getTargetValidationMetadatas(
      User,
      User.name,
      false,
      false,
    );
    const lengthRule = metas.find(
      (m) => m.propertyName === "username" && !!m.constraints?.length,
    );
    expect(lengthRule).toBeDefined();
    expect(lengthRule!.constraints).toEqual([3, 128]);
  });
});

describe("DB-007: SystemConfig.value 为无上限 TEXT", () => {
  it("value 列显式声明 text 类型", () => {
    const column = getMetadataArgsStorage()
      .columns.filter((c) => c.target === SystemConfig)
      .find((c) => c.propertyName === "value");
    expect(column).toBeDefined();
    expect(column!.options.type).toBe("text");
  });
});

describe("DB-002: ExecutionLogLine.createdAt", () => {
  it("存在 createdAt 字段且为 create date column（清理时间依据）", () => {
    const column = getMetadataArgsStorage()
      .columns.filter((c) => c.target === ExecutionLogLine)
      .find((c) => c.propertyName === "createdAt");
    expect(column).toBeDefined();
    expect(column!.mode).toBe("createDate");
  });

  it("存在 createdAt 单列索引（分批 DELETE 范围扫描用）", () => {
    const index = getMetadataArgsStorage()
      .indices.filter((i) => i.target === ExecutionLogLine)
      .find((i) => i.columns.length === 1 && i.columns[0] === "createdAt");
    expect(index).toBeDefined();
  });
});
