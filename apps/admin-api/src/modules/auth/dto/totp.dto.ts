import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsNotEmpty, MaxLength, Matches } from "class-validator";

export class TotpCodeDto {
  @ApiProperty({ example: "123456", description: "6 位 TOTP 动态验证码" })
  @IsString()
  @Matches(/^\d{6}$/, { message: "code must be a 6-digit number" })
  code: string;
}

export class TotpVerifyDto {
  @ApiProperty({ example: "admin" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  username: string;

  @ApiProperty({ example: "password123" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;

  @ApiProperty({ example: "123456", description: "6 位 TOTP 动态验证码" })
  @IsString()
  @Matches(/^\d{6}$/, { message: "code must be a 6-digit number" })
  code: string;
}
