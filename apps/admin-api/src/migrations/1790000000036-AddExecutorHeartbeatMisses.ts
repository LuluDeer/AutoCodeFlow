import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * NETOPT-G P1-7（判死迟滞）：executors 增 `consecutiveHeartbeatMisses` int 列
 * （default 0，非空）。
 *
 * 背景：`markStaleOffline` 修复前是单次墙钟判定——一次扫描命中
 * `lastHeartbeat < now - heartbeatTimeoutMs` 就立即 ONLINE→OFFLINE。跨境链路
 * 单次心跳失败率约 4.5%、长尾 RTT 可达 153s（生产实测），"两次相邻失败 +
 * 一次长尾"即踩线。生产当天 10 次判死里 9 次是链路抖动误判（仅 14:09 那次
 * 真由宿主内核软锁引起），每次误判都发离线通知并把执行器从派发候选剔除。
 *
 * 本列让 sweep 走**连续 N 轮确认**：每轮只递增计数，达到阈值才判死；任一心跳
 * 到达即由 heartbeat() 清零。详见实体列注释。
 *
 * 为什么落库而非进程内 Map：admin-api 多副本 + leaderGate 选主，内存计数在
 * 主从切换后归零，判死延迟不可预期。
 *
 * 幂等：ADD COLUMN IF NOT EXISTS + 默认值 0；down 走 DROP COLUMN IF EXISTS
 * ——重放与 revert 均无副作用（先例 1790000000032）。
 *
 * 存量数据：默认 0（= "未错过任何一轮"）。即便某台执行器在迁移瞬间已失联，
 * 它也只会从 0 开始重新累计——最多把判死推迟一个确认窗口，不会造成误判。
 */
export class AddExecutorHeartbeatMisses1790000000036 implements MigrationInterface {
  name = "AddExecutorHeartbeatMisses1790000000036";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "executors"
      ADD COLUMN IF NOT EXISTS "consecutiveHeartbeatMisses" integer NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "executors" DROP COLUMN IF EXISTS "consecutiveHeartbeatMisses"
    `);
  }
}
