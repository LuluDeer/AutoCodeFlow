/**
 * ARCH-25: 任务 runtime 注册表协议。
 *
 * 背景：runtime 当前是硬编码枚举 TaskRuntime（python/node/shell）+ 消费点
 * 分散（实体列、DTO @IsEnum、dispatch 载荷、admin-web 表单选项、双执行器
 * 分支）。本模块把「runtime 的元数据与能力描述」抽成单一事实源，供后续
 * 表单选项、文档、校验与插件化扩展消费。
 *
 * 兼容纪律（本阶段红线）：
 * - **不改 TaskRuntime 枚举、不改 DTO 校验、不改 dispatch 语义**——注册表是
 *   只读真值面 + 扩展点，既有行为逐字节不变，因此零迁移、零 openapi 变更。
 * - 未知 runtime 一律 fail-open（get 返回 null），绝不因为注册表缺项就让
 *   任务创建/派发失败——注册表是描述层，不是新的准入闸门。
 */
import { TaskRuntime } from "../task/entities/task.entity";

/** glue 脚本执行语言（executor 侧 glue 分支的真实取值）。 */
export type GlueLanguage = "python" | "node" | "shell";

/** 任务依赖安装器：python→uv pip（per-task venv）、node→npm、shell→无。 */
export type DependencyInstaller = "pip" | "npm" | "none";

/** 承载该 runtime 的执行器类型（文档/排错提示，不做路由判定）。 */
export type RuntimeExecutorKind =
  | "executor-python"
  | "executor-node"
  | "any";

/** 一个 runtime 的完整能力描述。 */
export interface TaskRuntimeDefinition {
  /** TaskRuntime 枚举值——注册表与实体枚举的唯一契约面。 */
  runtime: TaskRuntime;
  /** 中文展示名（表单/文档用）。 */
  label: string;
  /** glue 脚本语言标识。 */
  glueLanguage: GlueLanguage;
  /** 依赖安装器类型（W-21 requirements 通道的实际执行者）。 */
  dependencyInstaller: DependencyInstaller;
  /** entrypoint 文件默认扩展名提示；shell 无固定扩展 → null。 */
  defaultEntrypointExtension: string | null;
  /** 默认 runtimeVersion 提示；不约束 → null。 */
  defaultRuntimeVersion: string | null;
  /** 承载执行器类型。 */
  executorKind: RuntimeExecutorKind;
  /** 面向使用者的说明（能力边界与已知限制）。 */
  description: string;
}

/** 注册选项：内置项默认不允许覆盖，自定义注册须显式声明。 */
export interface RegisterRuntimeOptions {
  /** 允许覆盖已存在的同名 runtime（内置项覆盖需谨慎，仅测试/灰度用）。 */
  override?: boolean;
}
