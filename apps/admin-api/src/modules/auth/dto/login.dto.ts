import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsNotEmpty, MinLength, MaxLength } from "class-validator";

export class LoginDto {
  @ApiProperty({ example: "admin" })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({ example: "password123" })
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password: string;
}
