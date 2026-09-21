import "reflect-metadata";
import { validate } from "class-validator";
import { DEFAULT_PROJECT_ID } from "../../../modules/project/project.entity";
import { CreateTaskDto } from "../../../modules/task/dto/create-task.dto";
import { isUuidShape } from "../is-uuid-shape.decorator";

/**
 * 生产故障回归：`@IsUUID()` 拒绝默认项目自身。
 *
 * 症状（用户报）：应用管理里创建任务报
 *   `Validation failed: projectId must be a UUID`
 *
 * 根因：`DEFAULT_PROJECT_ID` 的版本位是 `0`，validator.js 的 isUUID 只认
 * 版本 1–5（外加恰好全零的 nil UUID）。而 `GET /projects` **无条件**返回默认
 * 项目行，于是下拉框里唯一可见的选项恰好是唯一会被 400 拒绝的值。
 *
 * 本组测试钉住两件事：
 *   1. 默认项目 id 必须能通过 CreateTaskDto 的校验（否则故障重现）；
 *   2. 放宽**仅限版本位** —— 任何非 UUID 形状的输入（含注入类载荷）仍须拒绝，
 *      避免把"修 bug"做成"拆掉校验"。
 */
describe("IsUuidShape：默认项目 id 必须可提交（生产故障回归）", () => {
  /** 用真实 DTO 校验，而不是单独测装饰器——故障就发生在 DTO 这一层。 */
  const validateProjectId = async (projectId: unknown) => {
    const dto = new CreateTaskDto();
    dto.name = "t";
    dto.runtime = "python" as never;
    dto.entrypoint = "main.py";
    (dto as unknown as Record<string, unknown>).projectId = projectId;
    const errors = await validate(dto);
    return errors.filter((e) => e.property === "projectId");
  };

  it("DEFAULT_PROJECT_ID 通过（修复前此用例红：must be a UUID）", async () => {
    // 先钉住前提：这个常量确实是"版本位为 0"的形状，否则本测试会因前提
    // 变化而失去意义（例如将来有人把它换成 v4 主键）。
    expect(DEFAULT_PROJECT_ID).toBe("00000000-0000-0000-0000-000000000001");
    expect(await validateProjectId(DEFAULT_PROJECT_ID)).toHaveLength(0);
  });

  it("普通 v4 UUID 仍然通过（未回归）", async () => {
    expect(
      await validateProjectId("aaaa0000-0000-4000-8000-000000000002"),
    ).toHaveLength(0);
  });

  it("nil UUID 通过", async () => {
    expect(
      await validateProjectId("00000000-0000-0000-0000-000000000000"),
    ).toHaveLength(0);
  });

  it("省略 / null = 未分配，通过", async () => {
    expect(await validateProjectId(undefined)).toHaveLength(0);
    expect(await validateProjectId(null)).toHaveLength(0);
  });

  // ---- 以下为"放宽没有变成拆校验"的对抗用例 ----

  it("空字符串仍被拒绝（未分配的表示是省略或 null，不是空串）", async () => {
    expect(await validateProjectId("")).not.toHaveLength(0);
  });

  it.each([
    ["非 uuid 字符串", "abc"],
    ["段数不足", "00000000-0000-0000-0000"],
    ["段数过多", "00000000-0000-0000-0000-000000000001-extra"],
    ["非十六进制字符", "zzzzzzzz-0000-0000-0000-000000000001"],
    ["长度正确但含 g", "0000000g-0000-0000-0000-000000000001"],
    [
      "SQL 注入形态",
      "00000000-0000-0000-0000-000000000001'; DROP TABLE tasks--",
    ],
    ["路径穿越形态", "../../../etc/passwd"],
    ["空白", "   "],
    ["前后空格", " 00000000-0000-0000-0000-000000000001 "],
    ["数字类型（非字符串）", 12345],
    ["对象", { id: DEFAULT_PROJECT_ID }],
    ["数组", [DEFAULT_PROJECT_ID]],
  ])("拒绝：%s", async (_label, value) => {
    expect(await validateProjectId(value)).not.toHaveLength(0);
  });

  it("URN 前缀与花括号：与 @IsUUID() 一致地**拒绝**（不引入新语法面）", () => {
    // validator.js 13.x 并不接受 urn: 前缀与花括号包裹，故本校验器同样不接受。
    // 放宽范围严格限定在版本位/variant 位。
    expect(isUuidShape(`urn:uuid:${DEFAULT_PROJECT_ID}`)).toBe(false);
    expect(isUuidShape(`{${DEFAULT_PROJECT_ID}}`)).toBe(false);
    expect(isUuidShape("urn:uuid:not-a-uuid")).toBe(false);
  });

  it("放宽面严格限定在版本位/variant 位：除该两位外与 @IsUUID() 判定一致", async () => {
    const validator = await import("validator");
    const samples = [
      DEFAULT_PROJECT_ID,
      "00000000-0000-0000-0000-000000000000",
      "aaaa0000-0000-4000-8000-000000000002",
      "aaaa0000-0000-4000-0000-000000000002", // variant 位非 8/9/a/b
      "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa", // v7
      "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa", // v1
      "",
      "abc",
      "00000000-0000-0000-0000-000000000001'; DROP TABLE tasks--",
      "../../../etc/passwd",
      " 00000000-0000-0000-0000-000000000001 ",
      "urn:uuid:aaaa0000-0000-4000-8000-000000000002",
    ];
    for (const s of samples) {
      const strict = validator.default.isUUID(s, "all");
      const shape = isUuidShape(s);
      // 本校验器只可能"更宽"，绝不更严 —— 更严会让既有合法值被拒（正是本次故障）。
      if (strict) {
        expect({ input: s, shape }).toEqual({ input: s, shape: true });
      }
    }
  });

  it("装饰器导出的判定函数与约束行为一致（纯函数可单测）", () => {
    expect(isUuidShape(DEFAULT_PROJECT_ID)).toBe(true);
    expect(isUuidShape("aaaa0000-0000-4000-8000-000000000002")).toBe(true);
    expect(isUuidShape("")).toBe(false);
    expect(isUuidShape(undefined)).toBe(false);
    expect(isUuidShape(null)).toBe(false);
    expect(isUuidShape(42)).toBe(false);
  });
});
