import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

/**
 * TASK-PROJ-01 后续（生产故障）：`@IsUUID()` 拒绝默认项目自身。
 *
 * 背景：`DEFAULT_PROJECT_ID = '00000000-0000-0000-0000-000000000001'`
 * （project.entity.ts / 迁移 1790000000007）的 UUID 版本位是 `0`，而
 * `@IsUUID()` 底层的 validator.js 只接受版本 1–5（外加恰好全零的 nil UUID）。
 * 实测（class-validator 0.14 + validator 13）：
 *
 *   00000000-0000-0000-0000-000000000001  ->  REJECT（"must be a UUID"）
 *   aaaa0000-0000-4000-8000-000000000002  ->  PASS
 *
 * 后果是必现故障而非用户误操作：`GET /projects` **无条件**返回默认项目行
 * （projects.controller.ts findAll 的 `p.id === DEFAULT_PROJECT_ID`），
 * 于是「归属项目」下拉框里唯一可见、也是唯一合理的选项，恰好是唯一会被
 * 400 拒绝的值 —— 任何非 ADMIN 用户建任务只要选了项目就必然失败。
 *
 * 佐证这不是"这个 UUID 本身非法"：路由参数用的 `ParseUUIDPipe`（NestJS）
 * **接受**它，`GET /projects/:id` 一切正常。同一份 UUID 在 DTO 校验与路由
 * 校验下结论相反，正是本缺陷的形状。
 *
 * 为什么不改 DEFAULT_PROJECT_ID：它是三处硬编码引用的既有主键（实体常量、
 * 两条迁移的种子与回填 SQL），且**存量数据**已按该值落库。改它等于改主键，
 * 需要数据迁移且会波及所有 projectId 外键行 —— 收益仅是让校验器满意，不成
 * 比例。正确做法是让校验器表达真实意图：**这里要的是"一个 UUID 形状的
 * 标识符"，不是"一个 RFC 4122 版本 1–5 的 UUID"**。
 *
 * 因此本校验器做的是形状校验：8-4-4-4-12 的十六进制，**不限定版本位与
 * variant 位**。实测（validator 13.15.35）本仓库接受的差异面：
 *
 *   输入                                     @IsUUID()   本校验器
 *   00000000-0000-0000-0000-000000000001     ❌          ✅  ← 默认项目
 *   00000000-0000-0000-0000-000000000000     ✅          ✅  ← nil
 *   aaaa0000-0000-4000-8000-000000000002     ✅          ✅  ← v4
 *   aaaa0000-0000-4000-0000-000000000002     ❌          ✅  ← variant 位非 8/9/a/b
 *   aaaa0000-0000-7000-8000-000000000002     ❌          ✅  ← v7（validator 的 'all' 也不认）
 *   urn:uuid:<上述> / {<上述>}                ❌          ❌  ← 刻意不放松
 *   "" / "abc" / 注入串                       ❌          ❌  ← 刻意不放松
 *
 * 即：**只放宽 RFC 4122 的版本位与 variant 位**，不引入任何新的语法接受面。
 * （validator.js 并不接受 urn: 前缀与花括号包裹，故本校验器同样不接受——
 * 保持"能通过的集合"除版本/variant 位外与 @IsUUID() 逐字节一致。）
 *
 * 安全性：本校验器只放宽版本/variant 位，不放松"是不是 UUID 形状"。注入类
 * 载荷（引号、分号、路径分隔符、空白、超长串）全部仍然拒绝 —— 见
 * `is-uuid-shape.spec.ts` 的对抗用例。该值最终仍由
 * `TaskService.resolveProjectId` 走 TypeORM 参数化查询取行，不做字符串拼接。
 */
const UUID_SHAPE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 形状校验：任意版本的 UUID 标识符。见文件头注释。 */
export function isUuidShape(value: unknown): boolean {
  return typeof value === "string" && UUID_SHAPE.test(value);
}

@ValidatorConstraint({ name: "isUuidShape", async: false })
export class IsUuidShapeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isUuidShape(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a UUID`;
  }
}

/**
 * 同 `@IsUUID()`，但**不限定 RFC 4122 的版本位与 variant 位** —— 供
 * `projectId` 这类引用**既有主键**的字段使用（默认项目 id 的版本位是 0，
 * `@IsUUID()` 会拒绝它）。
 *
 * 与 `@IsOptional()` 组合时语义与 `@IsUUID()` 完全一致：`undefined`/`null`
 * 跳过校验，空字符串**仍被拒绝**（空串不是合法的"未分配"表示——未分配的
 * 表达是省略字段或显式 null）。
 */
export function IsUuidShape(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: "isUuidShape",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: IsUuidShapeConstraint,
    });
  };
}
