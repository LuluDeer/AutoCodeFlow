import { ApiProperty } from "@nestjs/swagger";
import { IsArray, IsUUID, ArrayMinSize, ArrayMaxSize } from "class-validator";

// R-18（DEEP_REVIEW 0ef3bbe）: 批量任务 ID 列表的单次上限。批量端点用
// Promise.all 并发触发/暂停/删除——无界数组会让一次请求携数千 uuid 炸开成
// 数千并发事务/派发。500 为单次批量硬上限（远超前端分页页宽，正常调用不可达，
// 只拦异常/恶意放大）。
export const BATCH_TASK_IDS_MAX_SIZE = 500;

export class BatchTaskIdsDto {
  @ApiProperty({
    description: `Task ID list (1..${BATCH_TASK_IDS_MAX_SIZE} uuids)`,
    type: [String],
    // R-18: 显式 maxItems 同步契约文档——swagger 插件对显式 @ApiProperty 的
    // 字段不会从 @ArrayMaxSize 推导约束，运行时校验与文档必须一致。
    maxItems: BATCH_TASK_IDS_MAX_SIZE,
    example: ["uuid-1", "uuid-2"],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_TASK_IDS_MAX_SIZE)
  @IsUUID("4", { each: true })
  taskIds: string[];
}
