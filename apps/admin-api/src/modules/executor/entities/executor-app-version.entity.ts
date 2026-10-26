import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { Executor } from "./executor.entity";
import { Application } from "../../application/entities/application.entity";
import type {
  DeployedAppReport,
  InstalledPackageReport,
} from "../deployed-apps.util";

export type { DeployedAppReport, InstalledPackageReport };

/**
 * R3-A（部署模型评审 2026-10-23 §4.3 / §九 9.3-1）：设备级应用版本**事实**表。
 *
 * 一行 = (executorId, applicationId) 的最新一份设备事实，来源是执行器心跳的
 * `deployedApps` 数组（结构校验见 deployed-apps.util.ts）。它回答的是
 * 「这台设备的 apps/<appId>/ 下现在是什么」——current 软链指向哪版、哪些版本
 * 还留在 releases/ 上；部署动作的**历史**追溯走 app_deployment_events（R4），
 * 两表语义互补、不互相替代。
 *
 * 写入语义（ExecutorService.applyReportedAppVersions，心跳/注册共用）：
 * 心跳带 deployedApps → **整替**该执行器全部行（数组里没有的应用行删除 =
 * 设备已卸载）；键缺失（旧执行器）→ 完全不动（fail-honest「无数据」）。
 * 幂等：同一载荷重复上报不产生重复行也不改写未变化的行。
 *
 * 外键级联（迁移 1790000000063）：executorId → executors ON DELETE CASCADE
 * （设备行删除即设备离场，事实随之清理）；applicationId → applications
 * ON DELETE CASCADE（应用删除已扇出设备卸载 NETOPT-8③，事实随应用消失）。
 */
@Entity("executor_app_versions")
@Index(
  "UQ_executor_app_versions_executor_application",
  ["executorId", "applicationId"],
  { unique: true },
)
@Index("idx_executor_app_versions_application", ["applicationId"])
export class ExecutorAppVersion {
  @PrimaryGeneratedColumn("uuid") id: string;

  /** 事实所属执行器行（心跳按指纹/地址解析出的行身份，恒非空）。 */
  @Column({ type: "uuid" }) executorId: string;

  @ManyToOne(() => Executor, { onDelete: "CASCADE" })
  @JoinColumn({ name: "executorId" })
  executor: Executor;

  /** 部署时的 applicationId（心跳契约的 appId）。 */
  @Column({ type: "uuid" }) applicationId: string;

  @ManyToOne(() => Application, { onDelete: "CASCADE" })
  @JoinColumn({ name: "applicationId" })
  application: Application;

  /** 设备 current 软链指向的版本；无 current（未部署成功/已卸载残留）null。 */
  @Column({ type: "varchar", nullable: true })
  currentVersion: string | null;

  /** current 软链指向的 release 目录名（版本 + 部署 ID 后缀）。 */
  @Column({ type: "varchar", nullable: true })
  currentReleaseKey: string | null;

  /** 设备 releases/ 下仍保留的版本集合（prune 后快照；设备自报，非中台推断）。 */
  @Column({ type: "jsonb", nullable: true })
  retainedVersions: string[] | null;

  /** once/daemon/scheduled（varchar 承载，枚举扩值免 ALTER，先例
   *  app_deployment_events.eventType）；设备侧无记录 null。 */
  @Column({ type: "varchar", nullable: true })
  runMode: string | null;

  /** 最近一次部署完成时刻（设备上报）；无记录 null。 */
  @Column({ type: "timestamptz", nullable: true })
  lastDeployedAt: Date | null;

  /**
   * 本行事实的最后落库时刻。只在**行内容真的变化**时刷新（幂等心跳不重写
   * 未变化的行）——它不是设备活性：设备是否还在上报看 executors.lastHeartbeat
   * （30s 心跳面），本列是「这份版本事实的新鲜度」。
   */
  @Column({ type: "timestamptz" })
  lastReportedAt: Date;

  @CreateDateColumn() createdAt: Date;

  @UpdateDateColumn() updatedAt: Date;
}
