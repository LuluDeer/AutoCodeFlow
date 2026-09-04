import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsNotEmpty, MinLength, MaxLength } from "class-validator";

export class LoginDto {
  @ApiProperty({ example: "admin" })
  @IsString()
  @IsNotEmpty()
  // L-1: bound the username to a sane length so attackers cannot probe with
  // multi-megabyte usernames (which the bcrypt path would happily hash).
  @MaxLength(128)
  username: string;

  @ApiProperty({ example: "password123" })
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password: string;
}
