import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
// B-9: 上限常量取自零依赖 util（DTO ← util 单向，规避 DTO → service 模块环）
import { TASK_PARAMS_MAX_BYTES, taskParamsByteSize } from "../params-size.util";

/**
 * B-9（调度域审计）：params 体积门统一。
 *
 * 背景：触发参数体积此前只有 webhook 面一道 64KB 门（TaskWebhookService
 * 手写 Buffer.byteLength 检查）——手动/API 触发（TriggerTaskDto.params）与
 * 任务默认 params（CreateTaskDto.params，经 PartialType 同时约束 PATCH）
 * 完全无上限：同一份 params 从 webhook 进来被拒、从手动面进来却能把
 * 数十 MB 的负载写进 tasks / task_executions 两张热表（jsonb 列 + 随每次
 * 派发/历史读取物化），并放大依赖扇出（FEAT-21 注入）与 blockStrategy 闸门
 * 的同参比较成本。现在三个入口共用同一常量，行为一致：
 * - 超限 → 400（DTO 边界给可读错误，而非落库后在各消费方各自炸开）；
 * - null / undefined 不掺和（由 @IsOptional 决定）；
 * - 不可序列化（循环引用等）按超限拒绝——反正落不了库。
 */
@ValidatorConstraint({ name: "taskParamsMaxBytes", async: false })
export class TaskParamsMaxBytesConstraint
  implements ValidatorConstraintInterface
{
  validate(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value !== "object") return true; // 类型错误交给 @IsObject
    const size = taskParamsByteSize(value);
    return size !== null && size <= TASK_PARAMS_MAX_BYTES;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} exceeds ${TASK_PARAMS_MAX_BYTES} bytes (shared limit for create/update/trigger/webhook params)`;
  }
}

/**
 * 校验 params 序列化体积 ≤ TASK_PARAMS_MAX_BYTES。放在 `@IsObject()` 之后：
 * 类型不对时先报类型错误，体积问题只在确实是对象时才报。
 */
export function TaskParamsMaxBytes(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "taskParamsMaxBytes",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: TaskParamsMaxBytesConstraint,
    });
  };
}
