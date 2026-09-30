import {
  UPSTREAM_SENTINEL,
  buildUpstreamContext,
  injectUpstreamContext,
  type UpstreamExecutionContext,
} from "../task.service";

/**
 * FEAT-21: 依赖触发链上游结果透传——纯函数 spec（buildUpstreamContext /
 * injectUpstreamContext）。opt-in 契约：未声明哨兵的 params 必须返回**原
 * 引用**（triggerDependentTasks 据此走零变化的 this.trigger(id, {}) 路径）。
 */

const CTX: UpstreamExecutionContext = {
  executionId: "exec-up-1",
  status: "success",
  result: { screenshot: "/m/1.png", rows: 3 },
  errorMessage: null,
  failureReason: null,
  startTime: new Date(1_700_000_000_000),
  endTime: new Date(1_700_000_001_000),
  duration: 1000,
  executorAddress: "10.0.0.8:9000",
  exitCode: 0,
};

describe("buildUpstreamContext", () => {
  it("从执行行结构化子集构造上下文（缺省字段归 null）", () => {
    expect(
      buildUpstreamContext({
        id: "exec-up-1",
        status: "success",
        result: { screenshot: "/m/1.png", rows: 3 },
        startTime: new Date(1_700_000_000_000),
        endTime: new Date(1_700_000_001_000),
        duration: 1000,
        executorAddress: "10.0.0.8:9000",
        exitCode: 0,
        logs: "should not be pulled",
      } as never),
    ).toEqual(CTX);
  });
});

describe("injectUpstreamContext", () => {
  it("无 ctx / 无 params → 原样返回（不注入）", () => {
    const params = { a: 1 };
    expect(injectUpstreamContext(params, null)).toBe(params);
    expect(injectUpstreamContext(null, CTX)).toBeNull();
    expect(injectUpstreamContext(undefined, CTX)).toBeNull();
  });

  it("未声明哨兵 → 返回**原引用**（零变化契约）", () => {
    const params = { a: 1, nested: { b: "x" }, arr: [1, 2] };
    expect(injectUpstreamContext(params, CTX)).toBe(params);
  });

  it("整对象哨兵 $upstream → 注入完整上下文", () => {
    const injected = injectUpstreamContext(
      { upstream: UPSTREAM_SENTINEL },
      CTX,
    );
    expect(injected).not.toBe(CTX);
    expect(injected).toMatchObject({ upstream: CTX });
  });

  it("dot-path 哨兵：命中字段、嵌套取值、落空归 null", () => {
    const injected = injectUpstreamContext(
      {
        shot: "$upstream.result.screenshot",
        rows: "$upstream.result.rows",
        state: "$upstream.status",
        missing: "$upstream.result.nope",
      },
      CTX,
    );
    expect(injected).toEqual({
      shot: "/m/1.png",
      rows: 3,
      state: "success",
      missing: null,
    });
  });

  it("深嵌套 + 数组内的哨兵也被替换；非字符串叶子原样保留", () => {
    const injected = injectUpstreamContext(
      {
        deep: { list: ["$upstream.status", 42, null, true] },
        num: 7,
      },
      CTX,
    );
    expect(injected).toEqual({
      deep: { list: ["success", 42, null, true] },
      num: 7,
    });
  });

  it("哨兵大小写/前缀敏感：'$Upstream' 不是哨兵", () => {
    const params = { a: "$Upstream", b: "$upstreamish" };
    expect(injectUpstreamContext(params, CTX)).toBe(params);
  });
});
