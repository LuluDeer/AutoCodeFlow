import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CallbackItemDto } from "../dto/execution-callback.dto";

const EXEC_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

async function errorsFor(payload: Record<string, unknown>) {
  const dto = plainToInstance(CallbackItemDto, payload);
  const errs = await validate(dto, { forbidUnknownValues: false });
  return errs;
}

describe("CallbackItemDto.artifacts（FEAT-05 清单校验）", () => {
  const base = { executionId: EXEC_ID, status: "success" };

  it("缺省不带 artifacts 合法（旧执行器兼容）", async () => {
    expect(await errorsFor(base)).toEqual([]);
  });

  it("合法清单通过", async () => {
    const errs = await errorsFor({
      ...base,
      artifacts: [
        { name: "shot_1.png", size: 123, sha256: "a".repeat(64) },
        { name: "report.csv", size: 45, sha256: "b".repeat(64) },
      ],
    });
    expect(errs).toEqual([]);
  });

  it("嵌套类型：条目被反序列化为 ArtifactManifestItemDto", async () => {
    const dto = plainToInstance(CallbackItemDto, {
      ...base,
      artifacts: [{ name: "x.png", size: 1, sha256: "c".repeat(64) }],
    });
    expect(Array.isArray(dto.artifacts)).toBe(true);
    expect(dto.artifacts![0].name).toBe("x.png");
  });

  it("拒绝带路径分隔符/非法字符的产物名", async () => {
    const errs = await errorsFor({
      ...base,
      artifacts: [{ name: "../etc/passwd", size: 1, sha256: "d".repeat(64) }],
    });
    expect(errs.some((e) => e.property === "artifacts")).toBe(true);
  });

  it("拒绝非 64hex 的 sha256", async () => {
    const errs = await errorsFor({
      ...base,
      artifacts: [{ name: "x.png", size: 1, sha256: "not-a-hash" }],
    });
    expect(errs.some((e) => e.property === "artifacts")).toBe(true);
  });

  it("超过 20 个条目被拒", async () => {
    const items = Array.from({ length: 21 }, (_, i) => ({
      name: `f${i}.bin`,
      size: 1,
      sha256: "e".repeat(64),
    }));
    const errs = await errorsFor({ ...base, artifacts: items });
    expect(errs.some((e) => e.property === "artifacts")).toBe(true);
  });
});
