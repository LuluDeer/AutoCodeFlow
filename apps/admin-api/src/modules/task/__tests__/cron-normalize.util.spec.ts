/**
 * cron 写边界规范化（cron UX 统一）单测。
 *
 * 背景：裸 `n/step`（如 `12/20`）是 POSIX/Vixie 合法语义（≡ `n-max/step`，
 * 展开集合严格一致），Linux crontab / Quartz 用户会自然写出，但调度器
 * node-cron 拒绝该形态。normalizeCron5Field 在写边界做**等价改写**：
 * 用户语法不打折，落库永远是调度器可注册的规范式。
 *
 * 本 spec 钉三件事：
 *   1. 改写结果精确（含逗号混写、各字段上限、幂等性）；
 *   2. 改写语义等价——用 POSIX 展开helper 验证 raw 与 canonical 的字段
 *      集合完全一致（trigger-preview.test.ts 侧另有 node-cron 触发时刻
 *      级的等价断言互为印证）；
 *   3. 结构不可解析 fail-closed 返回 null（不产出半成品规范式）。
 */
import * as nodeCron from "node-cron";
import {
  isCron5FieldInBounds,
  normalizeCron5Field,
} from "../cron-normalize.util";

/** POSIX/Vixie 单字段展开（含裸 n/step = n..max/step 语义），供等价性比对 */
function expandField(
  raw: string,
  min: number,
  max: number,
): Set<number> | null {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[3] !== undefined ? parseInt(m[3], 10) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      lo = parseInt(m[1], 10);
      hi =
        m[2] !== undefined ? parseInt(m[2], 10) : m[3] !== undefined ? max : lo;
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
      if (lo < min || hi > max || lo > hi) return null;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/** 按字段展开整条 5 段表达式（规范式与裸 n/step 原串都能吃） */
function expandAll(expr: string): Array<Set<number>> | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const out: Array<Set<number>> = [];
  for (let i = 0; i < 5; i++) {
    const expanded = expandField(
      fields[i],
      FIELD_RANGES[i][0],
      FIELD_RANGES[i][1],
    );
    if (!expanded) return null;
    out.push(expanded);
  }
  return out;
}

describe("normalizeCron5Field（裸 n/step 等价改写）", () => {
  it("裸 n/step → n-max/step（各字段上限正确）", () => {
    expect(normalizeCron5Field("12/20 6-23 * * *")).toBe("12-59/20 6-23 * * *");
    expect(normalizeCron5Field("5/10 * * * *")).toBe("5-59/10 * * * *");
    expect(normalizeCron5Field("0 5/10 * * *")).toBe("0 5-23/10 * * *");
    expect(normalizeCron5Field("0 8 * * 1/2")).toBe("0 8 * * 1-7/2");
    expect(normalizeCron5Field("59/15 * * * *")).toBe("59-59/15 * * * *");
  });

  it("逗号混写只改写裸步进部分，其余原样保留", () => {
    expect(normalizeCron5Field("12/20,45 * * * *")).toBe("12-59/20,45 * * * *");
    expect(normalizeCron5Field("0 9-17/2,5/10 * * *")).toBe(
      "0 9-17/2,5-23/10 * * *",
    );
  });

  it("规范式原样返回（幂等）且多余空白被折叠", () => {
    expect(normalizeCron5Field("*/20 6-23 * * *")).toBe("*/20 6-23 * * *");
    expect(normalizeCron5Field("12-59/20 6-23 * * *")).toBe(
      "12-59/20 6-23 * * *",
    );
    expect(normalizeCron5Field("  0   8  *  *  1-5 ")).toBe("0 8 * * 1-5");
  });

  it("改写幂等：normalize(normalize(x)) === normalize(x)", () => {
    for (const raw of [
      "12/20 6-23 * * *",
      "5/10 * * * *",
      "0 8 * * 1/2",
      "12/20,45 * * * *",
    ]) {
      const once = normalizeCron5Field(raw)!;
      expect(normalizeCron5Field(once)).toBe(once);
    }
  });

  it("改写产物全部可被调度器注册（nodeCron.validate）", () => {
    for (const raw of [
      "12/20 6-23 * * *",
      "5/10 * * * *",
      "0 5/10 * * *",
      "0 8 * * 1/2",
      "59/15 * * * *",
      "12/20,45 * * * *",
    ]) {
      const canonical = normalizeCron5Field(raw);
      expect(canonical).not.toBeNull();
      expect(nodeCron.validate(canonical!)).toBe(true);
    }
  });

  it("语义等价：raw 与 canonical 的逐字段展开集合完全一致", () => {
    for (const raw of [
      "12/20 6-23 * * *",
      "5/10 * * * *",
      "0 5/10 * * *",
      "0 8 * * 1/2",
      "12/20,45 * * * *",
    ]) {
      const canonical = normalizeCron5Field(raw)!;
      expect(expandAll(canonical)).toEqual(expandAll(raw));
    }
    // 抽样钉死用户报障现场的分钟集合：12/20 → {12, 32, 52}
    const minute = expandAll("12/20 6-23 * * *")![0];
    expect([...minute].sort((a, b) => a - b)).toEqual([12, 32, 52]);
  });

  it("结构不可解析 fail-closed 返回 null（不产出半成品规范式）", () => {
    expect(normalizeCron5Field("")).toBeNull();
    expect(normalizeCron5Field("   ")).toBeNull();
    expect(normalizeCron5Field("abc")).toBeNull();
    expect(normalizeCron5Field("12/0 * * * *")).toBeNull(); // 步进 0
    expect(normalizeCron5Field("0 12 * *")).toBeNull(); // 4 段
    expect(normalizeCron5Field("0 12 * * * *")).toBeNull(); // 6 段
    expect(normalizeCron5Field(42 as unknown as string)).toBeNull();
    expect(normalizeCron5Field(null as unknown as string)).toBeNull();
    expect(normalizeCron5Field(undefined as unknown as string)).toBeNull();
  });

  it("越界/倒序范围：validate 误放行，界内守卫兜底", () => {
    // node-cron v4 的 validate 对分钟字段的越界范围（"70-59/20"）与倒序
    // 范围（"12-5"）返回 true、schedule 不抛错，但永不触发——这正是 DTO 门
    // 必须并列 isCron5FieldInBounds 的原因；预览器/维护窗口 parseField 对
    // 同一形态也是拒绝的（越界/lo>hi → null）。
    const canonical = normalizeCron5Field("70/20 * * * *")!;
    expect(canonical).toBe("70-59/20 * * * *");
    expect(nodeCron.validate(canonical)).toBe(true); // validate 误放
    expect(isCron5FieldInBounds(canonical)).toBe(false); // 守卫兜底
    expect(isCron5FieldInBounds("12-5 * * * *")).toBe(false);
    // 对照：界内正常范围/步进不受守卫影响
    expect(isCron5FieldInBounds("12-59/20 6-23 * * *")).toBe(true);
    expect(isCron5FieldInBounds("32-40 * * * *")).toBe(true);
  });
});
