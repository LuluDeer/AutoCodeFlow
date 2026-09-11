import { Test } from "@nestjs/testing";
import { TaskRuntime } from "../../task/entities/task.entity";
import { TaskRuntimeRegistry } from "../task-runtime-registry.service";
import { BUILTIN_RUNTIME_DEFINITIONS } from "../builtin-runtimes";
import { RuntimeModule } from "../runtime.module";
import type { TaskRuntimeDefinition } from "../task-runtime.types";

/**
 * ARCH-25 示例 runtime（deno）：仅用于演示注册协议，未内置进生产注册表
 * ——见 docs/development.md「ARCH-25」节。放在 spec 里是为了让「示例 runtime
 * 的实现」本身被测试覆盖，避免文档示例与代码漂移。
 */
const DENO_RUNTIME: TaskRuntimeDefinition = {
  runtime: "deno" as TaskRuntime,
  label: "Deno",
  glueLanguage: "node",
  dependencyInstaller: "none",
  defaultEntrypointExtension: "ts",
  defaultRuntimeVersion: null,
  executorKind: "any",
  description: "示例 runtime：演示第三方 runtime 的注册协议。",
};

describe("ARCH-25 TaskRuntimeRegistry", () => {
  let registry: TaskRuntimeRegistry;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RuntimeModule],
    }).compile();
    registry = moduleRef.get(TaskRuntimeRegistry);
  });

  it("内置三项（python/node/shell）全部注册且元数据逐条可查", () => {
    expect(registry.keys().sort()).toEqual(["node", "python", "shell"]);
    const python = registry.get(TaskRuntime.PYTHON);
    expect(python).toMatchObject({
      label: "Python",
      glueLanguage: "python",
      dependencyInstaller: "pip",
      defaultEntrypointExtension: "py",
      executorKind: "executor-python",
    });
    const node = registry.get(TaskRuntime.NODE);
    expect(node?.dependencyInstaller).toBe("npm");
    expect(node?.executorKind).toBe("executor-node");
    const shell = registry.get(TaskRuntime.SHELL);
    expect(shell?.dependencyInstaller).toBe("none");
    expect(shell?.defaultEntrypointExtension).toBeNull();
  });

  it("内置项与 TaskRuntime 枚举一一对应（枚举新增值必须同步注册）", () => {
    const enumValues = Object.values(TaskRuntime).sort();
    const registered = registry.keys().map(String).sort();
    expect(registered).toEqual(enumValues);
    expect(BUILTIN_RUNTIME_DEFINITIONS).toHaveLength(enumValues.length);
  });

  it("未知 runtime fail-open：get 返回 null，has/isSupported 为 false", () => {
    expect(registry.get("cobol")).toBeNull();
    expect(registry.has("cobol")).toBe(false);
    expect(registry.isSupported("cobol")).toBe(false);
    // 已知值判定正常
    expect(registry.isSupported("python")).toBe(true);
  });

  it("注册示例 runtime（deno）后可见，且可被覆盖式更新", () => {
    registry.register(DENO_RUNTIME);
    expect(registry.get("deno")).toMatchObject({
      label: "Deno",
      defaultEntrypointExtension: "ts",
    });

    registry.register(
      { ...DENO_RUNTIME, label: "Deno (experimental)" },
      { override: true },
    );
    expect(registry.get("deno")?.label).toBe("Deno (experimental)");
  });

  it("重复注册未声明 override 时抛错（防插件静默改写内置语义）", () => {
    expect(() =>
      registry.register({
        ...BUILTIN_RUNTIME_DEFINITIONS[0],
        label: "被篡改的 Python",
      }),
    ).toThrow(/already registered/);
    expect(registry.get(TaskRuntime.PYTHON)?.label).toBe("Python");
  });

  it("list() 返回副本：外部改动不污染注册表", () => {
    const snapshot = registry.list();
    snapshot[0].label = "外部改动";
    expect(registry.get(snapshot[0].runtime)?.label).not.toBe("外部改动");
  });
});
