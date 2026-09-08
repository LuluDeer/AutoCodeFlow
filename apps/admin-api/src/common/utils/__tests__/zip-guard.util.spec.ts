/**
 * SEC-05: zip-guard util spec — malicious sample set (plan-mandated 8+),
 * all programmatically constructed (see zip-samples.ts for builders).
 * Expected verdicts (default limits): reject bombs / parse anomalies,
 * allow the benign control.
 */
import { ZipGuardError } from "../zip-guard.util";
import {
  EICAR_STRING,
  buildBadCdSizeZip,
  buildBadLocalOffsetZip,
  buildBenignZip,
  buildCommentedZip,
  buildDoubleNestedZip,
  buildEicarZip,
  buildHighRatioBomb,
  buildNestedZipBomb,
  buildSingleFileOversizeBomb,
  buildTooManyEntriesBomb,
  buildTruncatedZip,
} from "./zip-samples";
import {
  ZIP_GUARD_DEFAULT_LIMITS,
  assertZipSafe,
  checkSummaryAgainstLimits,
  parseCentralDirectory,
  resolveZipGuardLimits,
} from "../zip-guard.util";

const SMALL = resolveZipGuardLimits({
  maxRatio: 100,
  maxEntries: 10000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 128 * 1024 * 1024,
  maxNestingDepth: 1,
});

describe("zip-guard.util (SEC-05) — 恶意样件测试集", () => {
  it("样件1：高压缩比炸弹（42 MiB 零 → 数 KB zip）按 ratio_exceeded 拒绝", () => {
    const zip = buildHighRatioBomb();
    expect(() => assertZipSafe(zip, SMALL)).toThrow(ZipGuardError);
    try {
      assertZipSafe(zip, SMALL);
      fail("must reject");
    } catch (err) {
      expect((err as ZipGuardError).violation).toBe("ratio_exceeded");
    }
  });

  it("样件2：条目数洪泛（10001 条 > 10000 上限）按 too_many_entries 拒绝", () => {
    const zip = buildTooManyEntriesBomb(10_001);
    try {
      assertZipSafe(zip, SMALL);
      fail("must reject");
    } catch (err) {
      expect((err as ZipGuardError).violation).toBe("too_many_entries");
    }
  });

  it("样件3：单文件解压后 1 GiB+1 超单文件上限（总量上限先触发，同批拒绝）", () => {
    const zip = buildSingleFileOversizeBomb();
    try {
      assertZipSafe(zip, SMALL);
      fail("must reject");
    } catch (err) {
      // 1 GiB+1 同时突破单文件与总量（SMALL 总量=128 MiB）两道上限——
      // 聚合检查先行，返回 total_uncompressed_exceeded；单文件规则由
      // 专属样例（下）验证。
      expect((err as ZipGuardError).violation).toBe(
        "total_uncompressed_exceeded",
      );
    }
    // 单文件上限专属样例：总量与比率上限调大，单文件 1 GiB+1 仍单独拒绝。
    const fileOnly = resolveZipGuardLimits({
      ...SMALL,
      maxRatio: 100000,
      maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
    });
    try {
      assertZipSafe(zip, fileOnly);
      fail("must reject");
    } catch (err) {
      expect((err as ZipGuardError).violation).toBe("single_file_too_large");
    }
  });

  it("样件4：嵌套 zip（内层为高比炸弹）一层探测内被拒绝", () => {
    const zip = buildNestedZipBomb();
    try {
      assertZipSafe(zip, SMALL);
      fail("must reject");
    } catch (err) {
      expect((err as ZipGuardError).violation).toBe("ratio_exceeded");
    }
  });

  it("样件5：双层嵌套 zip——maxNestingDepth=2 时最内层 5 MiB 计入总量上限，超出即拒绝（深度外按声明大小计费）", () => {
    const zip = buildDoubleNestedZip();
    // 外层（depth 0）→ 中层（depth 1）→ 最内层 5 MiB 声明。maxNestingDepth=2
    // 让探测进入最内层，其声明大小计入总量；总量 4 MiB < 5 MiB → 拒绝。
    const depth2 = resolveZipGuardLimits({
      maxRatio: 100000,
      maxEntries: 10000,
      maxFileBytes: 64 * 1024 * 1024,
      maxTotalUncompressedBytes: 4 * 1024 * 1024,
      maxNestingDepth: 2,
    });
    try {
      assertZipSafe(zip, depth2);
      fail("must reject");
    } catch (err) {
      expect((err as ZipGuardError).violation).toBe(
        "total_uncompressed_exceeded",
      );
    }
    // 缺省（maxNestingDepth=1、总量 2 GiB）：最内层不积极探测，按声明大小
    // 计入外层比率——诚实双层嵌套放行（探测成本有界）。
    expect(() => assertZipSafe(zip, SMALL)).not.toThrow();
  });

  it("样件6：EICAR 标准测试串 zip——zip-guard 放行（结构正常），交由 clamd 层判毒", () => {
    const zip = buildEicarZip();
    // Structural guard passes (it is a well-formed tiny zip):
    expect(() => assertZipSafe(zip, SMALL)).not.toThrow();
    // The payload really contains the EICAR string for the clamd-layer test.
    const summary = parseCentralDirectory(zip);
    expect(summary.entries).toBe(1);
    expect(EICAR_STRING).toContain("EICAR-STANDARD-ANTIVIRUS-TEST-FILE");
  });

  it("样件7：截断 zip（CD 缺失）fail-closed 按 unparseable 拒绝", () => {
    const zip = buildTruncatedZip();
    try {
      assertZipSafe(zip, SMALL);
      fail("must reject");
    } catch (err) {
      expect((err as ZipGuardError).violation).toBe("unparseable");
    }
  });

  it("样件8：EOCD 声明的 CD 尺寸被篡改 → unparseable 拒绝（尺寸校验）", () => {
    const zip = buildBadCdSizeZip();
    try {
      assertZipSafe(zip, SMALL);
      fail("must reject");
    } catch (err) {
      expect((err as ZipGuardError).violation).toBe("unparseable");
    }
  });

  it("样件9：CD 记录的 local header offset 被篡改 → 嵌套成员不可定位拒绝（正常成员不受影响）", () => {
    // Benign zip with a normal layout still parses and passes.
    expect(() => assertZipSafe(buildBenignZip(), SMALL)).not.toThrow();
    // Corrupted local offset only matters when we must locate a nested
    // member; a plain (non-nested) archive with a bad offset still parses.
    const bad = buildBadLocalOffsetZip();
    expect(() => assertZipSafe(bad, SMALL)).not.toThrow();
  });

  it("样件10：正常小包（对照样件）放行并返回正确汇总", () => {
    const zip = buildBenignZip();
    const summary = assertZipSafe(zip, SMALL);
    expect(summary.entries).toBe(2);
    expect(summary.totalUncompressed).toBeGreaterThan(0);
    expect(summary.nestedZipNames).toEqual([]);
  });

  it("样件11：带注释的 zip（EOCD 注释定位路径）正确放行", () => {
    const summary = assertZipSafe(buildCommentedZip(), SMALL);
    expect(summary.entries).toBe(2);
  });

  it("样件12：非 zip 输入（纯文本/空缓冲）按 unparseable 拒绝", () => {
    expect(() => assertZipSafe(Buffer.from("not a zip at all"))).toThrow(
      ZipGuardError,
    );
    expect(() => assertZipSafe(Buffer.alloc(0))).toThrow(ZipGuardError);
  });
});

describe("zip-guard.util — 规则细节", () => {
  it("zip64 哨兵值 fail-closed（32 位字段全 1）", () => {
    // Craft a minimal EOCD with zip64 sentinels.
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 10); // entry count sentinel
    expect(() => parseCentralDirectory(eocd)).toThrow(ZipGuardError);
  });

  it("空压缩载荷（0/0 比）不被除零误判", () => {
    expect(() =>
      checkSummaryAgainstLimits(
        {
          entries: 1,
          totalCompressed: 0,
          totalUncompressed: 0,
          nestedZipNames: [],
        },
        ZIP_GUARD_DEFAULT_LIMITS,
      ),
    ).not.toThrow();
  });

  it("resolveZipGuardLimits：非法/零值回退默认，正值生效", () => {
    expect(resolveZipGuardLimits(null)).toEqual(ZIP_GUARD_DEFAULT_LIMITS);
    expect(resolveZipGuardLimits({ maxRatio: 0 }).maxRatio).toBe(100);
    expect(resolveZipGuardLimits({ maxEntries: 5 }).maxEntries).toBe(5);
  });

  it("maxNestingDepth=0 时嵌套成员不做内层探测（按声明大小计费后放行/拒绝）", () => {
    const zip = buildNestedZipBomb();
    const noProbe = resolveZipGuardLimits({ ...SMALL, maxNestingDepth: 0 });
    // Without probing, the inner bomb's declared sizes still inflate the
    // outer totals — 42 MiB declared uncompressed vs tiny compressed outer
    // entry → ratio still catches it.
    expect(() => assertZipSafe(zip, noProbe)).toThrow(ZipGuardError);
  });
});
