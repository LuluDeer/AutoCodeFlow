import {
  UPSTREAM_SENTINEL,
  buildUpstreamContext,
  injectUpstreamContext,
  paramsDeclareUpstreamAlias,
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

  /**
   * G6 第二步：按**依赖别名**取上游输出——`$upstream("别名")[.path]`。
   * 别名 = dependencies 的键（显示名），无需迁移；未知别名解析为 null
   * （显式缺失，而不是把哨兵字符串当普通参数传给脚本）。
   */
  describe("injectUpstreamContext · 别名哨兵（G6）", () => {
    const other: UpstreamExecutionContext = {
      ...CTX,
      executionId: "exec-up-2",
      status: "failed",
      result: { cleanup: true },
    };

    it("别名取整块上下文 / 取 dot-path", () => {
      const injected = injectUpstreamContext(
        {
          fromA: '$upstream("fetch")',
          screenshot: '$upstream("fetch").result.screenshot',
          fromB: '$upstream("cleanup").result.cleanup',
        },
        CTX,
        { fetch: CTX, cleanup: other },
      ) as Record<string, unknown>;
      expect(injected.fromA).toEqual(CTX);
      expect(injected.screenshot).toBe("/m/1.png");
      expect(injected.fromB).toBe(true);
    });

    it("未知别名 → null（显式缺失，不保留哨兵字符串）", () => {
      const injected = injectUpstreamContext({ v: '$upstream("nope")' }, CTX, {
        fetch: CTX,
      }) as Record<string, unknown>;
      expect(injected.v).toBeNull();
    });

    it("别名与 legacy 混用：legacy 仍取「本次触发的那一个上游」", () => {
      const injected = injectUpstreamContext(
        { legacy: UPSTREAM_SENTINEL, aliased: '$upstream("cleanup")' },
        CTX,
        { cleanup: other },
      ) as Record<string, unknown>;
      expect(injected.legacy).toEqual(CTX);
      expect(injected.aliased).toEqual(other);
    });

    it("paramsDeclareUpstreamAlias 只认别名形态（legacy 不算）", () => {
      expect(paramsDeclareUpstreamAlias({ a: '$upstream("x")' })).toBe(true);
      expect(
        paramsDeclareUpstreamAlias({ a: '$upstream("x").result.foo' }),
      ).toBe(true);
      expect(paramsDeclareUpstreamAlias({ a: UPSTREAM_SENTINEL })).toBe(false);
      expect(paramsDeclareUpstreamAlias({ a: "plain" })).toBe(false);
      expect(paramsDeclareUpstreamAlias(null)).toBe(false);
    });
  });
});
