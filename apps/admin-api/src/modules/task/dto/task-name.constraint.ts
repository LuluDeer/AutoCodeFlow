import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

/**
 * 任务名（Task.name）的写面校验：**允许任意语言**，只拒绝真正有害的形态。
 *
 * ## 为什么不再限制 `[a-zA-Z0-9_-]`
 *
 * 任务名此前在**前端**被一条 `/^[a-zA-Z0-9_-]+$/` 拦成纯 ASCII（见
 * admin-web 的 TaskFormBasicSection），后端 `@IsString() @IsNotEmpty()`
 * 其实**从未**要求过 ASCII。于是中文用户被迫给任务起英文名，而中台本身
 * 对非 ASCII 毫无障碍：DB 列是普通 varchar、执行器只把它当展示串
 * （`env['TASK_NAME']`、日志文案），唯一真正的语义位是 `id`。
 *
 * 把限制放开到"任意语言"，代价是必须自己补上原来由白名单**顺带**提供的
 * 两道保护（见下），否则是把一个体验问题换成一个数据问题。
 *
 * ## 保留的两条红线
 *
 * 1. **控制字符**：`\n` / `\r` / `\t` / `\0` / DEL 等。它们不是"某种语言的
 *    合法字符"，而是会在多个下游被**结构性地**消费掉：任务名会进日志行
 *    （换行 = 伪造一条日志记录）、进通知标题、进导出文件名。名字里带换行的
 *    任务在值班视图上看起来像两条不同的记录，排查时无人能对上。
 *    刻意**不**限制中文、日文、emoji、空格、括号等可见字符。
 *
 * 2. **首尾空白**：`" 备份 "` 与 `"备份"` 在库里是两行、在界面上看起来一样，
 *    而 name 上有全局唯一索引（idx_tasks_name_unique）——用户会得到
 *    "明明没有重名却报已存在"的费解 409。校验层拒绝首尾空白，而不是静默
 *    trim：静默 trim 会让"我输入的名字"与"实际存储的名字"不一致，改名后
 *    再搜原名搜不到。
 *
 * 长度上限 255 与 DB 列（varchar 默认长度）对齐——超长在 PG 侧是
 * `value too long for type character varying(255)`（22001，500），
 * 必须在 DTO 边界变成可读的 400。
 */

/** 与 DB varchar 列宽对齐；PG 超长报 22001 而非 23505，必须在写面拦住。 */
export const TASK_NAME_MAX_LENGTH = 255;

/**
 * 名称长度按**码点**计，与 PG 的 `varchar(255)` 口径一致（实测：255 个 emoji
 * 接受、256 个拒绝；128 个 emoji 是 256 个 UTF-16 码元却只有 128 码点，同样
 * 接受）。`String.prototype.length` 数的是 UTF-16 码元，对 emoji 等增补平面
 * 字符会**多算一倍**——用它做上限会让「128 个 emoji」这种 DB 完全接受的名字
 * 被 400 拒掉，且报错文案里的数字（256）与用户看到的字符数（128）对不上。
 */
export function taskNameLength(value: string): number {
  return Array.from(value).length;
}

/**
 * 控制字符：C0（0x00-0x1F，含 \n \r \t \0）与 DEL（0x7F）。
 * 用 Unicode 属性转义表达，比列举转义序列更难写漏。
 */
const CONTROL_CHARS_RE = /[\p{Cc}\p{Cf}]/u;

/**
 * 返回该任务名不可用的原因；`null` = 可用。
 * 与 `IsTaskNameConstraint` 共用同一判据（单一事实源，避免两层漂移）。
 */
export function describeTaskNameProblem(value: unknown): string | null {
  if (typeof value !== "string") return "任务名称必须是字符串";
  if (value.length === 0) return "任务名称不能为空";
  if (value.trim().length === 0) return "任务名称不能只由空白字符组成";
  if (value !== value.trim()) {
    return "任务名称不能以空白字符开头或结尾";
  }
  if (CONTROL_CHARS_RE.test(value)) {
    return "任务名称不能包含换行、制表符等控制字符";
  }
  const length = taskNameLength(value);
  if (length > TASK_NAME_MAX_LENGTH) {
    return `任务名称不能超过 ${TASK_NAME_MAX_LENGTH} 个字符（当前 ${length}）`;
  }
  return null;
}

@ValidatorConstraint({ name: "isTaskName", async: false })
export class IsTaskNameConstraint implements ValidatorConstraintInterface {
  private problem: string | null = null;

  validate(value: unknown): boolean {
    // null / undefined 交给 @IsNotEmpty / @IsOptional 决定（PATCH 语义下
    // 缺省 = 保留旧值，不该在这里报"名称非法"）。
    if (value === null || value === undefined) return true;
    this.problem = describeTaskNameProblem(value);
    return this.problem === null;
  }

  defaultMessage(_args: ValidationArguments): string {
    return this.problem ?? "任务名称不合法";
  }
}

/**
 * 校验任务名（任意语言，禁控制字符与首尾空白，≤255）。
 * 放在 `@IsString()` 之后：类型不对时先报类型错误。
 */
export function IsTaskName(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isTaskName",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: IsTaskNameConstraint,
    });
  };
}
