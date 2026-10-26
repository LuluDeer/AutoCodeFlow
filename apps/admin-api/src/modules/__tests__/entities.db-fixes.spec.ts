import { getMetadataArgsStorage } from "typeorm";
import { getMetadataStorage } from "class-validator";
import { User } from "../users/entities/user.entity";
import { SystemConfig } from "../config/entities/system-config.entity";
import { ExecutionLogLine } from "../task/entities/execution-log-line.entity";
import { TaskExecution } from "../task/entities/task-execution.entity";
import { ExecutorPackage } from "../executor-package/executor-package.entity";
import { ApplicationVersion } from "../application/entities/application-version.entity";
// R32-C2：Executor 的安全列依赖 select:false 才不被整实体 save 回写。
import { Executor } from "../executor/entities/executor.entity";

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

/**
 * PK-10（DEEP_REVIEW 0ef3bbe）实体↔DB 元数据漂移三连回归：
 * (1) fileSize bigint 运行时 string → 列级 transformer 数值化；
 * (2) task_executions→tasks FK 实体 onDelete SET NULL ↔ 迁移 CASCADE；
 * (3) execution_log_lines 分区表联合 PK (id, createdAt) 实体不知情。
 * 用 getMetadataArgsStorage 钉住装饰器产物——migration:generate 不会再被漂移元数据误导。
 */
describe("PK-10 (1): ExecutorPackage.fileSize bigint → number transformer", () => {
  it("fileSize 列声明 type bigint 且带 read 端 transformer（string→number）", () => {
    const column = getMetadataArgsStorage()
      .columns.filter((c) => c.target === ExecutorPackage)
      .find((c) => c.propertyName === "fileSize");
    expect(column).toBeDefined();
    expect(column!.options.type).toBe("bigint");
    expect(column!.options.transformer).toBeDefined();
    const transformer = column!.options.transformer as unknown as {
      to: (v?: number) => number | undefined;
      from: (v?: string | number) => number;
    };
    // node-pg 对 int8 读回为 string：from 必须把 "12345" → 12345。
    expect(transformer.from("12345")).toBe(12345);
    // number 原样透传；null/undefined 回退 0。
    expect(transformer.from(9876)).toBe(9876);
    expect(transformer.from(undefined)).toBe(0);
    // to 透传（写路径 number 原样绑定）。
    expect(transformer.to(42)).toBe(42);
  });
});

describe("PK-10 (2): TaskExecution.task FK onDelete 对齐 DB 迁移 CASCADE", () => {
  it("TaskExecution → Task 关系 onDelete === 'CASCADE'（迁移 1717473142679 事实）", () => {
    const relation = getMetadataArgsStorage()
      .relations.filter((r) => r.target === TaskExecution)
      .find((r) => r.propertyName === "task");
    expect(relation).toBeDefined();
    // 曾为 "SET NULL"——列 NOT NULL 下删任务即外键报错。以迁移为准钉死 CASCADE。
    expect(relation!.options.onDelete).toBe("CASCADE");
  });
});

describe("PK-10 (3): ExecutionLogLine 联合 PK (id, createdAt) 对齐分区表", () => {
  it("id 为 primary generated（SERIAL）", () => {
    const column = getMetadataArgsStorage()
      .columns.filter((c) => c.target === ExecutionLogLine)
      .find((c) => c.propertyName === "id");
    expect(column).toBeDefined();
    expect(column!.options.primary).toBe(true);
    expect(column!.mode).toBe("regular");
  });

  it("createdAt 同时是 createDate 且是联合主键列（分区键）", () => {
    const column = getMetadataArgsStorage()
      .columns.filter((c) => c.target === ExecutionLogLine)
      .find((c) => c.propertyName === "createdAt");
    expect(column).toBeDefined();
    expect(column!.mode).toBe("createDate");
    // 迁移 1789900000002 的 PK_execution_log_lines = (id, createdAt)：
    // @CreateDateColumn({ primary: true }) 让 createDate 列同时进 primaryColumns。
    expect(column!.options.primary).toBe(true);
  });
});

/**
 * R32-C2（L4 收口）：**「整实体 save 不会覆盖此列」这条护栏必须有测试守着**。
 *
 * 背景：heartbeat / register 用 TypeORM  的 `save(entity)` 回写执行器行。save 不是盲写
 * 整行——它先现取 DB 行做 diff，且 `entityValue === undefined` 的列直接跳过。于是
 * `select: false` 的列在快照里是 undefined ⇒ 永不进 SET ⇒ 不会被旧快照覆盖。
 *
 * 这正是「轮换后的 tokenHash 不会被心跳回滚」的**唯一**原因：R32-C2 用真 TypeORM + 真
 * PostgreSQL 实测过两条——
 *   · A：快照 tokenHash=undefined → 并发 update(hash-new) → save(快照) → DB 仍 hash-new；
 *   · B（反证）：把该行改成 addSelect 装载 tokenHash → 并发轮换 → save 把 DB 写回 hash-old。
 *
 * 也就是说：**把 select:false 去掉等于悄悄打开「旧凭据复活」的通道，而任何既有测试都不会红**
 * （单测拿到的快照同样没有该列，行为一致）。这条 spec 就是那层护栏本身。
 *
 * 只钉「安全性依赖它」的三列；将来若新增依赖 select:false 的凭据列，请一并加入。
 */
describe("R32-C2: 安全列必须保持 select:false（整实体 save 的护栏）", () => {
  const REQUIRED_SELECT_FALSE: Array<[string, string]> = [
    [
      "tokenHash",
      "per-executor bcrypt 令牌哈希：去掉即「心跳整实体 save 回滚轮换」→ 旧凭据复活",
    ],
    ["agentCapabilities", "Agent 协作能力：去掉即可能被心跳旧快照擦掉"],
    ["agentCapabilitiesUpdatedAt", "Agent 能力租约续报时间：同上"],
  ];

  it.each(REQUIRED_SELECT_FALSE)(
    "Executor.%s 的列定义必须是 select: false（%s）",
    (propertyName) => {
      const column = getMetadataArgsStorage()
        .columns.filter((c) => c.target === Executor)
        .find((c) => c.propertyName === propertyName);
      expect(column).toBeDefined();
      expect(column!.options.select).toBe(false);
    },
  );
});
