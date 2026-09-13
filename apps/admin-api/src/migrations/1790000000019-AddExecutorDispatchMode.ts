import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * ARCH-32（执行器 pull 模式派发 / NAT 回连）：executors 增 dispatchMode 列。
 *
 * 背景（ADR-015）：
 * - 任务派发当前为纯 push——中心端向执行器 address 发起入站 POST，
 *   多层 NAT 内的执行器不可达（用户确认该场景存在）；
 * - pull 模式下执行器只用出站连接（长轮询 POST /executors/pull 取任务，
 *   心跳/回调同为出站），调度侧选坑语义不变，仅传输层分支。
 *
 * 列语义：varchar(16) NOT NULL DEFAULT 'push'——存量执行器零影响；
 * 'pull' 由执行器 register 上报时写入（executor.service.register 白名单）。
 *
 * 幂等：IF [NOT] EXISTS 写法，重复执行与 revert 重放均无副作用。
 */
export class AddExecutorDispatchMode1790000000019 implements MigrationInterface {
  name = "AddExecutorDispatchMode1790000000019";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "executors"
      ADD COLUMN IF NOT EXISTS "dispatchMode" VARCHAR(16) NOT NULL DEFAULT 'push'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "executors" DROP COLUMN IF EXISTS "dispatchMode"
    `);
  }
}
