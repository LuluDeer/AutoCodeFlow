/**
 * ARCH-25: 内置 runtime 定义（python / node / shell）。
 *
 * 每一项都对应执行器侧真实存在的分支，字段逐条核源，不臆造能力：
 * - python：executor-python，glue 走 python 解释器，依赖经 `uv pip install`
 *   装入 per-task venv（W-21），entrypoint 典型 .py。
 * - node：executor-node，glue 走 node，依赖经 npm 安装，entrypoint 典型 .js。
 * - shell：两侧执行器皆可（系统 shell），无依赖安装器、无固定扩展名。
 */
import { TaskRuntime } from "../task/entities/task.entity";
import type { TaskRuntimeDefinition } from "./task-runtime.types";

export const BUILTIN_RUNTIME_DEFINITIONS: readonly TaskRuntimeDefinition[] = [
  {
    runtime: TaskRuntime.PYTHON,
    label: "Python",
    glueLanguage: "python",
    dependencyInstaller: "pip",
    defaultEntrypointExtension: "py",
    defaultRuntimeVersion: null,
    executorKind: "executor-python",
    description:
      "executor-python 承载：glue 脚本与 entrypoint 均由 Python 解释器执行，任务依赖（requirements）经 uv pip 装入 per-task venv。",
  },
  {
    runtime: TaskRuntime.NODE,
    label: "Node.js",
    glueLanguage: "node",
    dependencyInstaller: "npm",
    defaultEntrypointExtension: "js",
    defaultRuntimeVersion: null,
    executorKind: "executor-node",
    description:
      "executor-node 承载：glue 脚本与 entrypoint 由 Node 执行，任务依赖（requirements）经 npm 安装；bundle 与源码同 commit 重打纪律见 W-18。",
  },
  {
    runtime: TaskRuntime.SHELL,
    label: "Shell",
    glueLanguage: "shell",
    dependencyInstaller: "none",
    defaultEntrypointExtension: null,
    defaultRuntimeVersion: null,
    executorKind: "any",
    description:
      "系统 shell 执行（Windows 侧 .cmd 化，见 W-11/P-11）：无依赖安装器、无 per-task 环境，跨平台语义差异最大，慎用于强移植场景。",
  },
];
