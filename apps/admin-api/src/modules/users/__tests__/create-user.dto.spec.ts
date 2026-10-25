import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateUserDto } from "../dto/create-user.dto";
import { UpdateUserDto } from "../dto/update-user.dto";

/**
 * F-18（UIAUDIT P3-11）：用户名长度上限（@MaxLength(128)）。
 *
 * 此前 create/update DTO 的 username 仅 @IsString @IsNotEmpty——前后端一致地松，
 * 多 KB 用户名可入库（PG varchar 溢出风险由 DB 层兜底报错）。上限 128 对齐
 * DB 列 users.username varchar(128)（entity DB-006）与 LoginDto 的
 * sane-length 先例（L-1）；UpdateUserDto 经 PartialType 传播同一约束。
 */
const validBase = {
  username: "alice",
  email: "alice@example.com",
  password: "Str0ng!Pass",
};

describe("CreateUserDto username 长度上限（F-18）", () => {
  it("边界内（128 字符）通过校验", async () => {
    const dto = plainToInstance(CreateUserDto, {
      ...validBase,
      username: "u".repeat(128),
    });
    const errors = await validate(dto);
    const usernameErrors = errors.find((e) => e.property === "username");
    expect(usernameErrors).toBeUndefined();
  });

  it("超限（129 字符）被 maxLength 拒绝", async () => {
    const dto = plainToInstance(CreateUserDto, {
      ...validBase,
      username: "u".repeat(129),
    });
    const errors = await validate(dto);
    const usernameErrors = errors.find((e) => e.property === "username");
    expect(usernameErrors).toBeDefined();
    expect(usernameErrors?.constraints).toHaveProperty("maxLength");
  });

  it("UpdateUserDto（PartialType）继承同一上限", async () => {
    const dto = plainToInstance(UpdateUserDto, { username: "u".repeat(129) });
    const errors = await validate(dto);
    const usernameErrors = errors.find((e) => e.property === "username");
    expect(usernameErrors).toBeDefined();
    expect(usernameErrors?.constraints).toHaveProperty("maxLength");
  });
});
