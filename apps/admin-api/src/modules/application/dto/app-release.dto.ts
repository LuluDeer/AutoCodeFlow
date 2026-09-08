import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, Max, Min } from "class-validator";
import { Type } from "class-transformer";

/**
 * DEP-01：`/applications/:id/releases` 统一资源的触发方式。
 * 两表（application_versions / app_deployments）历史上均无 trigger 列，
 * 该值按既有持久化信号推导（见 AppDeploymentService.classifyReleaseTrigger），
 * 无法判定时为 unknown —— 属已知来源缺失，详见 docs/api-reference.md。
 */
export type ReleaseTriggerType = "manual" | "upgrade" | "unknown";

/** 操作人来源标注：version.operator = application_versions.createdBy，
 *  当前所有写入路径均未填充该列 → 恒 null，来源缺失标注如下。 */
export const RELEASE_OPERATOR_MISSING_REASON =
  "application_versions.createdBy 未由任何写入路径填充，且 audit_logs 当前不覆盖部署写面（AUTH-05 扩展后自动可得）";

/**
 * DEP-01：一行 = 一次「版本发布」在部署语义下的统一追溯视图。
 * 数据源 = application_versions（版本号/包地址/gitCommit/操作人）
 *        + app_deployments 按 deployedVersion 聚合（部署时间/状态/触发方式）。
 */
export interface AppReleaseRow {
  /** application_versions.id；纯部署历史（无版本快照行）时为 null */
  id: string | null;
  /** 版本号；无快照且部署行 deployedVersion 为空时为 null */
  version: string | null;
  /** 包地址：取版本快照 snapshot.packageUrl（部署当时值）。
   *  无快照或快照未含该字段时 null —— 不回退应用当前值（当前值在 GET /applications/:id） */
  packageUrl: string | null;
  gitCommit: string | null;
  /** 该版本「最近一次」部署完成时刻（app_deployments.deployedAt ?? createdAt 最大值）；无部署时 null */
  deployedAt: string | null;
  /** 最近一次部署行 id；无部署时 null */
  latestDeploymentId: string | null;
  /** 最近一次部署状态（pending/deploying/running/stopped/failed/upgrading）；无部署时 null */
  deploymentStatus: string | null;
  /** 该版本累计部署次数（同版本多实例滚动部署各计一次） */
  deploymentCount: number;
  /** 最近一次部署所在执行器地址；无部署时 null */
  executorAddress: string | null;
  /** 执行模式 once/daemon/scheduled（app_deployments.runMode）；无部署时 null */
  runMode: string | null;
  /** 触发方式（推导语义，见 ReleaseTriggerType 注释）；无部署时 null */
  triggerType: ReleaseTriggerType | null;
  /** 操作人：application_versions.createdBy —— 当前恒 null（来源缺失见 operatorMissingReason） */
  operator: string | null;
  operatorSource: "application_versions.createdBy";
  operatorMissingReason: string;
  /** 生成该版本快照的来源部署行 id */
  sourceDeploymentId: string | null;
  /** application_versions.status（released/deploying/failed）；纯部署行时为部署状态字符串 */
  status: string;
  /** 版本行创建时刻（快照诞生时间）；纯部署行时为 deployedAt */
  createdAt: string | null;
  /** 是否由部署记录合成（应用从未为本次部署保存版本快照，如心跳先到的竞态） */
  synthetic: boolean;
}

/** DEP-01：/applications/:id/releases 查询参数（默认 50，上限 200，防全表）。 */
export class ListReleasesQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 50;
}
