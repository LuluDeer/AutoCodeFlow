// PK-02（DEEP_REVIEW 0ef3bbe）: PartialType 从 @nestjs/swagger 导入以传播
// @ApiProperty 元数据。
import { PartialType, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";
import { CreateUserDto } from "./create-user.dto";

export class UpdateUserDto extends PartialType(CreateUserDto) {
  // N-12（2026-10-07）：无 swagger 装饰器的属性不会被反射进契约——A-13 的
  // currentPassword 在 API 真实可用却从 openapi.json 消失，前端只能靠手写
  // interface 补。显式声明进契约。
  @ApiPropertyOptional({
    description:
      "非 admin 用户修改自己的密码时必填（SEC-12）；service 落库前会剥离该字段（R19）",
  })
  // L-1 同款（2026-10-25 审计 P3-2）：currentPassword 直达 bcrypt.compare，
  // 无长度上限时超长口令可用于 bcrypt DoS（bcrypt 至多处理 72 字节，128
  // 对齐 CreateUserDto.password 的既有上限先例）。
  @MaxLength(128)
  @IsOptional()
  @IsString()
  currentPassword?: string;

  /**
   * P1-1（2026-10-25 审计）：账号启用/禁用写面。此前 isActive 全仓零写路——
   * 登录闸（ACCOUNT_INACTIVE）、API-Key 属主闸（owner_inactive）、OIDC 闸
   * （OIDC_ACCOUNT_DISABLED）都在读这列，但管理员没有任何途径置 false，
   * 事件止血链实际不可达。
   *
   * 写面纪律（守卫在 users.controller.update）：
   *   · 仅 ADMIN 可变更（对齐 role 的 USER_ROLE_ADMIN_ONLY 形态）；
   *   · ADMIN 不能禁用自己（对齐 remove 的 USER_SELF_DELETE_FORBIDDEN 形态）；
   *   · 置 false 时 service 同步 bump sessionVersion——在途 JWT 即刻 401；
   *     API-Key 面已有 per-request 属主闸（api-keys.service.authenticate 的
   *     owner_inactive，无缓存现读），不重复建机制。
   */
  @ApiPropertyOptional({
    description:
      "账号启用/禁用（ADMIN-only；禁用后登录 403 且在途会话立即失效）",
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
