/**
 * N18 rewind 代际围栏单测（纯判定层）。
 *
 * 覆盖：同代放行 / 旧代作废 / 计数、归属缺失与歧义判旧、当前代缺失或空串
 * fail-closed、入参不可变、空任务控制组。所有判定都经 part-model 的
 * isStaleGeneration，本测试不重写代际比较。
 */
import {
  fenceAsyncWrites,
  type FencedPart,
  type PendingAsyncWrite,
} from "../rewind-fence";
import type { GenerationToken } from "../part-model";

const CURRENT: GenerationToken = "1111111111111111";
const OLD: GenerationToken = "2222222222222222";

function part(id: string, generation: GenerationToken | null): FencedPart {
  return { id, generation };
}

function write(id: string, partId: string): PendingAsyncWrite {
  return { id, partId };
}

describe("fenceAsyncWrites", () => {
  it("同代 Part 的异步写入放行，作废计数为 0", () => {
    const parts = [part("p1", CURRENT)];
    const writes = [write("w1", "p1")];

    const result = fenceAsyncWrites(parts, CURRENT, writes);

    expect(result.allowed).toEqual([write("w1", "p1")]);
    expect(result.invalidated).toEqual([]);
    expect(result.invalidatedCount).toBe(0);
  });

  it("旧代 Part 对应的异步写入与通知全部作废，并给出作废任务数", () => {
    const parts = [part("p1", CURRENT), part("p2", OLD)];
    const writes = [write("w1", "p1"), write("w2", "p2"), write("w3", "p2")];

    const result = fenceAsyncWrites(parts, CURRENT, writes);

    expect(result.allowed).toEqual([write("w1", "p1")]);
    expect(result.invalidated).toEqual([write("w2", "p2"), write("w3", "p2")]);
    expect(result.invalidatedCount).toBe(2);
  });

  it("Part 无 generation 或任务归属 Part 缺失时判旧（fail-closed）", () => {
    const parts = [part("p1", null)];
    const writes = [write("w1", "p1"), write("w2", "missing")];

    const result = fenceAsyncWrites(parts, CURRENT, writes);

    expect(result.allowed).toEqual([]);
    expect(result.invalidated).toEqual(writes);
    expect(result.invalidatedCount).toBe(2);
  });

  it("同一 partId 出现多份 Part 时归属歧义，判旧", () => {
    const parts = [part("p1", CURRENT), part("p1", CURRENT)];
    const writes = [write("w1", "p1")];

    const result = fenceAsyncWrites(parts, CURRENT, writes);

    expect(result.allowed).toEqual([]);
    expect(result.invalidated).toEqual(writes);
    expect(result.invalidatedCount).toBe(1);
  });

  it("当前代缺失或为空串 ⇒ 全部作废，不让任何异步写入污染新代", () => {
    const parts = [part("p1", CURRENT), part("p2", OLD)];
    const writes = [write("w1", "p1"), write("w2", "p2")];

    for (const missing of [null, undefined, ""] as const) {
      const result = fenceAsyncWrites(parts, missing, writes);
      expect(result.allowed).toEqual([]);
      expect(result.invalidated).toEqual(writes);
      expect(result.invalidatedCount).toBe(2);
    }
  });

  it("空任务列表是控制组：三组结果均为空", () => {
    const result = fenceAsyncWrites([part("p1", CURRENT)], CURRENT, []);

    expect(result.allowed).toEqual([]);
    expect(result.invalidated).toEqual([]);
    expect(result.invalidatedCount).toBe(0);
  });

  it("纯函数：不修改传入的 parts 与 pendingWrites", () => {
    const parts = [part("p1", CURRENT), part("p2", OLD)];
    const writes = [write("w1", "p1"), write("w2", "p2")];
    const partsBefore = JSON.stringify(parts);
    const writesBefore = JSON.stringify(writes);

    fenceAsyncWrites(parts, CURRENT, writes);

    expect(JSON.stringify(parts)).toBe(partsBefore);
    expect(JSON.stringify(writes)).toBe(writesBefore);
  });
});
