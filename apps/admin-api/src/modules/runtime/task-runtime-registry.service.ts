/**
 * ARCH-25: 任务 runtime 注册表服务。
 *
 * 职责：持有 runtime → 能力描述的映射，内置三项（python/node/shell）在构造
 * 期注册，运行期可通过 register() 扩展（示例见 docs/development.md「ARCH-25
 * 任务 runtime 注册表」节的 deno 示例）。
 *
 * 设计纪律：
 * - 注册表是**描述层**：get() 对未知 runtime 返回 null（fail-open），任何
 *   消费方都不得因注册表缺项而拒绝既有任务——避免把描述层变成准入闸门。
 * - list() 返回副本：外部改动不污染注册表内部状态。
 * - 重复注册默认抛错；覆盖必须显式 override（防止插件静默改写内置语义）。
 */
import { Injectable } from "@nestjs/common";
import { TaskRuntime } from "../task/entities/task.entity";
import { BUILTIN_RUNTIME_DEFINITIONS } from "./builtin-runtimes";
import type {
  RegisterRuntimeOptions,
  TaskRuntimeDefinition,
} from "./task-runtime.types";

@Injectable()
export class TaskRuntimeRegistry {
  private readonly definitions = new Map<TaskRuntime, TaskRuntimeDefinition>();

  constructor() {
    for (const definition of BUILTIN_RUNTIME_DEFINITIONS) {
      this.definitions.set(definition.runtime, definition);
    }
  }

  /** 全部已注册 runtime 的快照（副本）。 */
  list(): TaskRuntimeDefinition[] {
    return Array.from(this.definitions.values()).map((definition) => ({
      ...definition,
    }));
  }

  /** 单个 runtime 的能力描述；未知返回 null（fail-open）。 */
  get(runtime: TaskRuntime | string): TaskRuntimeDefinition | null {
    const found = this.definitions.get(runtime as TaskRuntime);
    return found ? { ...found } : null;
  }

  has(runtime: TaskRuntime | string): boolean {
    return this.definitions.has(runtime as TaskRuntime);
  }

  /** 字符串是否为已知 runtime（与 TaskRuntime 枚举同源判定）。 */
  isSupported(value: string): value is TaskRuntime {
    return this.definitions.has(value as TaskRuntime);
  }

  /** 已注册的 runtime 值集合（与 TaskRuntime 枚举键对齐时可做一致性校验）。 */
  keys(): TaskRuntime[] {
    return Array.from(this.definitions.keys());
  }

  /**
   * 注册（或覆盖）一个 runtime。
   * @throws 同名已存在且未声明 override 时抛错（防止插件静默改写内置项）。
   */
  register(
    definition: TaskRuntimeDefinition,
    options: RegisterRuntimeOptions = {},
  ): void {
    if (this.definitions.has(definition.runtime) && !options.override) {
      throw new Error(
        `Task runtime "${definition.runtime}" is already registered; pass { override: true } to replace it`,
      );
    }
    this.definitions.set(definition.runtime, { ...definition });
  }
}
