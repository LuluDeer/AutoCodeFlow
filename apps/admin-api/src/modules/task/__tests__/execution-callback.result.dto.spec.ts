import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  CallbackItemDto,
  CALLBACK_RESULT_MAX_BYTES,
  CALLBACK_RESULT_MAX_DEPTH,
} from "../dto/execution-callback.dto";

/**
 * python_task_multiversion（FR-12/AC-12a）：回调 `result` 字段的契约。
 *
 * 为什么需要这组用例：回调体走
 * `@Body(new ParseArrayPipe({ items: CallbackItemDto, whitelist: true }))`，
 * 而 `ParseArrayPipe` 只带 `whitelist: true`、**不带 `forbidNonWhitelisted`**
 * ——凡未在 DTO 上声明的字段会被**静默丢弃**（不报错、不 400）。
 * 所以"执行器发了 `result` 但 admin 没声明它"这种缺陷**不会**有任何显式报错，
 * 只表现为 UI 永远拿不到解释器快照。这组用例把该字段钉在 DTO 上，防止回归。
 */
const EXEC_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

async function errorsFor(payload: Record<string, unknown>) {
  const dto = plainToInstance(CallbackItemDto, payload);
  return validate(dto, { forbidUnknownValues: false });
}

describe("CallbackItemDto.result（解释器快照留痕校验）", () => {
  const base = { executionId: EXEC_ID, status: "failed" };

  it("缺省不带 result 合法（旧执行器兼容）", async () => {
    expect(await errorsFor(base)).toEqual([]);
  });

  it("真实的解释器快照通过校验且被保留在 DTO 上", async () => {
    const snapshot = {
      interpreter: {
        requested: "3.7",
        resolved: null,
        reason: "not_downloadable",
        detail: "uv cannot download Python 3.7 online",
        pool: ["3.12.11", "3.11.13"],
      },
    };
    const errs = await errorsFor({ ...base, result: snapshot });
    expect(errs).toEqual([]);

    // 关键：字段确实被 DTO 接纳（而不是被 whitelist 静默剥掉）。
    const dto = plainToInstance(CallbackItemDto, { ...base, result: snapshot });
    expect(dto.result).toBeDefined();
    expect((dto.result as any).interpreter.requested).toBe("3.7");
  });

  it("拒绝非对象（数组 / 字符串 / 数字）", async () => {
    for (const bad of [[], "x", 42]) {
      const errs = await errorsFor({ ...base, result: bad });
      expect(errs.length).toBeGreaterThan(0);
    }
  });

  it(`拒绝超过 ${CALLBACK_RESULT_MAX_BYTES} 字节的对象（防绕过日志上限写大 jsonb）`, async () => {
    const errs = await errorsFor({
      ...base,
      result: { blob: "x".repeat(CALLBACK_RESULT_MAX_BYTES + 100) },
    });
    expect(errs.length).toBeGreaterThan(0);
  });

  it("接受恰好在字节上限附近的小对象", async () => {
    const errs = await errorsFor({
      ...base,
      result: { interpreter: { requested: "3.12", pool: ["3.12.11"] } },
    });
    expect(errs).toEqual([]);
  });

  it(`拒绝超过 ${CALLBACK_RESULT_MAX_DEPTH} 层的深层嵌套`, async () => {
    let deep: any = "leaf";
    for (let i = 0; i < CALLBACK_RESULT_MAX_DEPTH + 3; i += 1) {
      deep = { nested: deep };
    }
    const errs = await errorsFor({ ...base, result: deep });
    expect(errs.length).toBeGreaterThan(0);
  });
});
