import { ApiProperty } from "@nestjs/swagger";
import { IsArray, IsUUID, ArrayMinSize } from "class-validator";

export class BatchTaskIdsDto {
  @ApiProperty({
    description: "Task ID list",
    type: [String],
    example: ["uuid-1", "uuid-2"],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID("4", { each: true })
  taskIds: string[];
}
