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

  @ApiProperty({ description: "1..128, unique" })
  username: string;

  @ApiProperty({ description: "unique" })
  email: string;

  @ApiProperty({ enum: ["admin", "user"] })
  role: "admin" | "user";

  @ApiProperty({
    description: "Soft-disable switch (login refused when false)",
  })
  isActive: boolean;

  @ApiProperty({ description: "Consecutive failed logins (lockout input)" })
  loginFailCount: number;

  @ApiProperty({ description: "Lockout deadline", nullable: true })
  lockedUntil: Date | null;

  @ApiProperty()
  totpEnabled: boolean;

  @ApiProperty({
    description: "Bumped on password change — revokes old refresh tokens",
  })
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
