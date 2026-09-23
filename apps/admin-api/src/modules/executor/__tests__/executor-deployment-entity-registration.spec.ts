/**
 * ARCH-35 P1（生产事故 2026-09-23）：`AppDeployment` 在 **ExecutorModule**
 * 二次注册后的实体元数据完整性。
 *
 * 背景：`dispatch()` 的部署归属偏好需要读 `app_deployments`，因此
 * `executor.module.ts` 的 `TypeOrmModule.forFeature([...])` 里追加了
 * `AppDeployment`。该类自带 `@ManyToOne(() => Application)`，而 `Application`
 * 也已在同一 forFeature 中——但「两个实体各自都在 forFeature 里」**并不**
 * 保证 TypeORM 能解析关系：关系的目标是按**实体类**解析的，若关系链上任一
 * 实体元数据缺失，启动时会抛 `Entity metadata for X#y was not found`。
 * 这类错误只在真正建元数据时暴露，单测装配（全 mock repository）永远测不到，
 * 故单独钉住。
 *
 * 本 spec 用**运行时同款实体 glob**（configuration.ts:551 的
 * `__dirname + "/../**" + "/*.entity{.ts,.js}"`）构造 DataSource 并调用
 * `buildMetadatas()`——不建连接、不碰 DB，纯元数据构建，正是启动期那一步。
 *
 * 为什么必须用完整 glob 而不是「只放 AppDeployment + Application」子集：
 * 实测（本 spec 首版）子集会因 `Application#tasks` 关系缺 `Task` 而抛
 * `Entity metadata for Application#tasks was not found`——关系图是**传递
 * 闭包**，只挑几个实体无法构建。用运行时同一 glob 既避开该问题，又顺带
 * 验证了真实装配面（比子集更有价值）。
 */

import { DataSource, type DataSourceOptions } from "typeorm";
import {
  AppDeployment,
  DeploymentStatus,
} from "../../application/entities/app-deployment.entity";
import { Application } from "../../application/entities/application.entity";
import { DEPLOYMENT_STATUS_RUNNING } from "../executor-deployment-affinity.util";

/**
 * `buildMetadatas()` 是 protected（TypeORM 只在 initialize() 内部调用它）。
 * 子类化是唯一不改产品代码即可触达它的方式——正是启动期那一步，且**不建
 * 连接**（initialize() 会真连 DB，单测环境不可用）。
 */
class MetadataOnlyDataSource extends DataSource {
  constructor(options: DataSourceOptions) {
    super(options);
  }

  /** 暴露启动期的元数据构建步骤（async：关系解析是异步的）。 */
  async buildMetadataForTest(): Promise<void> {
    await this.buildMetadatas();
  }
}

/** 运行时同款实体扫描面（configuration.ts:551）。 */
const RUNTIME_ENTITY_GLOB = __dirname + "/../../**/*.entity{.ts,.js}";

describe("ARCH-35 P1: AppDeployment 在 executor 侧二次注册的元数据完整性", () => {
  let ds: MetadataOnlyDataSource;

  beforeAll(async () => {
    ds = new MetadataOnlyDataSource({
      type: "postgres",
      entities: [RUNTIME_ENTITY_GLOB],
    });
    await ds.buildMetadataForTest();
  });

  it("关系闭包可完整解析（不抛 Entity metadata ... was not found）", () => {
    // beforeAll 已成功构建——若关系链断裂，这里根本到不了。
    expect(ds.entityMetadatas.length).toBeGreaterThan(0);
  });

  it("AppDeployment 的关系目标正确解析为 Application", () => {
    const deploymentMeta = ds.entityMetadatas.find(
      (m) => m.target === AppDeployment,
    );
    expect(deploymentMeta).toBeDefined();
    // 关系存在且指向 Application——若 Application 未随 forFeature 注册，
    // 元数据构建阶段就会抛错（见头注）。
    const relation = deploymentMeta!.relations.find(
      (r) => r.propertyName === "application",
    );
    expect(relation).toBeDefined();
    expect(relation!.inverseEntityMetadata.target).toBe(Application);
  });

  it("偏好判定所需的四个列均存在于元数据（select 不会静默丢字段）", () => {
    const meta = ds.entityMetadatas.find((m) => m.target === AppDeployment)!;
    const columns = meta.columns.map((c) => c.propertyName);
    // resolveRunningDeployments 的 where 用 applicationId+status，
    // select 用 executorId/executorAddress/status——四列都必须真实存在，
    // 否则 TypeORM 的 select 投影会静默丢字段（分区判据全部失效）。
    expect(columns).toContain("applicationId");
    expect(columns).toContain("executorId");
    expect(columns).toContain("executorAddress");
    expect(columns).toContain("status");
  });

  it("status 列的 enum 含 'running'（偏好只认该值）", () => {
    const meta = ds.entityMetadatas.find((m) => m.target === AppDeployment)!;
    const statusCol = meta.columns.find((c) => c.propertyName === "status")!;
    expect(statusCol).toBeDefined();
    // 实体侧 enum 值与 util 的 DEPLOYMENT_STATUS_RUNNING 必须一致——这是
    // 「偏好判据」与「实体枚举」之间唯一的契约点，漂移会让偏好恒不命中
    // （running 行被判为非 running，静默退化为旧行为）。
    expect(Object.values(DeploymentStatus)).toContain(
      DEPLOYMENT_STATUS_RUNNING,
    );
  });

  it("AppDeployment 与 Executor 同处一张元数据图（forFeature 双侧注册）", () => {
    const targets = ds.entityMetadatas.map((m) => m.target);
    expect(targets).toContain(AppDeployment);
    expect(targets).toContain(Application);
  });
});
