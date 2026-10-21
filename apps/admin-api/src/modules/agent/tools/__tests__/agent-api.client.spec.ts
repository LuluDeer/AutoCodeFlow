import { AgentApiClient } from "../agent-api.client";
import type { AgentToolSpec } from "../tool-registry";

/**
 * 只用到 name——description/parameters/tier 与 invoke 的分发无关。
 * 用真实类型（而非 as never）是为了将来 schema 改名时这里跟着编译红。
 */
const spec = (name: string): AgentToolSpec => ({ name } as AgentToolSpec);

/**
 * AgentApiClient 是「工具名 → 执行体」的路由表，也是推理循环里**唯一**
 * 把「工具不存在 / 工具跑挂了」翻译成模型可读结果的收口点。
 *
 * 这层的正确性不体现在「能调到 handler」（那是 tool-binder 的事），而体现在
 * **失败姿态**：设计文档 10 §调整1 明确要求未实现的工具「如实返回错误，
 * 而不是静默成功」，且**不抛异常**——抛异常会让推理循环的 catch 分支把它
 * 判成链路故障，把可绕过的「工具没实现」升级为不可恢复的 failed 会话。
 */
describe("AgentApiClient · 未实现工具必须如实失败且不抛异常", () => {
  it("未登记工具 → isError=true / data=null / 文案含工具名与「尚未实现」，且是 resolve", async () => {
    const client = new AgentApiClient();

    // 关键反证点：这里若改成 throw，本用例会以 rejected 失败。
    const res = await client.invoke(spec("nope_tool"), { a: 1 });

    expect(res.isError).toBe(true);
    expect(res.data).toBeNull();
    expect(res.errorMessage).toContain("nope_tool");
    expect(res.errorMessage).toContain("尚未实现");
  });

  it("未登记工具不得调用任何执行体，也不得伪造成功", async () => {
    const client = new AgentApiClient();
    const handler = jest.fn(async () => ({ leaked: true }));
    client.register("other_tool", handler);

    const res = await client.invoke(spec("nope_tool"), {});

    expect(handler).not.toHaveBeenCalled();
    expect(res.data).toBeNull();
  });
});

describe("AgentApiClient · 成功路径原样透传", () => {
  it("handler 的返回值原样作为 data（不包装、不序列化），isError=false", async () => {
    const client = new AgentApiClient();
    const payload = { items: [{ id: "t-1" }], total: 1 };
    client.register("list_tasks", async () => payload);

    const res = await client.invoke(spec("list_tasks"), { page: 1 });

    expect(res).toEqual({ data: payload, isError: false });
    // 同一引用：不许在收口点做 deep clone（大列表会被反复复制）
    expect(res.data).toBe(payload);
  });

  it("args=null → 执行体收到 {}（下游按对象访问参数不会 TypeError）", async () => {
    const client = new AgentApiClient();
    const handler = jest.fn(async (args: Record<string, unknown>) => args);
    client.register("get_task", handler);

    const res = await client.invoke(spec("get_task"), null);

    expect(handler).toHaveBeenCalledWith({});
    expect(res).toEqual({ data: {}, isError: false });
  });
});

describe("AgentApiClient · 失败归因（异常转数据）", () => {
  it("执行体抛 Error → isError=true 且 errorMessage 取 err.message，不 reject", async () => {
    const client = new AgentApiClient();
    client.register("get_task", async () => {
      throw new Error("task not found: t-404");
    });

    // 同样必须 resolve：链路故障由会话层判，不在这里冒泡。
    const res = await client.invoke(spec("get_task"), { taskId: "t-404" });

    expect(res.isError).toBe(true);
    expect(res.data).toBeNull();
    expect(res.errorMessage).toBe("task not found: t-404");
  });

  it("执行体抛非 Error（字符串 / undefined）→ String(err) 归因，自身不崩", async () => {
    const client = new AgentApiClient();
    client.register("throw_string", async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "boom-string";
    });
    client.register("throw_undefined", async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw undefined;
    });

    const asString = await client.invoke(spec("throw_string"), {});
    expect(asString.isError).toBe(true);
    expect(asString.errorMessage).toBe("boom-string");

    const asUndefined = await client.invoke(spec("throw_undefined"), {});
    expect(asUndefined.isError).toBe(true);
    // 契约：非 Error 一律 String()——包括 undefined（不因访问 .message 抛二次异常）
    expect(asUndefined.errorMessage).toBe("undefined");
  });
});

describe("AgentApiClient · 注册表语义", () => {
  it("同名重复注册 → 覆盖而非叠加（implementedTools 不出现重复项）", async () => {
    const client = new AgentApiClient();
    const first = jest.fn(async () => "v1");
    const second = jest.fn(async () => "v2");

    client.register("get_task", first);
    client.register("get_task", second);

    expect(client.implementedTools()).toEqual(["get_task"]);
    const res = await client.invoke(spec("get_task"), {});
    expect(res.data).toBe("v2");
    expect(first).not.toHaveBeenCalled();
  });

  it("implementedTools 已排序（能力自述与自检按稳定顺序比对）", () => {
    const client = new AgentApiClient();
    client.register("sop_get", async () => null);
    client.register("list_tasks", async () => null);
    client.register("get_task", async () => null);

    expect(client.implementedTools()).toEqual([
      "get_task",
      "list_tasks",
      "sop_get",
    ]);
  });

  it("两个实例的注册表互不可见（register 是实例态，非全局单例表）", async () => {
    const a = new AgentApiClient();
    const b = new AgentApiClient();
    a.register("only_in_a", async () => "a");

    expect(a.implementedTools()).toEqual(["only_in_a"]);
    expect(b.implementedTools()).toEqual([]);
    await expect(b.invoke(spec("only_in_a"), {})).resolves.toMatchObject({
      isError: true,
    });
  });
});

describe("AgentApiClient · 并发调用互不串线", () => {
  it("并发 invoke 不同工具 → 各拿各的结果（执行体是 async，禁止共享可变中转）", async () => {
    const client = new AgentApiClient();
    client.register("slow", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "slow-result";
    });
    client.register("fast", async () => "fast-result");
    client.register("failing", async () => {
      throw new Error("nope");
    });

    const [slow, fast, failing] = await Promise.all([
      client.invoke(spec("slow"), {}),
      client.invoke(spec("fast"), {}),
      client.invoke(spec("failing"), {}),
    ]);

    expect(slow).toEqual({ data: "slow-result", isError: false });
    expect(fast).toEqual({ data: "fast-result", isError: false });
    expect(failing).toEqual({
      data: null,
      isError: true,
      errorMessage: "nope",
    });
  });
});
