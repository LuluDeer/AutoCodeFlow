import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { Application } from "./application.entity";

/**
 * R4（部署模型评审 2026-10-23 §4.1 方案 A / §P1）：不可变部署事件表。
 *
 * app_deployments 是「(应用×执行器) 一行现状 + 进程状态」，行复用语义下每次
 * 重新部署/升级/回滚都在**原地覆盖**同一行——「同一版本部署过多少次」「谁在
 * 什么时候做了什么动作」没有任何持久化载体。本表以 append-only 事件流补齐
 * 追溯面：每个部署域写动作落一行短事实快照，读面（/events、deployCount 聚合）
 * 消费。纯旁路记录——不改 app_deployments 的状态机/索引/行为。
 *
 * 不可变性是表级约定（只 INSERT，无 UPDATE/DELETE 路径），不建触发器强制。
 * deploymentId 刻意**不带外键**：removeDeployment 会删部署行，事件必须比行
 * 活得久（部署行是现状，事件是历史）。
 */
export enum AppDeploymentEventType {
  /** deploy() 新建部署行（含 approvalRequired 应用的待审批请求行）。 */
  DEPLOY_CREATED = "deploy_created",
  /** deploy() 复用同 (app, executor) 终态行原地重推（「一台设备一行」策略）。 */
  REDEPLOY_REUSED = "redeploy_reused",
  /** DEP-04：审批通过（实际派发动作发生）。 */
  APPROVAL_APPROVED = "approval_approved",
  /** DEP-04：审批拒绝（行落 FAILED）。 */
  APPROVAL_REJECTED = "approval_rejected",
  /** DEP-04：提交者撤回待审批请求（行落 FAILED）。 */
  APPROVAL_CANCELLED = "approval_cancelled",
  /** 叠加升级（upgrade 链——含 R1 deploy-version、旧 rollback alias、
   *  upgrade-all 等全部经 upgrade() 的下发路径）。 */
  UPGRADE = "upgrade",
  /** 停止部署（行落 STOPPED）。 */
  STOP = "stop",
  /** 删除部署行（事件比行活得久——删除前的最后一条事实）。 */
  REMOVE = "remove",
  /** 卡死扫描把在途行判 FAILED（PENDING 5min / DEPLOYING·UPGRADING 10min）。 */
  STUCK_FAILED = "stuck_failed",
}

@Entity("app_deployment_events")
@Index("idx_app_deployment_events_application_created", [
  "applicationId",
  "createdAt",
])
@Index("idx_app_deployment_events_application_type", [
  "applicationId",
  "eventType",
])
export class AppDeploymentEvent {
  @PrimaryGeneratedColumn("uuid") id: string;

  @Column() applicationId: string;

  @ManyToOne(() => Application, { onDelete: "CASCADE" })
  @JoinColumn({ name: "applicationId" })
  application: Application;

  /** 触发本事件的部署行 id；行可能已被 remove 删除（无外键，见类注释）。 */
  @Column({ nullable: true }) deploymentId: string | null;

  @Column({ nullable: true }) executorId: string | null;

  @Column({ nullable: true }) executorAddress: string | null;

  /** AppDeploymentEventType（varchar 承载，同部署行 triggerType 的枚举风格
   *  ——避免 PG enum ALTER 扩值成本）。 */
  @Column({ type: "varchar", nullable: false }) eventType: string;

  /** 动作发生时的版本事实（deploy/upgrade 写 app.version；stop/remove/stuck
   *  写行上 deployedVersion）。动作时未知为 null。 */
  @Column({ nullable: true }) deployedVersion: string | null;

  /** 动作语义（DeploymentTriggerType：manual/upgrade/rollback/approval）。 */
  @Column({ nullable: true }) triggerType: string | null;

  /** 操作人（JWT 用户名；机器路径如卡死扫描为 null）。 */
  @Column({ nullable: true }) operator: string | null;

  /** 短事实快照（reason/runMode/deletedStatus 等标量；**绝不放 env**——
   *  事件表无掩码读面，密钥进事件即泄漏）。 */
  @Column({ type: "jsonb", nullable: true })
  detail: Record<string, unknown> | null;

  @CreateDateColumn() createdAt: Date;
}
