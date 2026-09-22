import { ValidationPipe, BadRequestException } from "@nestjs/common";
import { UpsertConfigDto } from "../dto/upsert-config.dto";

/**
 * 审计 E-P2-S2：配置写 DTO 字符串字段补 @MaxLength 后的回归。
 * 旧实现：key/value/description/valueType 只有 @IsString，无长度上限——
 * 超长 value（如数万字符）会被照单入库。本 spec 钉住「超长 value 被 400 拒」。
 */
describe("UpsertConfigDto (E-P2-S2 长度上限)", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  function validate(value: object): Promise<UpsertConfigDto> {
    return pipe.transform(value, {
      type: "body",
      metatype: UpsertConfigDto,
    }) as Promise<UpsertConfigDto>;
  }

  it("接受正常长度的 key/value/description", async () => {
    const result = await validate({
      key: "executor.sharedToken",
      value: "env-token",
      description: "shared token",
    });
    expect(result.key).toBe("executor.sharedToken");
    expect(result.value).toBe("env-token");
  });

  it("拒绝超长 value（>10000）", async () => {
    await expect(
      validate({ key: "k", value: "x".repeat(10001) }),
    ).rejects.toThrow(BadRequestException);
  });

  it("拒绝超长 key（>200）", async () => {
    await expect(validate({ key: "k".repeat(201) })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("拒绝超长 description（>2000）", async () => {
    await expect(
      validate({ key: "k", description: "d".repeat(2001) }),
    ).rejects.toThrow(BadRequestException);
  });

  it("value 恰好 10000 字符仍可通过（边界）", async () => {
    const result = await validate({ key: "k", value: "x".repeat(10000) });
    expect(result.value).toHaveLength(10000);
  });
});
