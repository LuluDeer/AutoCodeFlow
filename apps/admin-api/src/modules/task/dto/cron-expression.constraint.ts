import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import * as nodeCron from "node-cron";

/**
 * 5 字段 cron 表达式的合法性校验（DTO 层，给用户可读的 400）。
 *
 * ## 为什么不再用手写正则
 *
 * 这里此前是一条手写的 `@Matches(...)` 正则，且**写坏了**：它每个字段只接受
 * `*`、单值、`值/步进` 三种形态，没有逗号列表与范围分支。于是下面这些**完全
 * 合法**的表达式在保存时被 400 拦死：
 *
 *   - `0 12,18 * * *`   每天 12 点与 18 点（最常用写法之一）
 *   - `0 9-17 * * *`    工作日时段范围
 *   - `0 12,18 * * 1-5` 组合
 *
 * 而同仓库的其余三方都接受它们：前端预览器 `trigger-preview.ts` 的
 * `parseCronExpression`、真正的调度注册路径 `scheduler.service.ts` 的
 * `nodeCron.validate`、以及维护窗口 `maintenance-window.util.ts`。用户因此
 * 看到一个很费解的现象——**能预览出正确的下次触发时间，却存不进去**。
 *
 * 根因不是"正则写漏了一个分支"，而是**同一个语义被实现了四份**（前端预览器、
 * 维护窗口、node-cron、DTO 各一份）后必然的漂移。所以这里不再补正则，而是把
 * 判定收敛到调度器注册时用的**同一个校验器** `nodeCron.validate`——校验通过
 * 即意味着"调度器确实能注册它"，两边不可能再分叉。
 * （维护窗口的 `parseWindowCron` 早已是这个做法，本次是向它对齐。）
 *
 * ## 为什么额外钉死 5 段
 *
 * `nodeCron.validate` 还接受 **6 段**（带秒，如 `0 12 * * * *`）。本仓对外的
 * cron 契约是 5 段——错误文案、前端预览器、维护窗口都按 5 段实现。若这里放行
 * 6 段，前端预览器会解析失败并显示"无法预览"，等于把同一个"预览与保存不一致"
 * 换个方向再犯一次。故显式要求恰好 5 个字段。
 *
 * 注意：5 段但**语义**非法（越界、倒序范围）的表达式由 `nodeCron.validate`
 * 拒绝；`parseField` 那层更细的展开校验只用于"求下次触发时间"，不参与合法性
 * 判定，避免引入第二套口径。
 *
 * ## 为什么额外钉死 5 段 + 纯数字
 *
 * `nodeCron.validate` 比本仓契约**更宽**，宽在两处，都必须显式收紧：
 *
 * 1. **6 段（带秒）**：`0 12 * * * *` 它接受。而本仓对外的 cron 契约是 5 段
 *    ——错误文案、前端预览器、维护窗口都按 5 段实现。放行 6 段会让前端预览
 *    解析失败显示"无法预览"，等于把"预览与保存不一致"换个方向再犯一次。
 * 2. **星期名 / 月名**：`0 12 * * sun`、`0 12 * jan *` 它接受（大小写不敏感），
 *    但前端预览器的 `parseCronExpression` 与维护窗口的 `parseField` **都只认
 *    数字**。放行字母会造成"存得进去、但预览是空白、维护窗口又拒绝填同一个
 *    表达式"的反向不一致——正是本 bug 的镜像。
 *
 * 收敛方向是**收紧到纯数字 5 段**，而不是放宽前端：三个消费者（前端预览器、
 * 维护窗口、两处的 parseField）本来就一致地只认数字，`nodeCron.validate`
 * 才是那个更宽的特例；向宽的对齐等于把特例扩散成契约。
 */

/** 恰好 5 个空白分隔字段（本仓 cron 契约；6 段带秒的形式不在契约内）。 */
const CRON_FIELD_COUNT = 5;

/**
 * 单字段字符集：只允许纯数字形态。`*`、`n`、`a-b`、`*\/n`、`a-b/n`、`n/max`
 * 的逗号组合（与前端 `parseCronExpression` / 维护窗口 `parseField` 同款字符集；
 * 越界判定不在这里做，交给 nodeCron.validate）。
 */
const NUMERIC_FIELD_RE = /^[\d*,\-/]+$/;

/** 判定该表达式是否可被调度器接受、且落在本仓 5 段纯数字契约内。 */
export function isValidCronExpression(expr: unknown): boolean {
  if (typeof expr !== "string") return false;
  const trimmed = expr.trim();
  if (!trimmed) return false;
  const fields = trimmed.split(/\s+/);
  // 先钉字段数：node-cron 对 6 段也返回 true，但那超出本仓契约。
  if (fields.length !== CRON_FIELD_COUNT) return false;
  // 再钉字符集：node-cron 接受 sun/jan 这类名字，前端预览器与维护窗口不接受。
  if (!fields.every((f) => NUMERIC_FIELD_RE.test(f))) return false;
  return nodeCron.validate(trimmed);
}

@ValidatorConstraint({ name: "isCron5Field", async: false })
export class IsCron5FieldConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    // null / undefined 合法：由 @IsOptional 决定"未提供"是否被接受。
    // PATCH 语义下显式 null 也可能表示清空，不在本校验器职责内。
    if (value === null || value === undefined) return true;
    return isValidCronExpression(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a valid cron expression (5 fields: min hour day month weekday)`;
  }
}

/**
 * 校验 5 字段 cron 表达式。放在 `@IsString()` 之后：类型不对时先报类型错误，
 * 表达式问题只在确实是字符串时才报。
 */
export function IsCron5Field(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isCron5Field",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: IsCron5FieldConstraint,
    });
  };
}
