import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { DECORATORS } from "@nestjs/swagger";
import { getMetadataArgsStorage } from "typeorm";
import {
  ExecutionListItemDto,
  TaskExecutionResponseDto,
} from "../dto/task-response.dto";
import { TaskExecution } from "../entities/task-execution.entity";
import { projectExecutionListColumns } from "../execution-list-projection";

/**
 * ADR-017 阶段 3 读面收口：`task_executions.executorId` 必须出现在执行读 DTO 上。
 *
 * 背景（为什么缺了它就是个真缺陷）：阶段 3 把 `uq_executors_address` 收窄为
 * partial（仅 push 行），pull 模式**允许同地址多行并存**——两个互不相通的内网
 * 各有一台 `192.168.1.100:8002` 是合法且常见的形态。此时 `executorAddress`
 * 不再唯一指代一行执行器，前端只按地址解析执行器名会在撞址时把 A 机器的执行
 * 显示成 B 机器。迁移 `1790000000055-AddTaskExecutionsExecutorId` 已加列、实体
 * 已声明，唯独响应 DTO 没暴露——**读面少一个字段不会报错，只会静默显示错误
 * 的机器名**，正是本轮反复在修的那类静默损坏。
 *
 * 走 swagger 元数据反射（`DECORATORS.API_MODEL_PROPERTIES`）而不是读源码正则：
 * openapi.json / api-types.ts 正是由这份元数据派生的，断言它即断言真实契约，
 * 且经 `Reflect.getMetadata` 沿原型链读——`ExecutionListItemDto extends
 * TaskExecutionResponseDto` 的继承关系一并被覆盖。
 *
 * 反证（已实测）：删掉 `TaskExecutionResponseDto.executorId` 的字段声明与本
 * 装饰器，本文件前三条用例立刻变红。
 */

/** 读某属性上的 swagger 元数据（沿原型链，子类继承可见）。 */
function swaggerProperty(
  target: object,
  propertyKey: string,
): Record<string, unknown> | undefined {
  return Reflect.getMetadata(
    DECORATORS.API_MODEL_PROPERTIES,
    target,
    propertyKey,
  ) as Record<string, unknown> | undefined;
}

describe("TaskExecutionResponseDto.executorId（ADR-017 阶段 3 行身份）", () => {
  it("声明了 executorId：swagger 元数据在原型上可反射到", () => {
    // 实例作为 target：装饰器把元数据定义在 prototype 上，沿原型链可读。
    const meta = swaggerProperty(new TaskExecutionResponseDto(), "executorId");
    expect(meta).toBeDefined();
  });

  it("形状与仓库既有可空 uuid 列一致（nullable + format: uuid）", () => {
    const meta = swaggerProperty(new TaskExecutionResponseDto(), "executorId");
    expect(meta).toMatchObject({ nullable: true, format: "uuid" });
  });

  it("与 executorAddress 相邻并存（只靠地址解析会在撞址时指错机器）", () => {
    // 两者必须同时在契约里：新增 executorId 是为了**和**地址配对使用
    //（id 优先、地址兜底），任一缺失都会让撞址场景重新退化。
    for (const key of ["executorId", "executorAddress"]) {
      expect(
        swaggerProperty(new TaskExecutionResponseDto(), key),
      ).toBeDefined();
    }
  });

  it("ExecutionListItemDto 继承该字段（两个列表端点读到它才有意义）", () => {
    const meta = swaggerProperty(new ExecutionListItemDto(), "executorId");
    expect(meta).toBeDefined();
    expect(meta).toMatchObject({ nullable: true, format: "uuid" });
  });

  it("值随实例化透传（运行时读面不改动也带出该列——DTO 是发布契约，不是过滤器）", () => {
    const uuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    // 索引访问是刻意的：直接 `dto.executorId` 会在字段被删时变成**编译错误**，
    // 反而让本文件的断言级失败全部看不到（文件编译不过 → 0 例运行）。用索引
    // 访问保证判据跑得到断言，牙齿由下面这条元数据断言提供。
    const dto = plainToInstance(TaskExecutionResponseDto, {
      id: uuid,
      executorAddress: "192.168.1.100:8002",
      executorId: uuid,
    }) as unknown as Record<string, unknown>;
    expect(dto["executorId"]).toBe(uuid);
    expect(dto["executorAddress"]).toBe("192.168.1.100:8002");
    // 契约守卫：透传本身不依赖 DTO（class-transformer 默认 exposeAll），
    // 所以「字段确实被发布」必须由元数据断言钉住，否则本用例会变成恒真。
    expect(
      swaggerProperty(new TaskExecutionResponseDto(), "executorId"),
    ).toBeDefined();
  });

  it("存量行（迁移前派发）executorId 为 null 可透传（不得被丢弃或改成 undefined）", () => {
    const dto = plainToInstance(TaskExecutionResponseDto, {
      executorAddress: "192.168.1.100:8002",
      executorId: null,
    }) as unknown as Record<string, unknown>;
    expect(dto["executorId"]).toBeNull();
    expect(
      swaggerProperty(new TaskExecutionResponseDto(), "executorId"),
    ).toBeDefined();
  });

  it("设计约束：不引入服务端名称解析字段（executorAppName 等）", () => {
    // 名称解析刻意留在前端 useExecutorNames（id 优先/地址兜底）。服务端 join
    // 会让 PERF-03 读投影纪律作废，并与前端既有钩子形成两个会漂移的事实源。
    for (const forbidden of [
      "executorAppName",
      "executorName",
      "executorDisplayName",
    ]) {
      expect(
        swaggerProperty(new TaskExecutionResponseDto(), forbidden),
      ).toBeUndefined();
    }
  });
});

describe("ADR-017 阶段 3：executorId 已随「排除表」投影自动进入列表读", () => {
  it("实体上确实存在 executorId 列（读投影的输入）", () => {
    const columns = getMetadataArgsStorage()
      .columns.filter((c) => c.target === TaskExecution)
      .map((c) => c.propertyName);
    expect(columns).toContain("executorId");
  });

  it("由真实实体列派生的列表投影含 executorId，且仍排除两个重型 text 列", () => {
    // 复刻 executionListSelectColumns 的输入（repo.metadata.columns 的属性名
    // 全集）：新增列走排除表，故 executorId 必然入选——这正是「列表读无需改动」
    // 的机制证据，而不是靠人肉比对清单。
    const all = getMetadataArgsStorage()
      .columns.filter((c) => c.target === TaskExecution)
      .map((c) => c.propertyName);
    const projected = projectExecutionListColumns(all);

    expect(projected).toContain("executorId");
    expect(projected).toContain("executorAddress");
    expect(projected).not.toContain("logs");
    expect(projected).not.toContain("aiAnalysis");
  });

  it("方向性对照：把 executorId 从全集中去掉就没有它（判据非恒真）", () => {
    // 守卫：上面那条断言若因「projected 是个恒真全集」而通过，这里会露馅。
    const all = ["id", "executorAddress", "logs", "aiAnalysis"];
    expect(projectExecutionListColumns(all)).not.toContain("executorId");
  });
});

describe("读面完整性契约：实体列 ⊆ 执行读 DTO 声明（防「加了列没加读面」复发）", () => {
  /** DTO 上经 @ApiProperty/@ApiPropertyOptional 声明的属性名（含继承）。 */
  const dtoPropertyNames = (target: object): string[] =>
    (
      (Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES_ARRAY, target) as
        string[] | undefined) ?? []
    ).map((key) => key.replace(/^:/, ""));

  const entityColumnNames = (): string[] =>
    getMetadataArgsStorage()
      .columns.filter((c) => c.target === TaskExecution)
      .map((c) => c.propertyName);

  it("executorId 这一列正是本契约要覆盖的对象（判据自守）", () => {
    // 守卫：若实体列扫描因装饰器形态变化而扫不到列，下面那条「全部覆盖」会
    // 变成对空集的恒真断言——先证明扫描确实看得见 executorId。
    expect(entityColumnNames()).toContain("executorId");
  });

  it("TaskExecution 的每一列都在 TaskExecutionResponseDto 上有声明", () => {
    const declared = new Set(dtoPropertyNames(new TaskExecutionResponseDto()));
    const missing = entityColumnNames().filter((c) => !declared.has(c));
    // 报数组而不是布尔：失败时直接点名缺哪一列（executorId 的缺陷形态就是
    // 「实体有、DTO 没有」，此前无任何测试会发现）。
    expect(missing).toEqual([]);
  });

  it("子类 ExecutionListItemDto 同样覆盖每一列（列表读面不得比详情面窄）", () => {
    const declared = new Set(dtoPropertyNames(new ExecutionListItemDto()));
    const missing = entityColumnNames().filter((c) => !declared.has(c));
    expect(missing).toEqual([]);
  });

  it("对照：凭空多出的列会被上面这条判据抓住（非恒真）", () => {
    const declared = new Set(dtoPropertyNames(new TaskExecutionResponseDto()));
    expect(declared.has("someColumnThatDoesNotExist")).toBe(false);
  });
});
