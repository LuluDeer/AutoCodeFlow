import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * MUTEX-01（应用互斥组）：把「在同一台设备上不能并发」的一组应用圈在一起。
 *
 * 典型场景：多个应用都对紫鸟浏览器做自动化操作——它们**互相之间**在同一台
 * 设备上必须串行（抢同一个浏览器实例），但与其它无冲突应用（接口类）照常
 * 并发，设备自身的 maxConcurrentTasks 槽位照常封顶。
 *
 * 调度语义（单一事实源，dispatch 占坑事务实现）：
 *   同一台设备上，同一互斥组的执行同时最多 `maxConcurrentPerDevice` 个；
 *   跨组互不影响；跨设备互不影响。
 *
 * 为什么是独立实体而不是应用上的标签字符串：组内并发数必须有**单一事实源**
 * ——两个同组应用各配一个并发数必然打架。组在此集中定义，应用只持引用。
 *
 * 范围取舍（v1，实现于 executor.service dispatch 占坑路径）：
 * - 只约束单播派发（executeMode 默认值）；broadcast 的语义就是「刻意全机队
 *   同时跑」，用户显式选择的行为，不参与互斥。
 * - 组删除（ON DELETE SET NULL）后应用回到「不参与互斥」；在途执行按创建时
 *   的组快照（task_executions.mutexGroupId）走完，不受影响。
 */
@Entity("mutex_groups")
export class MutexGroup {
  @PrimaryGeneratedColumn("uuid") id: string;

  /** 组名（唯一）。仅作展示与选择，调度按 id 关联。 */
  @Column({ unique: true }) name: string;

  /**
   * 同一台设备上该组允许的并发执行数（≥1，默认 1 = 组内串行）。
   * DB CHECK 兜底下界（迁移 1790000000044）；写面 DTO 再校验上界与取整。
   * N-15：scope=global 时本列语义升级为「组内**全平台**并发数」（复用列，
   * UI 文案随 scope 切换）。
   */
  @Column({ type: "int", default: 1 }) maxConcurrentPerDevice: number;

  /**
   * N-15：组作用域（迁移 1790000000052，CHECK 兜底 device/global）。
   * - `device`（默认，存量行为不变）：同设备×同组串行，跨设备并发；
   * - `global`：组内跨设备串行（全平台同时最多 N 条），占坑判定不带设备
   *   条件，跨设备竞态由占坑事务内的 mutex_groups 行 FOR UPDATE 关闭
   *   （锁序 组→执行器）。典型场景：单点登录的网站自动化（多设备登录
   *   顶号，需全局串行且拒绝单钉设备防故障单点）。
   */
  @Column({ type: "varchar", default: "device" }) scope: "device" | "global";

  @Column({ type: "varchar", nullable: true }) description: string | null;

  @CreateDateColumn() createdAt: Date;

  @UpdateDateColumn() updatedAt: Date;
}
