import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

import { findDispatchParamKeyCollisions } from "../../executor/dispatch-params-keys.util";

/**
 * EXEC-07b（第 3 轮审计残差）：params 键名大小写折叠冲突的**保存边界**闸。
 *
 * 执行器侧已在 accept 阶段 400（node/python 同规则、同文案），但那是「派发
 * 之后」——用户提交任务时看不到问题，只会在触发后收到执行器错误。这里把同一
 * 判据前置到 DTO：
 *
 *   `{"limit": 1, "LIMIT": 2}` → 两键折叠成 `AUTOFLOW_LIMIT`，后者静默覆盖
 *   前者（任务读到非预期参数）。拒绝比"保留一个、丢掉另一个"诚实：谁该赢没有
 *   业务依据。
 *
 * 与执行器判据逐条一致：只看能成为 env 名的键（非法键本来 skip-and-warn，不
 * 参与）、按最终 env 名分组。错误文案是英文（DTO 校验层惯例，见
 * params-size.constraint），并给出冲突键与目标 env 名便于用户直接改。
 */
@ValidatorConstraint({ name: "taskParamsNoKeyCaseCollision", async: false })
export class TaskParamsNoKeyCaseCollisionConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === null || value === undefined || typeof value !== "object") {
      return true; // 类型错误交给 @IsObject
    }
    return (
      findDispatchParamKeyCollisions(value as Record<string, unknown>)
        .length === 0
    );
  }

  defaultMessage(args: ValidationArguments): string {
    const collisions = findDispatchParamKeyCollisions(
      args.value as Record<string, unknown>,
    );
    const detail = collisions
      .map((c) => `${c.keys.join(", ")} -> ${c.envKey}`)
      .join("; ");
    return (
      `${args.property} has keys that collide after upper-casing ` +
      `(${detail}); each collision would silently overwrite one value in the ` +
      `same AUTOFLOW_<KEY> env var — keep only one key per env name ` +
      `(reason=param_key_case_collision)`
    );
  }
}

/** 拒绝「大写折叠后同名」的 params 键。放在 @IsObject/@TaskParamsMaxBytes 之后。 */
export function TaskParamsNoKeyCaseCollision(
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "taskParamsNoKeyCaseCollision",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: TaskParamsNoKeyCaseCollisionConstraint,
    });
  };
}
