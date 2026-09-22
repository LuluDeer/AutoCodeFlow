import { IsString, IsOptional, IsBoolean, MaxLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class UpsertConfigDto {
  // 审计 E-P2-S2：管理面配置写 DTO 的字符串字段此前无长度上限。
  // 虽为 admin-only，纵深防御仍需封顶——超长 value 会撑大行宽 / 拖慢渲染，
  // 也能被用来写入无界大文本。各档与库列/实际用途对齐：
  //   key(200) / description(2000) / value(10000) / valueType(32，枚举短词)。
  @ApiProperty()
  @IsString()
  @MaxLength(200)
  key: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  value?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ required: false, default: "string" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  valueType?: string;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  isSecret?: boolean;
}
