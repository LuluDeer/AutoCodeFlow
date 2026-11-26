import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * ADR-040 / P1 Capability 注册表：`capabilities` 表。
 *
 * 一行 = 一个可被 Agent/Skill/MCP 装载的能力声明。与 task_templates 的分工：
 * 模板固化「任务形态」（触发/运行时/超时），能力固化「能力域身份 + 声明清单」
 * （key/kind/visibility/scope/manifest）。`key` 是稳定标识（migration seed 与运行时
 * 常量同口径），唯一索引下沉到 DB 兜并发。
 *
 * ## manifest 为什么是 jsonb 而非独立列
 *
 * manifest 是能力声明（封闭键集合，见 capability.service.ts 的
 * ALLOWED_MANIFEST_KEYS），形态随 kind 变化；塞进固定列会把「声明」与「运行时配置」
 * 混为一谈。落库前 service 做确定性校验：封闭键 + 禁止 command/hook/script 可执行字段。
 *
 * ## 索引
 *
 * - `uq_capabilities_key`：key 唯一（幂等硬闸 + 按 key 点查）。
 * - `idx_capabilities_kind` / `idx_capabilities_visibility`：列表按域/可见性过滤。
 */
export type CapabilitySourceType = "builtin" | "registry" | "git" | "folder";

export interface CapabilitySource {
  type: CapabilitySourceType;
  ref?: string;
}

export type CapabilityScopeMode = "managed" | "supervised" | "self_service";

export type CapabilityGuidance = "L1" | "L2" | "L3";

export interface CapabilityScope {
  mode: CapabilityScopeMode;
  guidance: CapabilityGuidance;
}

/** N16：发布背书声明的封闭键形态（signer 必填，at/scope 为可选上下文）。 */
export interface CapabilityAttestation {
  signer: string;
  at?: string;
  scope?: string;
}

@Entity("capabilities")
@Index("idx_capabilities_kind", ["kind"])
@Index("idx_capabilities_visibility", ["visibility"])
export class Capability {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** 稳定标识：`browser` / `filesystem` / 能力域；小写起头的 1-128 字符。 */
  @Column({ type: "varchar", length: 128, unique: true })
  key: string;

  /** skill | mcp | agent | provider | template。 */
  @Column({ type: "varchar", length: 24 })
  kind: string;

  @Column({ type: "varchar", length: 128 })
  label: string;

  @Column({ type: "text", nullable: true })
  description: string | null;

  @Column({ type: "varchar", length: 32, default: "1.0.0" })
  version: string;

  /** { type: builtin|registry|git|folder, ref? }。 */
  @Column({ type: "jsonb", default: { type: "builtin" } })
  source: CapabilitySource;

  /** global | project | private。 */
  @Column({ type: "varchar", length: 16, default: "private" })
  visibility: string;

  /** { mode: managed|supervised|self_service, guidance: L1|L2|L3 }。 */
  @Column({
    type: "jsonb",
    default: { mode: "supervised", guidance: "L2" },
  })
  scope: CapabilityScope;

  /** 能力声明（封闭键集合；写入前经 service 确定性校验）。 */
  @Column({ type: "jsonb" })
  manifest: Record<string, unknown>;

  @Column({ type: "boolean", default: true })
  enabled: boolean;

  /** 创建人身份键（`user:<id>|<username>`）；NULL = 系统/迁移写入。 */
  @Column({ type: "varchar", length: 64, nullable: true })
  createdBy: string | null;

  /** N16：发布者身份键；NULL = 未声明发布者。 */
  @Column({ type: "varchar", length: 128, nullable: true })
  owner: string | null;

  /** N16：部门/角色背书（非个人）；NULL = 未声明背书。 */
  @Column({ type: "varchar", length: 128, nullable: true })
  backer: string | null;

  /** N16：钉死版本（语义化版本或 hash）；NULL = 不钉版本。 */
  @Column({ type: "varchar", length: 64, nullable: true })
  versionPin: string | null;

  /** N16：发布背书声明 `{signer, at?, scope?}`；NULL = 无声明。 */
  @Column({ type: "jsonb", nullable: true })
  attestation: CapabilityAttestation | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}
