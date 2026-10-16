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
  @ApiProperty({ example: "admin" })
  @IsString()
  @IsNotEmpty()
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
