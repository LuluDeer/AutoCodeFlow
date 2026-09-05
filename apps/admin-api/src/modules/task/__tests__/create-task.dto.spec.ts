import { ValidationPipe, BadRequestException } from "@nestjs/common";
import { CreateTaskDto } from "../dto/create-task.dto";
import { UpdateTaskDto } from "../dto/update-task.dto";

/**
 * R6: POST /api/tasks 携带字符串 id（如 "abc"）此前只有 @IsString 拦截，
 * 会一路穿到 PG 主键插入触发 22P02/23505 类 500。id 是 UUID 主键，
 * 校验必须在 DTO 边界完成（非法 id → 400）。UpdateTaskDto 经
 * PartialType 继承同一校验器，一并回归。
 */
describe("CreateTaskDto / UpdateTaskDto id validation (R6)", () => {
  // 与 main.ts 全局管道同配置
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  const validateCreate = (value: object) =>
    pipe.transform(value, {
      type: "body",
      metatype: CreateTaskDto,
    }) as Promise<CreateTaskDto>;

  const validateUpdate = (value: object) =>
    pipe.transform(value, {
      type: "body",
      metatype: UpdateTaskDto,
    }) as Promise<UpdateTaskDto>;

  const UUID_V4 = "550e8400-e29b-41d4-a716-446655440000";
  const UUID_V1 = "c2f1a86e-1a2b-11ef-9f39-0242ac120002";

  describe("CreateTaskDto", () => {
    it("accepts a body without id (server-generated PK)", async () => {
      const result = await validateCreate({ name: "t1", triggerType: "api" });
      expect(result.id).toBeUndefined();
    });

    it("accepts a valid UUID v4 id", async () => {
      const result = await validateCreate({
        id: UUID_V4,
        name: "t1",
        triggerType: "api",
      });
      expect(result.id).toBe(UUID_V4);
    });

    it("rejects a plain string id with 400 (was a 500 before R6)", async () => {
      await expect(
        validateCreate({ id: "abc", name: "t1", triggerType: "api" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects a non-v4 UUID id", async () => {
      await expect(
        validateCreate({ id: UUID_V1, name: "t1", triggerType: "api" }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("UpdateTaskDto (PartialType inherits the id validator)", () => {
    it("accepts a valid UUID v4 id", async () => {
      const result = await validateUpdate({ id: UUID_V4, name: "t1" });
      expect(result.id).toBe(UUID_V4);
    });

    it("rejects a plain string id with 400", async () => {
      await expect(validateUpdate({ id: "abc" })).rejects.toThrow(
        BadRequestException,
      );
    });

    it("id stays optional", async () => {
      const result = await validateUpdate({ name: "t1" });
      expect(result.id).toBeUndefined();
    });
  });

  // R6: executorId（任务级 executor pinning）——executor 主键是 UUID，
  // 非 UUID 字符串穿到 dispatch 的 findOne 同样会触发 PG 22P02 类 500，
  // 边界必须 400。UpdateTaskDto 经 PartialType 继承同一校验器。
  describe("executorId validation (R6 pinning)", () => {
    it("accepts a valid UUID executorId on create", async () => {
      const result = await validateCreate({
        name: "t1",
        triggerType: "api",
        executorId: UUID_V4,
      });
      expect(result.executorId).toBe(UUID_V4);
    });

    it("rejects a non-UUID executorId with 400", async () => {
      await expect(
        validateCreate({
          name: "t1",
          triggerType: "api",
          executorId: "not-a-uuid",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("executorId stays optional", async () => {
      const result = await validateCreate({ name: "t1", triggerType: "api" });
      expect(result.executorId).toBeUndefined();
    });

    it("UpdateTaskDto inherits the executorId validator", async () => {
      await expect(validateUpdate({ executorId: "nope" })).rejects.toThrow(
        BadRequestException,
      );
      const result = await validateUpdate({ executorId: UUID_V4 });
      expect(result.executorId).toBe(UUID_V4);
    });
  });

  // W-21: requirements — the DTO boundary enforces STRUCTURE (array of
  // non-empty strings, ≤50); the option-like-spec semantic guard lives in
  // TaskService.normalizeTaskDto and the executors. UpdateTaskDto inherits
  // every validator via PartialType.
  describe("requirements validation (W-21)", () => {
    it("accepts an array of pip/npm spec strings", async () => {
      const result = await validateCreate({
        name: "t1",
        triggerType: "api",
        requirements: [
          "requests>=2.31",
          "rich[markup]==13.7.1",
          "django>=4,<5",
        ],
      });
      expect(result.requirements).toEqual([
        "requests>=2.31",
        "rich[markup]==13.7.1",
        "django>=4,<5",
      ]);
    });

    it("stays optional", async () => {
      const result = await validateCreate({ name: "t1", triggerType: "api" });
      expect(result.requirements).toBeUndefined();
    });

    it("rejects a non-array value", async () => {
      await expect(
        validateCreate({
          name: "t1",
          triggerType: "api",
          requirements: "requests",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects non-string elements", async () => {
      await expect(
        validateCreate({
          name: "t1",
          triggerType: "api",
          requirements: [123],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects empty-string elements", async () => {
      await expect(
        validateCreate({
          name: "t1",
          triggerType: "api",
          requirements: ["ok", ""],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects an over-cap array (>50)", async () => {
      const many = Array.from({ length: 51 }, (_, i) => `pkg${i}`);
      await expect(
        validateCreate({
          name: "t1",
          triggerType: "api",
          requirements: many,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("UpdateTaskDto inherits the requirements validators", async () => {
      const ok = await validateUpdate({ requirements: ["flask==3.0.0"] });
      expect(ok.requirements).toEqual(["flask==3.0.0"]);
      await expect(validateUpdate({ requirements: [42] })).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
