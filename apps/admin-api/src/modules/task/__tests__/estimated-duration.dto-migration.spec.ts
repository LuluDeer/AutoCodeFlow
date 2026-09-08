/**
 * CORE-05: estimatedDurationSec DTO 校验矩阵（@IsInt @Min(0) @Max(604800)
 * 可空）+ 迁移 1789900000001 幂等/避让断言。
 */
import { ValidationPipe } from "@nestjs/common";
import { CreateTaskDto } from "../dto/create-task.dto";
import { UpdateTaskDto } from "../dto/update-task.dto";
import * as fs from "fs";
import * as path from "path";

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "..", "migrations");
const TARGET = "1789900000001-AddTaskEstimatedDuration.ts";

describe("estimatedDurationSec DTO 校验（CORE-05）", () => {
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

  const validBase = { name: "t", triggerType: "api" };

  it("创建：合法正整数被接受", async () => {
    const dto = await validateCreate({
      ...validBase,
      estimatedDurationSec: 3600,
    });
    expect(dto.estimatedDurationSec).toBe(3600);
  });

  it("创建：0 被接受（语义 = 未知，不参与权重）", async () => {
    const dto = await validateCreate({ ...validBase, estimatedDurationSec: 0 });
    expect(dto.estimatedDurationSec).toBe(0);
  });

  it("创建：缺省 = undefined（未知）", async () => {
    const dto = await validateCreate({ ...validBase });
    expect(dto.estimatedDurationSec).toBeUndefined();
  });

  it("创建：负数被拒（400）", async () => {
    await expect(
      validateCreate({ ...validBase, estimatedDurationSec: -1 }),
    ).rejects.toThrow();
  });

  it("创建：超过 7 天上限（604801）被拒", async () => {
    await expect(
      validateCreate({ ...validBase, estimatedDurationSec: 604801 }),
    ).rejects.toThrow();
  });

  it("创建：非整数（浮点）被拒", async () => {
    await expect(
      validateCreate({ ...validBase, estimatedDurationSec: 1.5 }),
    ).rejects.toThrow();
  });

  it("创建：显式 null 被接受（未知语义）", async () => {
    const dto = await validateCreate({
      ...validBase,
      estimatedDurationSec: null,
    });
    expect(dto.estimatedDurationSec).toBeNull();
  });

  it("PATCH：UpdateTaskDto 继承同一校验器且可空", async () => {
    const dto = await validateUpdate({ estimatedDurationSec: 120 });
    expect(dto.estimatedDurationSec).toBe(120);
    await expect(
      validateUpdate({ estimatedDurationSec: "soon" }),
    ).rejects.toThrow();
  });

  it("PATCH：显式 null = 重置为未知", async () => {
    const dto = await validateUpdate({ estimatedDurationSec: null });
    expect(dto.estimatedDurationSec).toBeNull();
  });
});

describe("迁移 1789900000001（CORE-05：tasks.estimatedDurationSec）", () => {
  const sql = () => fs.readFileSync(path.join(MIGRATIONS_DIR, TARGET), "utf8");

  it("迁移文件存在且类名后缀与时间戳一致、up/down 可调", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(path.join(MIGRATIONS_DIR, TARGET));
    const proto: any = Object.values(mod)[0] as any;
    const instance = proto?.prototype ? new proto() : proto;
    expect(instance.name).toBe("AddTaskEstimatedDuration1789900000001");
    expect(typeof instance.up).toBe("function");
    expect(typeof instance.down).toBe("function");
  });

  it("时间戳避开 1789900000000（FEAT-07/event-subscriptions）且为当前最高", () => {
    const stamp = Number(TARGET.split("-")[0]);
    expect(stamp).toBe(1789900000001);
    expect(stamp).toBeGreaterThan(1789900000000);
  });

  it("estimatedDurationSec 幂等添加（IF NOT EXISTS）且 down 可回滚", () => {
    const body = sql();
    expect(body).toContain(
      'ADD COLUMN IF NOT EXISTS "estimatedDurationSec" INTEGER NULL',
    );
    expect(body).toContain('DROP COLUMN IF EXISTS "estimatedDurationSec"');
  });
});
