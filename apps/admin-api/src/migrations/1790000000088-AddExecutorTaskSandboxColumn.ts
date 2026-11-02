import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * S4-C4（沙箱姿态在控制面可见）：`executors` 补一列**任务沙箱姿态**。
 *
 * ## 为什么需要（这是本项的全部价值）
 *
 * `TASK_SANDBOX` 此前只在执行器本地读一次（executor-node `config.ts` 的
 * `taskSandbox` / executor-python `config.py` 的 `task_sandbox`），**不上报**：
 * 心跳载荷只建模 `registrationConflict`，admin 心跳白名单 DTO 里没有这个字段，
 * 执行器实体只有 cpu/mem/running 一类指标列。于是「某台机器到底在不在
 * fail-closed 沙箱里」只能 SSH 上机看环境变量——「默认关」是运维的**显式
 * 取舍**还是**疏忽**在控制面上不可区分，安全评审无法进行。
 *
 * 这一列把姿态变成**可见事实**（协议 v9 心跳键 `taskSandbox: '' | 'bwrap'`）。
 *
 * ## 为什么可空、为什么**不回填**
 *
 * 存量行没有这个事实（列上线前从未采集过）。任何回填都是**伪造安全证据**——
 * 运维会据此认为「这台确实没开沙箱（显式取舍）」，而真相是「没人问过它」。
 * NULL 的语义因此是精确的：**未上报**（旧执行器 / 本列上线前的行）。
 *
 * 三态（见实体注释）：NULL = 未上报 ≠ `''` = 已上报且直跑 ≠ `'bwrap'` =
 * 已上报且沙箱。**把 NULL 读成 `''` 就退回了「看不出来」的原状**，这是本项
 * 唯一的失败模式。
 *
 * ## 为什么 metadata-only（不 CONCURRENTLY、不分批）
 *
 * 加**可空、无 DEFAULT** 的列在 PG 只改系统目录（不重写表、不长时间持
 * ACCESS EXCLUSIVE），故没有 CONCURRENTLY 的必要，也不需要回填脚本。down
 * 对称删列（`IF EXISTS`，重复执行安全）。
 *
 * ## 回滚的代价（必须知道）
 *
 * down 会丢掉姿态观测——沙箱本身、任务执行、派发全不受影响；代价只是
 * 「哪台执行器开着沙箱」重新变成只能上机看的事实。**不回滚执行器上报**：
 * 回退的推荐姿势是前端隐藏该字段、保留上报（纯展示回退，不删列）——删列
 * 会让下一次上报变成静默丢弃。
 */
export class AddExecutorTaskSandboxColumn1790000000088 implements MigrationInterface {
  name = "AddExecutorTaskSandboxColumn1790000000088";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 单列一条 ALTER TABLE（而不是逗号串）：对称性守卫
    // scripts/check-migration-symmetry.mjs 的 RE_ADD_COLUMN / RE_DROP_COLUMN 只
    // 建模单列形态，逗号串里的第二列扫不到（详见 1790000000085 的同款注释）。
    //
    // varchar(16) 而非 text：取值域只有 '' 与 'bwrap'（协议 enum 同值），16 是
    // 留了余量的硬上界——真出现超长值说明上报面出错，宁可落库失败被看见，
    // 也不要在库里静静养出一个没人解释的长字符串。
    await queryRunner.query(
      `ALTER TABLE "executors" ADD COLUMN IF NOT EXISTS "taskSandbox" varchar(16) NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executors" DROP COLUMN IF EXISTS "taskSandbox"`,
    );
  }
}
