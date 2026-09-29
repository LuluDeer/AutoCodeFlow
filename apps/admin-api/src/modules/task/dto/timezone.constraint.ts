import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { isValidTimeZone } from "../maintenance-window.util";

/**
 * P2（时区错位审计）：任务 timezone 的写面校验（DTO 层，给用户可读的 400）。
 *
 * 背景：timezone 此前只有 `@IsString() @IsOptional()`，任意字符串都能落库。
 * 调度侧（scheduler.service getCronOptions）对非法值 warn 后按**服务器默认
 * 时区**跑——用户把 "Asia/Shanghai" 写成 "UTC+8" 或任意垃圾串时，任务静默
 * 换时区触发，窗口评估也曾因此与调度脱钩（维护窗口时区修复的同源问题）。
 * 现在写面直接拒绝非法值。
 *
 * 判定与运行时共用同一探针：`Intl.DateTimeFormat` 对未知时区抛 RangeError
 * （isValidTimeZone，maintenance-window.util）——校验通过即意味着调度器与
 * 窗口评估真的能用它，两端不可能分叉（与 IsCron5Field 收敛到 nodeCron.validate
 * 的同款纪律）。
 *
 * 边界（与调度侧既有行为逐一对齐）：
 * - null / undefined 由 @IsOptional 决定是否被接受，本校验器不掺和；
 * - 空串 / 纯空白 = 未设置（getCronOptions 对 trim 后空串返回 undefined =
 *   服务器默认时区，存量行为），放行；
 * - 校验 trim 后的值——调度侧消费的正是 trim 产物，判定对象必须一致。
 */
@ValidatorConstraint({ name: "isIanaTimezone", async: false })
export class IsIanaTimezoneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    if (trimmed === "") return true; // 未设置语义（对齐调度侧 trim 空行为）
    return isValidTimeZone(trimmed);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a valid IANA time zone (e.g. Asia/Shanghai)`;
  }
}

/**
 * 校验 IANA 时区名。放在 `@IsString()` 之后：类型不对时先报类型错误，
 * 时区问题只在确实是字符串时才报。
 */
export function IsIanaTimezone(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isIanaTimezone",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: IsIanaTimezoneConstraint,
    });
  };
}
