import { IsArray, IsInt, IsString, Min, ArrayMaxSize } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class AppendLogChunkDto {
  @ApiProperty({
    description: "0-based line number offset of the first line in this chunk",
    example: 0,
  })
  @IsInt()
  @Min(0)
  fromLine: number;

  @ApiProperty({
    description: "Array of log line strings",
    example: ["Starting task...", "Step 1 complete"],
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(2000)
  lines: string[];
}
