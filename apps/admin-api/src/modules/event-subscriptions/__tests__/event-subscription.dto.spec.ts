import { ValidationPipe, BadRequestException } from "@nestjs/common";
import { ListDeadLettersQueryDto } from "../dto/event-subscription.dto";

/**
 * B-8: 死信分页查询的入参校验。
 *
 * 此前 page/limit 只有 @Type(() => Number) + @IsOptional——`?page=abc` 经
 * @Type 转成 NaN 后直通 service 的 findAndCount（skip: NaN），TypeORM 生成
 * 非法 SQL → 500。补 @IsInt/@Min/@Max 后在全局 ValidationPipe（transform
 * + whitelist）层即 400。上限与 service 的 clamp 值对齐（limit ≤ 100）。
 */
describe("ListDeadLettersQueryDto（B-8 分页 NaN 直通回归）", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  function validate(value: Record<string, unknown>) {
    return pipe.transform(value, {
      type: "query",
      metatype: ListDeadLettersQueryDto,
    }) as Promise<ListDeadLettersQueryDto>;
  }

  it("合法 page/limit（字符串数字）转换并放行", async () => {
    const result = await validate({ page: "3", limit: "50" });
    expect(result.page).toBe(3);
    expect(result.limit).toBe(50);
  });

  it("空 query 取默认值（page=1, limit=20）", async () => {
    const result = await validate({});
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
  });

  it.each(["abc", "1.5", ""])(
    "非整数 page → 400（不再 NaN 直通）",
    async (p) => {
      await expect(validate({ page: p })).rejects.toThrow(BadRequestException);
    },
  );

  it.each(["abc", "1.5"])("非整数 limit → 400", async (l) => {
    await expect(validate({ limit: l })).rejects.toThrow(BadRequestException);
  });

  it("page=0 / 负数 → 400（@Min(1)）", async () => {
    await expect(validate({ page: "0" })).rejects.toThrow(BadRequestException);
    await expect(validate({ page: "-2" })).rejects.toThrow(BadRequestException);
  });

  it("limit=0 / limit=101 → 400（@Min(1)/@Max(100)，上限对齐 service clamp）", async () => {
    await expect(validate({ limit: "0" })).rejects.toThrow(BadRequestException);
    await expect(validate({ limit: "101" })).rejects.toThrow(
      BadRequestException,
    );
    await expect(validate({ limit: "100" })).resolves.toMatchObject({
      limit: 100,
    });
  });
});
