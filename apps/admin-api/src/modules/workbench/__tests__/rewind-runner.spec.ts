/**
 * N18 rewind runner 单测（内存替身级）。
 *
 * 与 rewind-fence.spec.ts（纯判定）不同，本套断言的是**实际副作用**：
 * 作废组的 apply（落盘 + 通知扇出同源）调用计数必须为 0、放行组必须真正执行，
 * 审计 payload 的 action/resource/resourceId/detail.invalidatedCount 必须真实写入。
 * 框架边界用 jest.mock 替换（@nestjs/* 12.x 为 ESM，ts-jest 以 CJS 装载），
 * 被测 runner 与 rewind-fence 判定均为真实代码。
 */
jest.mock("@nestjs/common", () => ({
  Injectable: () => () => undefined,
  Inject: () => () => undefined,
  Optional: () => () => undefined,
  Logger: class {
    log() {}
    warn() {}
    error() {}
  },
}));

import { RewindRunner } from "../rewind-runner";
import type { FencedPart, PendingAsyncWrite } from "../rewind-fence";

const CURRENT = "1111111111111111";
const OLD = "2222222222222222";

function part(id: string, generation: string | null): FencedPart {
  return { id, generation };
}

function write(id: string, partId: string): PendingAsyncWrite {
  return { id, partId };
}

/** 服务端注入的在途写入源替身：apply 即「落盘 + 通知扇出」的执行面。 */
class FakeWriteSource {
  readonly executed: PendingAsyncWrite[] = [];

  constructor(
    readonly parts: readonly FencedPart[],
    readonly pending: readonly PendingAsyncWrite[],
  ) {}

  async listParts(
    _sessionId: string,
    _partIds?: readonly string[],
  ): Promise<readonly FencedPart[]> {
    return this.parts;
  }

  async listPendingWrites(
    _sessionId: string,
    _partIds?: readonly string[],
  ): Promise<readonly PendingAsyncWrite[]> {
    return this.pending;
  }

  async apply(w: PendingAsyncWrite): Promise<void> {
    this.executed.push(w);
  }
}

function makeGeneration(token: string | null | undefined) {
  return {
    currentGeneration: jest.fn(async (): Promise<string> => token as string),
  };
}

function makeAudit() {
  return { log: jest.fn(async (): Promise<void> => undefined) };
}

function makeRunner(
  token: string | null | undefined,
  source: FakeWriteSource,
  audit: ReturnType<typeof makeAudit>,
) {
  return new RewindRunner(
    makeGeneration(token) as never,
    audit as never,
    source as never,
  );
}

describe("RewindRunner（N18 服务端围栏消费层）", () => {
  it("旧代写入不执行（write 计数 0）、放行组真执行、作废计数为 2", async () => {
    const parts = [part("p1", CURRENT), part("p2", OLD)];
    const pending = [write("w1", "p1"), write("w2", "p2"), write("w3", "p2")];
    const source = new FakeWriteSource(parts, pending);
    const audit = makeAudit();
    const runner = makeRunner(CURRENT, source, audit);

    const result = await runner.rewind({
      sessionId: "s1",
      username: "alice",
    });

    // 副作用断言，不看状态码：作废组从未进入执行面。
    expect(source.executed).toEqual([write("w1", "p1")]);
    expect(source.executed.some((w) => w.partId === "p2")).toBe(false);
    expect(result.executedWriteIds).toEqual(["w1"]);
    expect(result.allowedCount).toBe(1);
    expect(result.invalidatedCount).toBe(2);
  });

  it("审计真实落一条字面量 action=workbench.rewind，resourceId / detail.invalidatedCount 正确", async () => {
    const parts = [part("p1", CURRENT), part("p2", OLD)];
    const pending = [write("w1", "p1"), write("w2", "p2"), write("w3", "p2")];
    const source = new FakeWriteSource(parts, pending);
    const audit = makeAudit();
    const runner = makeRunner(CURRENT, source, audit);

    await runner.rewind({ sessionId: "sess-42", username: "bob" });

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workbench.rewind",
        resource: "workbench",
        resourceId: "sess-42",
        username: "bob",
        detail: { invalidatedCount: 2 },
      }),
    );
  });

  it("全同代时全部放行：每个写入都执行，审计作废计数为 0", async () => {
    const parts = [part("p1", CURRENT), part("p2", CURRENT)];
    const pending = [write("w1", "p1"), write("w2", "p2")];
    const source = new FakeWriteSource(parts, pending);
    const audit = makeAudit();
    const runner = makeRunner(CURRENT, source, audit);

    const result = await runner.rewind({ sessionId: "s2" });

    expect(source.executed).toEqual(pending);
    expect(result.executedWriteIds).toEqual(["w1", "w2"]);
    expect(result.invalidatedCount).toBe(0);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { invalidatedCount: 0 } }),
    );
  });

  it("当前代 null / '' / undefined 时全部作废，任何写入都不执行", async () => {
    const parts = [part("p1", CURRENT), part("p2", CURRENT)];
    const pending = [write("w1", "p1"), write("w2", "p2")];

    for (const token of [null, "", undefined] as const) {
      const source = new FakeWriteSource(parts, pending);
      const audit = makeAudit();
      const runner = makeRunner(token, source, audit);

      const result = await runner.rewind({ sessionId: "s3" });

      expect(source.executed).toEqual([]);
      expect(result.allowedCount).toBe(0);
      expect(result.invalidatedCount).toBe(2);
      expect(result.generation).toBe(token === "" ? "" : null);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ detail: { invalidatedCount: 2 } }),
      );
    }
  });

  it("代际只读服务端注入源：每次 rewind 恰好读一次，客户端入参不含代际字段", async () => {
    const parts = [part("p1", CURRENT)];
    const pending = [write("w1", "p1")];
    const source = new FakeWriteSource(parts, pending);
    const audit = makeAudit();
    const generation = makeGeneration(CURRENT);
    const runner = new RewindRunner(
      generation as never,
      audit as never,
      source as never,
    );

    await runner.rewind({ sessionId: "s4", partIds: ["p1"] });

    expect(generation.currentGeneration).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });
});
