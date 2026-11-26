import {
  GenerationSnapshot,
  SwapState,
  createSwapState,
  isStaleGeneration,
  resolveCurrent,
  rollback,
  sameGeneration,
  stageIncoming,
  swap,
} from "../generation-swap";

describe("N23 generation swap 纯状态机", () => {
  const oldGen: GenerationSnapshot<string> = {
    generation: "gen-1",
    value: "old-value",
  };
  const newGen: GenerationSnapshot<string> = {
    generation: "gen-2",
    value: "new-value",
  };

  it("初始状态：单代服务，resolveCurrent 返回 active", () => {
    const state = createSwapState(oldGen);
    expect(state.phase).toBe("serving");
    expect(state.incoming).toBeNull();
    expect(state.retired).toBeNull();
    expect(resolveCurrent(state)).toBe(state.active);
    expect(resolveCurrent(state).value).toBe("old-value");
  });

  it("两代并存时旧代仍能 resolve（staged 不切 active）", () => {
    const serving = createSwapState(oldGen);
    const staged = stageIncoming(serving, newGen);
    expect(staged.phase).toBe("staged");
    expect(staged.active).toBe(serving.active);
    expect(staged.incoming?.generation).toBe("gen-2");
    // 并发读路径拿到的仍是老代
    expect(resolveCurrent(staged)).toBe(serving.active);
    expect(resolveCurrent(staged).generation).toBe("gen-1");
    expect(resolveCurrent(staged).value).toBe("old-value");
  });

  it("swap 原子提交：active 变为新一代，retired 保留 swap 前的 active", () => {
    const serving = createSwapState(oldGen);
    const staged = stageIncoming(serving, newGen);
    const swapped = swap(staged);
    expect(swapped.phase).toBe("swapped");
    expect(swapped.active).toBe(staged.incoming);
    expect(swapped.active.value).toBe("new-value");
    expect(swapped.retired).toBe(serving.active);
    expect(swapped.incoming).toBeNull();
    expect(resolveCurrent(swapped).generation).toBe("gen-2");
  });

  it("swap 提交点失败（validate=false）时回滚：原状态引用不变，active 未被切换", () => {
    const serving = createSwapState(oldGen);
    const staged = stageIncoming(serving, newGen);
    const failed = swap(staged, () => false);
    // 失败必须恢复到 swap 前的状态（引用级），绝不半切换
    expect(failed).toBe(staged);
    expect(failed.phase).toBe("staged");
    expect(resolveCurrent(failed)).toBe(serving.active);
    expect(resolveCurrent(failed).generation).toBe("gen-1");
    expect(failed.incoming).toBe(staged.incoming);
  });

  it("swap 提交点抛错同样回滚到 swap 前 active", () => {
    const staged = stageIncoming(createSwapState(oldGen), newGen);
    const failed = swap(staged, () => {
      throw new Error("commit rejected");
    });
    expect(failed).toBe(staged);
    expect(resolveCurrent(failed).generation).toBe("gen-1");
  });

  it("validate 收到的是候选代（incoming），可以据此拒绝", () => {
    const staged = stageIncoming(createSwapState(oldGen), newGen);
    const seen: GenerationSnapshot<string>[] = [];
    swap(staged, (candidate) => {
      seen.push(candidate);
      return candidate.generation === "gen-2";
    });
    expect(seen).toEqual([staged.incoming]);
    const rejected = swap(
      staged,
      (candidate) => candidate.generation === "gen-99",
    );
    expect(rejected).toBe(staged);
  });

  it("rollback 精确恢复 swap 前的 active（引用级），清空 retired / incoming", () => {
    const serving = createSwapState(oldGen);
    const swapped = swap(stageIncoming(serving, newGen));
    const restored = rollback(swapped);
    expect(restored.phase).toBe("serving");
    expect(restored.active).toBe(serving.active);
    expect(resolveCurrent(restored)).toBe(serving.active);
    expect(resolveCurrent(restored).generation).toBe("gen-1");
    expect(resolveCurrent(restored).value).toBe("old-value");
    expect(restored.retired).toBeNull();
    expect(restored.incoming).toBeNull();
  });

  it("rollback 在非 swapped 相位是 no-op（返回原引用）", () => {
    const serving = createSwapState(oldGen);
    expect(rollback(serving)).toBe(serving);
    const staged = stageIncoming(serving, newGen);
    expect(rollback(staged)).toBe(staged);
  });

  it("作废判据：同代 incoming 的 stage 与 swap 都 no-op", () => {
    const serving = createSwapState(oldGen);
    const sameGenerationIncoming: GenerationSnapshot<string> = {
      generation: "gen-1",
      value: "duplicated-value",
    };
    expect(stageIncoming(serving, sameGenerationIncoming)).toBe(serving);
    const staged = freezeStage(serving, sameGenerationIncoming);
    expect(swap(staged)).toBe(staged);
  });

  it("作废判据：陈旧 incoming（generation 缺失）不得被提升为 active", () => {
    const serving = createSwapState(oldGen);
    const stale = stageIncoming(serving, { generation: null, value: "stale" });
    expect(stale.incoming?.generation).toBeNull();
    const result = swap(stale);
    expect(result).toBe(stale);
    expect(resolveCurrent(result)).toBe(serving.active);
  });

  it("作废判据：无 incoming 时 swap no-op", () => {
    const serving = createSwapState(oldGen);
    expect(swap(serving)).toBe(serving);
  });

  it("generation 口径：相等即同代，缺失（null/undefined）判旧，空串为合法 token", () => {
    expect(sameGeneration("g1", "g1")).toBe(true);
    expect(sameGeneration("g1", "g2")).toBe(false);
    expect(sameGeneration(null, "g1")).toBe(false);
    expect(sameGeneration(undefined, undefined)).toBe(false);
    expect(sameGeneration("", "")).toBe(true);
    expect(isStaleGeneration(null)).toBe(true);
    expect(isStaleGeneration(undefined)).toBe(true);
    expect(isStaleGeneration("")).toBe(false);
    expect(isStaleGeneration("g1")).toBe(false);
  });

  it("不可变：所有转换都不修改入参状态", () => {
    const serving = createSwapState(oldGen);
    const snapshotBefore = JSON.stringify(serving);
    const staged = stageIncoming(serving, newGen);
    const swapped = swap(staged);
    const restored = rollback(swapped);
    expect(JSON.stringify(serving)).toBe(snapshotBefore);
    expect(serving.phase).toBe("serving");
    expect(serving.incoming).toBeNull();
    expect(staged.phase).toBe("staged");
    expect(staged.incoming?.generation).toBe("gen-2");
    expect(swapped.phase).toBe("swapped");
    expect(restored.phase).toBe("serving");
    expect(Object.isFrozen(serving)).toBe(true);
    expect(Object.isFrozen(staged)).toBe(true);
    expect(Object.isFrozen(swapped.active)).toBe(true);
  });

  it("连续两代 swap：每次 rollback 只回到该次 swap 前的 active", () => {
    const gen3: GenerationSnapshot<string> = {
      generation: "gen-3",
      value: "v3",
    };
    const first = swap(stageIncoming(createSwapState(oldGen), newGen));
    const second = swap(stageIncoming(first, gen3));
    expect(resolveCurrent(second).generation).toBe("gen-3");
    const backToFirst = rollback(second);
    expect(resolveCurrent(backToFirst)).toBe(first.active);
    expect(resolveCurrent(backToFirst).generation).toBe("gen-2");
  });
});

/** 仅供同代 swap 反证使用：绕过 stage 的同代 no-op，直接构造 staged 状态。 */
function freezeStage<T>(
  serving: SwapState<T>,
  incoming: GenerationSnapshot<T>,
): SwapState<T> {
  return {
    phase: "staged",
    active: serving.active,
    incoming,
    retired: null,
  };
}
