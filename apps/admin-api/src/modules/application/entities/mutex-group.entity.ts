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
   */
  @Column({ type: "int", default: 1 }) maxConcurrentPerDevice: number;

  @Column({ type: "varchar", nullable: true }) description: string | null;

  @CreateDateColumn() createdAt: Date;

  @UpdateDateColumn() updatedAt: Date;
}
