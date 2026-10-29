import { validate } from "class-validator";

import { TaskParamsNoKeyCaseCollision } from "../param-key-collision.constraint";

/** EXEC-07b：保存边界的 params 键名折叠冲突闸。 */
class WithParams {
  @TaskParamsNoKeyCaseCollision()
  params?: Record<string, unknown>;
}

const errorsFor = async (params: unknown) => {
  const dto = new WithParams();
  dto.params = params as Record<string, unknown>;
  return validate(dto);
};

describe("TaskParamsNoKeyCaseCollision（EXEC-07b）", () => {
  it("折叠冲突 → 拒绝，文案给出冲突键与目标 env 名", async () => {
    const errors = await errorsFor({ limit: 1, LIMIT: 2 });
    expect(errors).toHaveLength(1);
    const message = errors[0].constraints?.taskParamsNoKeyCaseCollision ?? "";
    // 排序口径与协议向量一致：ASCII 码位序（大写在前）
    expect(message).toContain("LIMIT, limit");
    expect(message).toContain("AUTOFLOW_LIMIT");
    expect(message).toContain("param_key_case_collision");
  });

  it("大小写不同但折叠后不同名 → 放行（不扩大拒绝面）", async () => {
    await expect(
      errorsFor({ Mode: "a", mode_id: "b", "1ST": "c" }),
    ).resolves.toHaveLength(0);
  });

  it("非法键不参与判定（本来就不会注入）", async () => {
    await expect(errorsFor({ "A=B": 1, "a=b": 2 })).resolves.toHaveLength(0);
  });

  it("多组冲突一次报全，按 env 名排序（用户改一次就够）", async () => {
    const errors = await errorsFor({
      limit: 1,
      LIMIT: 2,
      token: "a",
      TOKEN: "b",
    });
    const message = errors[0].constraints?.taskParamsNoKeyCaseCollision ?? "";
    expect(message.indexOf("AUTOFLOW_LIMIT")).toBeLessThan(
      message.indexOf("AUTOFLOW_TOKEN"),
    );
    expect(message).toContain("TOKEN, token");
  });

  it("null/undefined/非对象 → 放行（类型错误交给 @IsObject）", async () => {
    await expect(errorsFor(undefined)).resolves.toHaveLength(0);
    await expect(errorsFor(null)).resolves.toHaveLength(0);
    await expect(errorsFor([["limit", 1]])).resolves.toHaveLength(0);
  });
});
