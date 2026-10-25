import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

/**
 * F-5（依赖链契约收口）：dependencies 每个 **value** 的类型校验（DTO 层，
 * 给用户可读的 400）。
 *
 * ## 为什么需要
 *
 * FIX-1.1 定死的契约是 `Record<显示名快照, 上游任务id>`——value 是依赖任务
 * id，消费方（checkCircularDependency / checkDependencies /
 * triggerDependentTasks / 前端 dag-layout）全部读 value。`@IsObject()` 只拦
 * 「不是对象」，拦不住 `{"a": 123}` / `{"a": true}`：这类值会一路穿到
 * `assertDependencyValuesExist` 的 `In([123])` 查 uuid 列，PG 42883
 * （function uuid_eq_integer does not exist）→ 裸 500。
 *
 * DTO 边界把每个 value 收口为**非空字符串**（空串同样拒绝——空串不可能是
 * 合法任务 id），文案说明「依赖值必须是任务 id」。服务层
 * assertDependencyValuesExist 另有同判据的 typeof 前置守卫兜编程式调用方
 * （MCP/脚本/自动注册不经 ValidationPipe）。
 *
 * 空对象 `{}` 合法：语义与既有服务层一致（Object.keys 长度为 0 时不做任何
 * 依赖校验；PATCH 显式清空的既有通道是 null）。
 *
 * 实现模式对齐 secret-key-map.constraint.ts：约束器内累积逐键问题，
 * defaultMessage 聚合输出——一次请求能看到所有坏键，而不是改一个冒一个。
 */
@ValidatorConstraint({ name: "isDependencyValueMap", async: false })
export class IsDependencyValueMapConstraint implements ValidatorConstraintInterface {
  private problems: string[] = [];

  validate(value: unknown): boolean {
    this.problems = [];
    // null / undefined 合法：PATCH 的"清空"语义与"未提供"都由 @IsOptional 处理。
    if (value === null || value === undefined) return true;
    if (typeof value !== "object" || Array.isArray(value)) {
      this.problems.push("dependencies 必须是以键值对形式给出的对象");
      return false;
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v !== "string" || v.trim() === "") {
        const actual =
          v === null ? "null" : typeof v === "string" ? "空字符串" : typeof v;
        this.problems.push(
          `"${key}" 的依赖值必须是任务 id（非空字符串），实际为 ${actual}`,
        );
      }
    }
    return this.problems.length === 0;
  }

  defaultMessage(_args: ValidationArguments): string {
    return `依赖值必须是任务 id：${this.problems.join("；")}`;
  }
}
