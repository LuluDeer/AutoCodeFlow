import { ApiProperty } from "@nestjs/swagger";
import { IsString } from "class-validator";

/** N6：IM adapter 接入前的群聊消息自检请求体。 */
export class ScanTextDto {
  @ApiProperty({ description: "待扫描的群聊 @bot 消息原文" })
  @IsString()
  text: string;
}
