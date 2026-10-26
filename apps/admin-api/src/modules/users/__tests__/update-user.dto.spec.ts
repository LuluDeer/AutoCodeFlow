import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateUserDto } from "../dto/update-user.dto";

/**
 * 2026-10-25 审计：UpdateUserDto 两个收口的 DTO 侧钉子。
 *
 *   · P3-2：currentPassword 补 @MaxLength(128)——该字段直达 bcrypt.compare
 *     （users.controller S12 分支），无上限时超长口令可用于 bcrypt DoS；
 *     对齐 CreateUserDto.password 的既有上限（L-1 先例，bcrypt 至多处理
 *     72 字节，128 已覆盖）。
 *   · P1-1：isActive 增补进 DTO（@IsBoolean）——此前全仓零写路，禁用账号
 *     的止血链不可达；布尔约束挡住 truthy 字符串（"false"/0）写穿。
 */
const base = { username: "alice" };

describe("UpdateUserDto 校验（P3-2 + P1-1）", () => {
  it("currentPassword 边界内（128 字符）通过", async () => {
    const dto = plainToInstance(UpdateUserDto, {
      ...base,
      currentPassword: "p".repeat(128),
    });
    const errors = await validate(dto);
    expect(
      errors.find((e) => e.property === "currentPassword"),
    ).toBeUndefined();
  });

  it("currentPassword 超限（129 字符）被 maxLength 拒绝", async () => {
    const dto = plainToInstance(UpdateUserDto, {
      ...base,
      currentPassword: "p".repeat(129),
    });
    const errors = await validate(dto);
    const cp = errors.find((e) => e.property === "currentPassword");
    expect(cp).toBeDefined();
    expect(cp?.constraints).toHaveProperty("maxLength");
  });

  it("isActive 缺省仍然合法（PATCH 语义：不带即不改）", async () => {
    const dto = plainToInstance(UpdateUserDto, base);
    const errors = await validate(dto);
    expect(errors.find((e) => e.property === "isActive")).toBeUndefined();
  });

  it("isActive 布尔 true/false 通过", async () => {
    for (const isActive of [true, false]) {
      const dto = plainToInstance(UpdateUserDto, { ...base, isActive });
      const errors = await validate(dto);
      expect(errors.find((e) => e.property === "isActive")).toBeUndefined();
    }
  });

  it('isActive 非布尔（字符串 "false" / 数字 0）被 isBoolean 拒绝', async () => {
    for (const isActive of ["false", 0, 1]) {
      const dto = plainToInstance(UpdateUserDto, { ...base, isActive });
      const errors = await validate(dto);
      const field = errors.find((e) => e.property === "isActive");
      expect(field).toBeDefined();
      expect(field?.constraints).toHaveProperty("isBoolean");
    }
    // null/undefined 走 @IsOptional 的「缺省即不改」语义，不在拒绝面内
    const nullDto = plainToInstance(UpdateUserDto, { ...base, isActive: null });
    const nullErrors = await validate(nullDto);
    expect(nullErrors.find((e) => e.property === "isActive")).toBeUndefined();
  });
});
