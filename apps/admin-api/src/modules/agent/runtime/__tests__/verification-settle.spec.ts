/**
 * 切片 D1（机器验收 fail-closed）核心逻辑单测。
 *
 * 覆盖两件最易回归的事：
 *  1. `parseVerificationVerdict` 纯函数三态收敛——VERDICT 行必须在开头、
 *     大小写/空白宽松、解析不到一律 unclear（fail-closed：绝不假 passed）；
 *  2. `settleVerification` 的条件写语义——只收敛「completed 且未结算」的工单，
 *     不覆盖已有结论（幂等），missing/cancelled 走 debug 跳过路径。
 *
 * 验收级别：单测/内存替身（第 2 级）——settleVerification 用 TypeORM fake
 * repository 断言 update 谓词与写入载荷，不起真 PG。
 */
import { parseVerificationVerdict } from "../agent-session.service";
import { SopService } from "../../../sop/sop.service";

describe("切片 D1 · parseVerificationVerdict（三态收敛）", () => {
  it("pass → passed（含大小写与行首空白宽松）", () => {
    expect(parseVerificationVerdict("VERDICT: pass\n其他说明")).toBe("passed");
    expect(parseVerificationVerdict("  verdict: PASS")).toBe("passed");
    expect(parseVerificationVerdict("Verdict:  pass")).toBe("passed");
  });

  it("fail → failed / unclear → unclear", () => {
    expect(parseVerificationVerdict("VERDICT: fail")).toBe("failed");
    expect(parseVerificationVerdict("VERDICT: unclear")).toBe("unclear");
  });

  it("VERDICT 不在开头 → unclear（防正文中间引用误判）", () => {
    expect(parseVerificationVerdict("复核说明…\nVERDICT: pass")).toBe(
      "unclear",
    );
  });

  it("解析不到 / 非字符串 / 空 → unclear（fail-closed）", () => {
    expect(parseVerificationVerdict(null)).toBe("unclear");
    expect(parseVerificationVerdict(undefined)).toBe("unclear");
    expect(parseVerificationVerdict(42)).toBe("unclear");
    expect(parseVerificationVerdict("")).toBe("unclear");
    expect(parseVerificationVerdict("没有结论正文")).toBe("unclear");
  });

  it("未知值 → unclear（不在 pass|fail|unclear 词表内）", () => {
    expect(parseVerificationVerdict("VERDICT: ok")).toBe("unclear");
    expect(parseVerificationVerdict("VERDICT: passed")).toBe("unclear");
  });

  it("超长正文头部截断后仍可解析（slice 2000 容忍）", () => {
    const pad = "x".repeat(1990);
    expect(parseVerificationVerdict(`${pad}VERDICT: pass`)).toBe("unclear");
    expect(parseVerificationVerdict(`VERDICT: pass\n${pad}`)).toBe("passed");
  });
});

describe("切片 D1 · settleVerification 条件写语义", () => {
  function makeService(updateResult: { affected?: number | null }) {
    const update = jest.fn(async () => updateResult);
    const service = Object.create(SopService.prototype) as SopService;
    // 最小替身：仅注入 assignments.update 与 logger（不动 DI 容器）。
    (service as unknown as { assignments: { update: unknown } }).assignments = {
      update,
    };
    (
      service as unknown as {
        logger: { debug: unknown; warn: unknown; error: unknown };
      }
    ).logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return { service, update };
  }

  it("恰收敛 1 行：写 verdict + checkedAt（幂等谓词 completed + IsNull）", async () => {
    const { service, update } = makeService({ affected: 1 });
    await (
      service as unknown as {
        settleVerification: (
          id: string,
          v: "passed" | "failed" | "unclear",
        ) => Promise<void>;
      }
    ).settleVerification("a-1", "passed");
    const call = update.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    const [criteria, patch] = call;
    expect(criteria).toMatchObject({ id: "a-1", status: "completed" });
    expect(criteria.verificationCheckedAt).toBeDefined();
    expect(patch).toMatchObject({ verificationStatus: "passed" });
    expect(patch.verificationCheckedAt).toBeInstanceOf(Date);
  });

  it("affected≠1（missing/cancelled/已结算）→ 不抛错，debug 跳过", async () => {
    const { service, update } = makeService({ affected: 0 });
    await expect(
      (
        service as unknown as {
          settleVerification: (
            id: string,
            v: "passed" | "failed" | "unclear",
          ) => Promise<void>;
        }
      ).settleVerification("a-2", "failed"),
    ).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("already-settled（affected=2 理论不可能，防御式）→ 同样跳过不覆盖", async () => {
    const { service } = makeService({ affected: 2 });
    await expect(
      (
        service as unknown as {
          settleVerification: (
            id: string,
            v: "passed" | "failed" | "unclear",
          ) => Promise<void>;
        }
      ).settleVerification("a-3", "unclear"),
    ).resolves.toBeUndefined();
  });
});
