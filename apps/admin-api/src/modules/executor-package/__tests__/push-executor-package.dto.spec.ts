import { ValidationPipe, BadRequestException } from "@nestjs/common";
import { PushExecutorPackageDto } from "../dto/executor-package.dto";

/**
 * 审计 E-P2-S3：push 端点入参此前是 `@Body("executorIds")` 内联类型，
 * 不走 class-validator。旧实现：非 UUID 字符串也被透传给 pushToExecutors，
 * 且无数组长度上限。本 spec 钉住：元素须 v4 UUID、数组 ≤100。
 */
describe("PushExecutorPackageDto (E-P2-S3 校验)", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  function validate(value: object): Promise<PushExecutorPackageDto> {
    return pipe.transform(value, {
      type: "body",
      metatype: PushExecutorPackageDto,
    }) as Promise<PushExecutorPackageDto>;
  }

  const uuid1 = "11111111-1111-4111-8111-111111111111";
  const uuid2 = "22222222-2222-4222-8222-222222222222";

  it("接受合法的 v4 UUID 列表", async () => {
    const result = await validate({ executorIds: [uuid1, uuid2] });
    expect(result.executorIds).toEqual([uuid1, uuid2]);
  });

  it("接受空数组（push 到所有在线执行器）", async () => {
    const result = await validate({ executorIds: [] });
    expect(result.executorIds).toEqual([]);
  });

  it("接受省略 executorIds（push 到所有在线执行器）", async () => {
    const result = await validate({});
    expect(result.executorIds).toBeUndefined();
  });

  it("拒绝非 UUID 元素", async () => {
    await expect(validate({ executorIds: ["not-a-uuid"] })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("拒绝混合了非法元素的列表", async () => {
    await expect(validate({ executorIds: [uuid1, "garbage"] })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("拒绝超过 100 个的列表", async () => {
    const ids = Array.from({ length: 101 }, (_, i) =>
      i === 0 ? uuid1 : uuid2,
    );
    await expect(validate({ executorIds: ids })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("恰好 100 个仍可通过（边界）", async () => {
    const ids = Array.from({ length: 100 }, () => uuid1);
    const result = await validate({ executorIds: ids });
    expect(result.executorIds).toHaveLength(100);
  });
});
