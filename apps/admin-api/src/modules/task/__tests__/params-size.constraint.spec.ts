import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { TaskParamsMaxBytesConstraint } from "../dto/params-size.constraint";
import { TASK_PARAMS_MAX_BYTES } from "../params-size.util";
import { CreateTaskDto } from "../dto/create-task.dto";
import { TriggerTaskDto } from "../dto/trigger-task.dto";

/**
 * B-9（调度域审计）：params 体积门统一。
 *
 * 此前只有 webhook 面（TaskWebhookService 手写 Buffer.byteLength 检查）有
 * 64KB 上限——手动/API 触发（TriggerTaskDto.params）与任务默认 params
 * （CreateTaskDto.params，经 PartialType 同时约束 PATCH）完全无上限。三个
 * 入口现共用 TASK_PARAMS_MAX_BYTES 同一常量（params-size.util 单一出处）。
 */

const bigObject = (bytes: number): Record<string, string> => {
  // 每个条目 ~1KB 的 JSON 文本；条目数按目标体积放大
  const entry = "x".repeat(1024);
  const count = Math.ceil(bytes / 1100);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) out[`k${i}`] = entry;
  return out;
};

describe("TaskParamsMaxBytes (B-9)", () => {
  const constraint = new TaskParamsMaxBytesConstraint();

  it("常量与 webhook 面共用同一出处（64KB）", () => {
    expect(TASK_PARAMS_MAX_BYTES).toBe(65_536);
  });

  it("null / undefined 不掺和（@IsOptional 语义）", () => {
    expect(constraint.validate(null)).toBe(true);
    expect(constraint.validate(undefined)).toBe(true);
  });

  it("小对象放行，超限对象拒绝", () => {
    expect(constraint.validate({ a: 1 })).toBe(true);
    expect(constraint.validate(bigObject(TASK_PARAMS_MAX_BYTES + 4096))).toBe(
      false,
    );
  });

  it("不可序列化（循环引用）按超限拒绝", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(constraint.validate(cyclic)).toBe(false);
  });

  it("默认消息带共享上限口径（create/update/trigger/webhook 同门）", () => {
    expect(
      constraint.defaultMessage({ property: "params" } as never),
    ).toContain(String(TASK_PARAMS_MAX_BYTES));
  });

  it("CreateTaskDto.params 超限 → 400（含 create 默认 params 面）", async () => {
    const dto = plainToInstance(CreateTaskDto, {
      name: "t",
      triggerType: "cron",
      params: bigObject(TASK_PARAMS_MAX_BYTES + 4096),
    });
    const errors = await validate(dto, { whitelist: true });
    const paramError = errors.find((e) => e.property === "params");
    expect(paramError).toBeDefined();
    expect(JSON.stringify(paramError?.constraints)).toContain("65536");
  });

  it("TriggerTaskDto.params 超限 → 400（手动/API 触发面）", async () => {
    const dto = plainToInstance(TriggerTaskDto, {
      params: bigObject(TASK_PARAMS_MAX_BYTES + 4096),
    });
    const errors = await validate(dto, { whitelist: true });
    const paramError = errors.find((e) => e.property === "params");
    expect(paramError).toBeDefined();
  });

  it("小 params 照常通过（含 TriggerTaskDto.version 字段不受影响）", async () => {
    const dto = plainToInstance(TriggerTaskDto, {
      params: { orderId: "A-1" },
      version: 3,
    });
    const errors = await validate(dto, { whitelist: true });
    expect(errors).toHaveLength(0);
  });
});
