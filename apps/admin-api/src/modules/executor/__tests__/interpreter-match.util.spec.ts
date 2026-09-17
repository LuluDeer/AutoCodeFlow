import {
  LEGACY_DEFAULT_INTERPRETERS,
  INTERPRETER_UNAVAILABLE_TOKEN,
  buildInterpreterMismatchMessage,
  describeExecutorInterpreters,
  hasRequestedVersion,
  interpreterSatisfies,
  matchesVersionPrefix,
  normalizeInterpreters,
} from "../interpreter-match.util";
import type { ExecutorInterpreter } from "../interpreter-match.util";

/**
 * python_task_multiversion（WS2 · CONTRACT §1.2 / §2.2 / §2.5 / §3.1）：
 * `interpreter-match.util` 的判据矩阵。
 *
 * 本文件是**语义冻结面**的回归护栏——下列三组边界任一处被"顺手简化"都会造成
 * 静默错派（选到跑不了该版本的执行器），且不会红在任何既有测试上：
 * ① 点安全前缀匹配（`3.1` vs `3.13.0`）；
 * ② `null`（未上报 → 兜底 3.12）与 `[]`（已上报且池空 → 不兜底）的相反语义；
 * ③ 结构非法 → 整字段拒绝采纳（返回 null）。
 */

const inf = (
  version: string,
  extra: Partial<ExecutorInterpreter> = {},
): ExecutorInterpreter => ({ version, ...extra });

describe("matchesVersionPrefix（CONTRACT §1.2 点安全前缀匹配）", () => {
  it("前缀命中：requested + '.' 是 available 的前缀", () => {
    expect(matchesVersionPrefix("3.7.9", "3.7")).toBe(true);
    expect(matchesVersionPrefix("3.12.3", "3.12")).toBe(true);
    expect(matchesVersionPrefix("3.13.0", "3.13")).toBe(true);
  });

  it("精确相等命中（缓存池里只有主.次形态时）", () => {
    expect(matchesVersionPrefix("3.7", "3.7")).toBe(true);
    expect(matchesVersionPrefix("3.12", "3.12")).toBe(true);
  });

  it("跨版本号前缀必须带点：3.1 不得匹配 3.13.0（契约强制边界）", () => {
    expect(matchesVersionPrefix("3.13.0", "3.1")).toBe(false);
    expect(matchesVersionPrefix("3.13", "3.1")).toBe(false);
    // 反证有牙：同一组输入若退化为 startsWith(裸前缀) 就会返回 true。
    expect("3.13.0".startsWith("3.1")).toBe(true);
  });

  it("不同版本号不命中", () => {
    expect(matchesVersionPrefix("3.12.3", "3.7")).toBe(false);
    expect(matchesVersionPrefix("3.7.9", "3.12")).toBe(false);
    expect(matchesVersionPrefix("3.11.9", "3.1")).toBe(false);
  });

  it("空 requested → false（空声明的放行语义由 interpreterSatisfies 承担）", () => {
    expect(matchesVersionPrefix("3.12.3", "")).toBe(false);
  });

  it("非字符串入参 → false（上报面不可信，不抛错）", () => {
    expect(matchesVersionPrefix(null as unknown as string, "3.7")).toBe(false);
    expect(matchesVersionPrefix("3.7.9", null as unknown as string)).toBe(
      false,
    );
  });
});

describe("interpreterSatisfies（CONTRACT §1.2 / §2.2 / §3.1）", () => {
  it("requested 为空（null/undefined/''/'   '）→ 恒 true（存量任务不拦截）", () => {
    for (const requested of [null, undefined, "", "   "]) {
      expect(interpreterSatisfies([inf("3.7.9")], requested)).toBe(true);
      // 即便缓存池为空也必须放行——未声明版本与缓存池无关。
      expect(interpreterSatisfies([], requested)).toBe(true);
      expect(interpreterSatisfies(null, requested)).toBe(true);
    }
  });

  it("requested 有值且命中前缀 → true", () => {
    expect(interpreterSatisfies([inf("3.7.9")], "3.7")).toBe(true);
    expect(interpreterSatisfies([inf("3.7.9"), inf("3.12.3")], "3.12")).toBe(
      true,
    );
    expect(interpreterSatisfies([inf("3.7")], "3.7")).toBe(true);
  });

  it("requested 有值但无命中 → false", () => {
    expect(interpreterSatisfies([inf("3.12.3")], "3.7")).toBe(false);
    expect(interpreterSatisfies([inf("3.12.3"), inf("3.11.9")], "3.9")).toBe(
      false,
    );
  });

  it("点安全：只有 3.13.0 时，声明 3.1 不满足", () => {
    expect(interpreterSatisfies([inf("3.13.0")], "3.1")).toBe(false);
  });

  it('null/undefined（未上报 = 旧执行器）→ 兜底 ["3.12"]', () => {
    expect(LEGACY_DEFAULT_INTERPRETERS).toEqual(["3.12"]);
    expect(interpreterSatisfies(null, "3.12")).toBe(true);
    expect(interpreterSatisfies(undefined, "3.12")).toBe(true);
    // 兜底只覆盖 3.12：其余声明版本在未上报执行器上不满足。
    expect(interpreterSatisfies(null, "3.7")).toBe(false);
    expect(interpreterSatisfies(undefined, "3.9")).toBe(false);
  });

  it("[]（已上报且缓存池为空）→ 任何声明版本都不满足，**不回退兜底**", () => {
    // 这是与 null 相反的一态：若实现里把 [] 也当"未上报"，本断言立刻红。
    expect(interpreterSatisfies([], "3.12")).toBe(false);
    expect(interpreterSatisfies([], "3.7")).toBe(false);
    expect(interpreterSatisfies([], "3.9")).toBe(false);
  });

  it("available === false 的项永不满足（探测不可用的解释器不能接单）", () => {
    expect(
      interpreterSatisfies([inf("3.7.9", { available: false })], "3.7"),
    ).toBe(false);
    // 同版本另有一条可用项时满足。
    expect(
      interpreterSatisfies(
        [inf("3.7.9", { available: false }), inf("3.7.9", { available: true })],
        "3.7",
      ),
    ).toBe(true);
    // available 缺省视为可用（契约：可选字段）。
    expect(interpreterSatisfies([inf("3.7.9")], "3.7")).toBe(true);
  });

  it("脏项被跳过而非整池放行/抛错", () => {
    const dirty = [
      null as unknown as ExecutorInterpreter,
      { version: 123 } as unknown as ExecutorInterpreter,
      inf("3.7.9"),
    ];
    expect(interpreterSatisfies(dirty, "3.7")).toBe(true);
    expect(interpreterSatisfies(dirty, "3.9")).toBe(false);
  });

  it("非数组脏数据按未上报兜底（不静默剔除整台执行器）", () => {
    expect(
      interpreterSatisfies("3.7.9" as unknown as ExecutorInterpreter[], "3.12"),
    ).toBe(true);
    expect(
      interpreterSatisfies("3.7.9" as unknown as ExecutorInterpreter[], "3.7"),
    ).toBe(false);
  });

  it("NFR-08：纯内存过滤，大清单下判定正确且不依赖 IO", () => {
    const pool = Array.from({ length: 500 }, (_, i) => inf(`3.${i}.0`));
    expect(interpreterSatisfies(pool, "3.12")).toBe(true);
    // 4.0 不在池内（池里最大是 3.499.0）——主版本不同必然不命中。
    expect(interpreterSatisfies(pool, "4.0")).toBe(false);
  });
});

describe("hasRequestedVersion", () => {
  it("null/undefined/空串/全空白 → 未声明", () => {
    expect(hasRequestedVersion(null)).toBe(false);
    expect(hasRequestedVersion(undefined)).toBe(false);
    expect(hasRequestedVersion("")).toBe(false);
    expect(hasRequestedVersion("  ")).toBe(false);
  });

  it("非空字符串 → 已声明", () => {
    expect(hasRequestedVersion("3.7")).toBe(true);
  });
});

describe("normalizeInterpreters（CONTRACT §2.2 上报结构校验）", () => {
  it("合法数组：保留白名单字段，剥除未知键", () => {
    expect(
      normalizeInterpreters([
        {
          version: "3.7.9",
          path: "/data/interpreters/x/bin/python3",
          available: true,
          discoveredAt: "2026-09-16T10:00:00.000Z",
          // 未知键（含潜在攻击面）必须被剥除。
          __proto__hack: "x",
          evil: { nested: true },
        },
      ]),
    ).toEqual([
      {
        version: "3.7.9",
        path: "/data/interpreters/x/bin/python3",
        available: true,
        discoveredAt: "2026-09-16T10:00:00.000Z",
      },
    ]);
  });

  it("[] 是**合法**上报（语义为池空），返回 [] 而非 null", () => {
    expect(normalizeInterpreters([])).toEqual([]);
  });

  it("可选字段类型不符 → 丢弃该字段而非整体拒绝", () => {
    expect(
      normalizeInterpreters([
        { version: "3.7.9", path: 42, available: "yes", discoveredAt: null },
      ]),
    ).toEqual([{ version: "3.7.9" }]);
  });

  it("非数组 → null（整字段拒绝采纳）", () => {
    expect(normalizeInterpreters(null)).toBeNull();
    expect(normalizeInterpreters(undefined)).toBeNull();
    expect(normalizeInterpreters("3.7.9")).toBeNull();
    expect(normalizeInterpreters({ version: "3.7.9" })).toBeNull();
    expect(normalizeInterpreters(42)).toBeNull();
  });

  it("项缺 version / version 非字符串 → null", () => {
    expect(normalizeInterpreters([{ path: "/x" }])).toBeNull();
    expect(normalizeInterpreters([{ version: 3.7 }])).toBeNull();
    expect(normalizeInterpreters([null])).toBeNull();
    expect(normalizeInterpreters([["3.7.9"]])).toBeNull();
  });

  it("version 非 X.Y / X.Y.Z → null（整字段拒绝）", () => {
    for (const bad of [
      "3",
      "3.7.9.1",
      "v3.7",
      "3.x",
      "python3.7",
      "",
      "  ",
      "3.7-beta",
    ]) {
      expect(normalizeInterpreters([{ version: bad }])).toBeNull();
    }
  });

  it("X.Y 与 X.Y.Z 两种形态都合法（探测回退形态）", () => {
    expect(normalizeInterpreters([{ version: "3.12" }])).toEqual([
      { version: "3.12" },
    ]);
    expect(normalizeInterpreters([{ version: "3.12.3" }])).toEqual([
      { version: "3.12.3" },
    ]);
  });

  it("version 首尾空白被归一（不因空白拒绝，也不留脏值）", () => {
    expect(normalizeInterpreters([{ version: " 3.7.9 " }])).toEqual([
      { version: "3.7.9" },
    ]);
  });

  it("条数上界 200（防上报面写放大）", () => {
    const huge = Array.from({ length: 500 }, (_, i) => ({
      version: `3.${i}.0`,
    }));
    expect(normalizeInterpreters(huge)?.length).toBe(200);
  });

  it("归一结果可直接喂给 interpreterSatisfies（两函数语义对齐）", () => {
    const normalized = normalizeInterpreters([
      { version: "3.7.9", available: true },
    ])!;
    expect(interpreterSatisfies(normalized, "3.7")).toBe(true);
  });
});

describe("describeExecutorInterpreters / buildInterpreterMismatchMessage（AC-09b / AC-12a）", () => {
  it("未上报 → 显式标出兜底语义（避免误读成'池空'）", () => {
    expect(describeExecutorInterpreters({ appName: "exec-a" })).toBe(
      "exec-a[未上报，按 3.12 兜底]",
    );
    expect(
      describeExecutorInterpreters({ appName: "exec-a", interpreters: null }),
    ).toBe("exec-a[未上报，按 3.12 兜底]");
  });

  it("已上报且池空 → 已缓存: 无", () => {
    expect(
      describeExecutorInterpreters({ appName: "exec-b", interpreters: [] }),
    ).toBe("exec-b[已缓存: 无]");
  });

  it("逐项列出缓存版本，available=false 标注 (不可用)", () => {
    expect(
      describeExecutorInterpreters({
        appName: "exec-c",
        interpreters: [
          inf("3.12.3"),
          inf("3.8.3", { available: false }),
          inf("3.13.0"),
        ],
      }),
    ).toBe("exec-c[已缓存: 3.12.3；3.8.3(不可用)；3.13.0]");
  });

  it("appName 缺失 → unknown（不产出空串片段）", () => {
    expect(describeExecutorInterpreters({})).toBe(
      "unknown[未上报，按 3.12 兜底]",
    );
  });

  it("消息含分因 token、声明版本与每个候选的快照（AC-09b）", () => {
    const msg = buildInterpreterMismatchMessage("3.13", [
      { appName: "exec-a", interpreters: [inf("3.12.3")] },
      {
        appName: "exec-b",
        interpreters: [inf("3.8.3", { available: false })],
      },
      { appName: "exec-c", interpreters: null },
    ]);
    expect(msg).toContain(INTERPRETER_UNAVAILABLE_TOKEN);
    expect(msg).toContain("解释器 3.13 无法获取");
    expect(msg).toContain("缓存缺失");
    expect(msg).toContain("候选执行器:");
    expect(msg).toContain("exec-a[已缓存: 3.12.3]");
    expect(msg).toContain("exec-b[已缓存: 3.8.3(不可用)]");
    expect(msg).toContain("exec-c[未上报，按 3.12 兜底]");
  });

  it("分因 token 出现在任何含 'executor' 的 appName 之前（防 EXECUTOR_OFFLINE 误判）", () => {
    const msg = buildInterpreterMismatchMessage("3.13", [
      { appName: "executor-python-1", interpreters: [] },
    ]);
    // 既有分类器（task.processor.ts / task.service.ts）含
    // /executor.*(offline|unavailable)/i —— 同一行内若 token 排在候选清单之后，
    // 就会形成 "executor ... unavailable" 的假匹配，把明确失败误判成"执行器
    // 离线"从而触发无意义的重试（D14 明确不进默认重试集）。
    expect(msg.indexOf(INTERPRETER_UNAVAILABLE_TOKEN)).toBeLessThan(
      msg.toLowerCase().indexOf("executor-python-1"),
    );
    // 用**真实分类器正则**做判据（而不是脆弱的子串断言）。
    expect(msg).not.toMatch(
      /no available executor|executor.*(offline|unavailable)/i,
    );
  });

  it("WS1 的 INTERPRETER_UNAVAILABLE_PATTERN 能命中本消息（分因三处同步的读面）", () => {
    const msg = buildInterpreterMismatchMessage("3.13", [
      { appName: "executor-python-1", interpreters: [] },
    ]);
    // 与 modules/task/task.service.ts 的 INTERPRETER_UNAVAILABLE_PATTERN 同源
    // （该常量未导出，故此处按同一组判据逐条断言——任一条命中即归因成功）。
    const patterns = [
      /interpreter[^\n]{0,40}?(?:unavailable|not found|missing|unable)/,
      /解释器[^\n]{0,20}?(?:无法获取|不可用|不可获得|缺失|找不到)/,
    ];
    const text = msg.toLowerCase();
    expect(patterns.some((p) => p.test(text))).toBe(true);
  });

  it("候选为空 → 明确占位而非空串", () => {
    expect(buildInterpreterMismatchMessage("3.13", [])).toContain(
      "（无候选执行器）",
    );
  });

  it("候选超 10 条折叠为 …等 N 个（防消息爆炸）", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      appName: `e${i}`,
      interpreters: [inf("3.12.3")],
    }));
    const msg = buildInterpreterMismatchMessage("3.13", many);
    expect(msg).toContain("…等 25 个");
    expect(msg).toContain("e0[已缓存: 3.12.3]");
    expect(msg).toContain("e9[已缓存: 3.12.3]");
    expect(msg).not.toContain("e10[已缓存");
  });

  it("非数组 snapshots → 不抛错，退化为无候选", () => {
    expect(
      buildInterpreterMismatchMessage(
        "3.13",
        null as unknown as { appName: string }[],
      ),
    ).toContain("（无候选执行器）");
  });
});
