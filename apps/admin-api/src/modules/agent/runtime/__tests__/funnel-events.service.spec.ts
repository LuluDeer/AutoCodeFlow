import type { Repository } from "typeorm";

import { FunnelEvent } from "../../entities/funnel-event.entity";
import {
  FunnelEventsService,
  type RecordFunnelEventInput,
} from "../funnel-events.service";
import type { TelemetryOptinService } from "../telemetry-optin.service";

interface InsertRow {
  installId: string;
  eventName: string;
  taskIdHash: string | null;
  executionIdHash: string | null;
  ts: Date;
  dedupeKey: string;
}

/**
 * 内存替身：按 dedupeKey 模拟唯一索引 + ON CONFLICT DO NOTHING。
 * `committedInserts` 记的是**真正落库的行数**，不是 SQL builder 的调用次数。
 */
class MemoryFunnelRepo {
  readonly rows: InsertRow[] = [];
  readonly seen = new Set<string>();
  committedInserts = 0;

  createQueryBuilder = jest.fn(() => {
    let values: InsertRow[] = [];
    let ignored = false;
    const qb = {
      insert: jest.fn(() => qb),
      into: jest.fn(() => qb),
      values: jest.fn((input: InsertRow | InsertRow[]) => {
        values = Array.isArray(input) ? input : [input];
        return qb;
      }),
      returning: jest.fn(() => qb),
      orIgnore: jest.fn(() => {
        ignored = true;
        return qb;
      }),
      execute: jest.fn(async () => {
        expect(ignored).toBe(true);
        const inserted: InsertRow[] = [];
        for (const row of values) {
          if (this.seen.has(row.dedupeKey)) continue;
          this.seen.add(row.dedupeKey);
          this.rows.push(row);
          this.committedInserts += 1;
          inserted.push(row);
        }
        return { raw: inserted, affected: inserted.length, generatedMaps: [] };
      }),
    };
    return qb;
  });
}

/**
 * opt-in 替身：默认 true，保持既有写入用例的原语义；
 * 未授权 / 异常路径用 mockResolvedValue(false) / mockRejectedValue 改写。
 */
class MemoryOptin {
  isOptedIn = jest.fn(async (_installId: string): Promise<boolean> => true);
}

const makeService = (
  repo: MemoryFunnelRepo,
  optin: Pick<TelemetryOptinService, "isOptedIn"> = new MemoryOptin(),
): FunnelEventsService =>
  new FunnelEventsService(
    repo as unknown as Repository<FunnelEvent>,
    optin as unknown as TelemetryOptinService,
  );

const input: RecordFunnelEventInput = {
  installId: "inst-1",
  eventName: "install_completed",
  dedupeKey: "install_completed:inst-1",
  ts: new Date("2026-11-21T03:26:00.000Z"),
};

describe("FunnelEventsService.record", () => {
  it("新 dedupeKey：optin=true，recorded=true，真插入一行", async () => {
    const repo = new MemoryFunnelRepo();
    const optin = new MemoryOptin();

    const verdict = await makeService(repo, optin).record(input);

    expect(verdict).toEqual({ recorded: true });
    expect(optin.isOptedIn).toHaveBeenCalledWith(input.installId);
    expect(repo.committedInserts).toBe(1);
    expect(repo.rows).toHaveLength(1);
  });

  it("重复 dedupeKey：optin=true，recorded=false，实际 insert 仍只有一行", async () => {
    const repo = new MemoryFunnelRepo();
    const service = makeService(repo, new MemoryOptin());

    const first = await service.record(input);
    const second = await service.record({
      ...input,
      ts: new Date("2026-11-21T03:30:00.000Z"),
    });

    expect(first).toEqual({ recorded: true });
    expect(second).toEqual({ recorded: false, reason: "duplicate" });
    expect(repo.committedInserts).toBe(1);
    expect(repo.rows).toHaveLength(1);
  });

  it("字段投影：install/event/哈希/ts/dedupeKey 全部落到同一行", async () => {
    const repo = new MemoryFunnelRepo();

    await makeService(repo, new MemoryOptin()).record({
      installId: "inst-2",
      eventName: "task_first_success",
      taskIdHash: "task-hash-2",
      executionIdHash: "exec-hash-2",
      ts: input.ts,
      dedupeKey: "task_first_success:inst-2:exec-hash-2",
    });

    expect(repo.rows[0]).toEqual({
      installId: "inst-2",
      eventName: "task_first_success",
      taskIdHash: "task-hash-2",
      executionIdHash: "exec-hash-2",
      ts: input.ts,
      dedupeKey: "task_first_success:inst-2:exec-hash-2",
    });
  });

  it("未授权 install：recorded=false / not_opted_in，createQueryBuilder 零调用", async () => {
    const repo = new MemoryFunnelRepo();
    const optin = new MemoryOptin();
    optin.isOptedIn.mockResolvedValue(false);

    const verdict = await makeService(repo, optin).record(input);

    expect(verdict).toEqual({ recorded: false, reason: "not_opted_in" });
    expect(optin.isOptedIn).toHaveBeenCalledWith(input.installId);
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    expect(repo.committedInserts).toBe(0);
    expect(repo.rows).toHaveLength(0);
  });

  it("闸门抛异常：fail-closed 返回 not_opted_in，不崩且零 INSERT", async () => {
    const repo = new MemoryFunnelRepo();
    const optin = new MemoryOptin();
    optin.isOptedIn.mockRejectedValue(new Error("config db down"));

    await expect(makeService(repo, optin).record(input)).resolves.toEqual({
      recorded: false,
      reason: "not_opted_in",
    });
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    expect(repo.committedInserts).toBe(0);
    expect(repo.rows).toHaveLength(0);
  });
});
