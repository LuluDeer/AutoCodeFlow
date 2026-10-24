import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsUUID,
} from "class-validator";

/**
 * R1（2026-10-24 部署模型评审 §4.2）：应用回滚拆分后的两个显式动作请求体。
 *
 * 旧 POST /applications/:id/rollback/:targetId 把「按版本快照恢复应用当前
 * 字段」与「对全部 RUNNING 部署行下发升级」捆绑为一个动作——用户只想改回
 * 记录面时也被迫重启全部实例。拆分后：
 *   · set-current-version 只做字段恢复（绝不触碰部署行/设备）；
 *   · deploy-version = 字段恢复 + 可选按执行器点名的下发（缺省=全部 RUNNING，
 *     与旧 rollback 一致）。
 * 旧端点保留为 deprecated alias（内部组合两者，行为不变）。
 */

/** POST /applications/:id/set-current-version 请求体。 */
export class SetCurrentVersionDto {
  @ApiProperty({
    format: "uuid",
    description:
      "application_versions.id（版本快照主键，非 version 号字符串）——status 必须为 released",
  })
  @IsUUID()
  versionId: string;
}

/** POST /applications/:id/deploy-version 请求体。 */
export class DeployVersionDto {
  @ApiProperty({
    format: "uuid",
    description:
      "application_versions.id（版本快照主键，非 version 号字符串）——status 必须为 released；下发前先按该快照恢复应用当前字段",
  })
  @IsUUID()
  versionId: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: 100,
    description:
      "仅对这些执行器对应的 RUNNING 部署行下发（重复 id 幂等去重）。缺省 = 该应用全部 RUNNING 部署行（与旧 rollback 一致）。执行器无部署行/行状态不可下发的进响应 skipped 明细，不报错",
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  executorIds?: string[];
}
