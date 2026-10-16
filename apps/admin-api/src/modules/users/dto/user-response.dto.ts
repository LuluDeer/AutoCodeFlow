import { ApiProperty } from "@nestjs/swagger";

/**
 * ARCH-23 / N-12（2026-10-07 A1 批）：用户域响应契约。
 * password/totpSecret/oidcSub 三列实体带 @Exclude（ClassSerializerInterceptor
 * 全局剥离），DTO 不声明——契约=实际响应。
 */

/** users 行的安全投影（减三个 @Exclude 列）。 */
export class UserResponseDto {
  @ApiProperty()
  id: number;

  @ApiProperty({ description: "1..128 字符，唯一" })
  username: string;

  @ApiProperty({ description: "唯一" })
  email: string;

  @ApiProperty({ enum: ["admin", "user"] })
  role: "admin" | "user";

  @ApiProperty({ description: "软禁用开关（为 false 时拒绝登录）" })
  isActive: boolean;

  @ApiProperty({ description: "连续登录失败次数（锁定判定的输入）" })
  loginFailCount: number;

  @ApiProperty({
    nullable: true,
    description: "锁定截止时间",
  })
  lockedUntil: Date | null;

  @ApiProperty()
  totpEnabled: boolean;

  @ApiProperty({ description: "修改密码时递增——使旧的 refresh token 失效" })
  sessionVersion: number;

  @ApiProperty({ nullable: true })
  lastTotpCounter: number | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

/** GET /users —— paginate() 双键信封（list/items 并存，R-21）。 */
export class PaginatedUsersDto {
  @ApiProperty({ type: [UserResponseDto] })
  list: UserResponseDto[];

  @ApiProperty({ type: [UserResponseDto] })
  items: UserResponseDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  pageSize: number;

  @ApiProperty()
  totalPages: number;
}

/** DELETE /users/:id —— 软删回执。 */
export class UserDeleteResponseDto {
  @ApiProperty({ enum: [true] })
  deleted: true;
}
