import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsStrongPassword,
  IsString,
  MaxLength,
} from "class-validator";
import { UserRole } from "../entities/user.entity";

export class CreateUserDto {
  @ApiProperty({ example: "admin", maxLength: 128 })
  @IsString()
  @IsNotEmpty()
  // F-18（UIAUDIT P3-11）：用户名长度上限——此前 create/update DTO 仅
  // @IsNotEmpty，多 KB 用户名可入库（varchar 溢出由 DB 层兜底报错）。
  // 上限 128 对齐 DB 列 users.username varchar(128)（entity DB-006）与
  // LoginDto 的 sane-length 先例（L-1）；UpdateUserDto 经 PartialType 传播，
  // 两个写面同步收口。
  @MaxLength(128)
  username: string;

  @ApiProperty({ example: "admin@example.com" })
  @IsEmail()
  email: string;

  @ApiProperty({
    minLength: 8,
    maxLength: 128,
    description: "至少 8 个字符，且必须包含大写字母、小写字母、数字和特殊字符",
  })
  @IsStrongPassword(
    {
      minLength: 8,
      minLowercase: 1,
      minUppercase: 1,
      minNumbers: 1,
      minSymbols: 1,
    },
    {
      message:
        "Password must be at least 8 characters and contain uppercase, lowercase, digits, and special characters",
    },
  )
  @MaxLength(128) // prevent bcrypt DoS — bcrypt processes at most 72 bytes
  password: string;

  @ApiPropertyOptional({ enum: UserRole, default: UserRole.USER })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}
