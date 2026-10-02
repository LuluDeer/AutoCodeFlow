import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * N-15（MUTEX-01 扩展）：互斥组作用域——单点互斥（设备维度，现状）/ 全局互斥
 * （跨设备组级串行）。
 *
 * ── 需求 ─────────────────────────────────────────────────────────────────
 * 现有互斥组键 = 设备×组（同设备串行，跨设备并发），覆盖「紫鸟浏览器多店铺」
 * 类场景（每台设备同时操作一个店铺）。但有一类资源是**平台级单例**：单点登录
 * 的网站自动化（其他设备登录会顶号）——需要组内全平台同时最多 N 条执行，且
 * 不接受单钉一台设备（设备故障即不可运行）。互斥组加 scope 档位：
 * - `device`（默认，存量行为逐字节不变）：同设备×同组串行；
 * - `global`：同组跨设备串行（占坑判定不带设备条件），排队仍走 WAITING +
 *   10s sweep 盲重派 + 占坑重判（唤醒机制零改动，天然支持「等任意设备」）。
 *
 * ── 并发安全（全局档的跨设备竞态）────────────────────────────────────────
 * 设备档的竞态关闭靠 executors 行 FOR UPDATE（同设备派发串行化）。全局档的
 * 竞争者派往**不同设备**——行锁互不相干，两个事务可能各自读到占用 0 双双占坑。
 * 修复：全局档在占坑事务内先 `FOR UPDATE` 锁 **mutex_groups 行**（全平台
 * 同组派发在此串行化），再锁候选 executors 行（容量判定一致性）。锁序固定
 * 「组 → 执行器」：两个全局派发按同序无环；全局 × 设备档并发时设备档不碰
 * 组行、全局档等执行器行锁——无环，无死锁。
 *
 * ── 索引 ────────────────────────────────────────────────────────────────
 * 占用账本仍从执行行推导（status='running' AND mutexGroupId，终态自动释放）。
 * 全局占用查询不带 executorAddress，既有部分索引
 * idx_task_executions_group_occupancy（左前缀 executorAddress）伺服不了，
 * 补一个组维度的同谓词部分索引。
 *
 * 幂等：ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS；
 * down 逆序回收（索引 → 列）。
 */
export class AddMutexGroupScope1790000000052 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mutex_groups" ADD COLUMN IF NOT EXISTS "scope" varchar NOT NULL DEFAULT 'device'`,
    );
    await queryRunner.query(
      `ALTER TABLE "mutex_groups" DROP CONSTRAINT IF EXISTS "chk_mutex_groups_scope"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mutex_groups" ADD CONSTRAINT "chk_mutex_groups_scope" CHECK ("scope" IN ('device', 'global'))`,
    );
    // 全局档占用判定（不带设备条件）的部分索引——与设备档索引同谓词、
    // 组维度单列（全局判定只需 group + status）。
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_task_executions_group_occupancy_global"
       ON "task_executions" ("mutexGroupId")
       WHERE "status" = 'running' AND "mutexGroupId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_task_executions_group_occupancy_global"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mutex_groups" DROP CONSTRAINT IF EXISTS "chk_mutex_groups_scope"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mutex_groups" DROP COLUMN IF EXISTS "scope"`,
    );
  }
}
