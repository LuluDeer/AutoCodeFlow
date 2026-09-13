import {
  compareDottedVersions,
  isVersionCompliant,
} from "../version-compare.util";

describe("version-compare.util (EXE-VER-1)", () => {
  describe("compareDottedVersions", () => {
    it.each([
      ["1.0.0", "1.0.0", 0],
      ["1.2", "1.2.0", 0],
      ["1.2", "1.3.0", -1],
      ["1.3.0", "1.2", 1],
      ["2.0", "1.9.9", 1],
      ["1.10.0", "1.9.0", 1],
      ["1", "1.0.0.0", 0],
    ])("%s vs %s -> %i", (a, b, expected) => {
      expect(compareDottedVersions(a, b)).toBe(expected);
    });

    it("拒绝非数字/负数/空串/超段数，返回 NaN", () => {
      expect(compareDottedVersions("abc", "1.0.0")).toBeNaN();
      expect(compareDottedVersions("1.0.0", "-1")).toBeNaN();
      expect(compareDottedVersions("", "1.0.0")).toBeNaN();
      expect(compareDottedVersions("1.0.0", "")).toBeNaN();
      expect(compareDottedVersions("1.2.3.4.5", "1.0.0")).toBeNaN();
      expect(compareDottedVersions("1.0.0", "1..2")).toBeNaN();
    });

    it("接受前导零（按数值比较）", () => {
      expect(compareDottedVersions("01.02", "1.2")).toBe(0);
    });
  });

  describe("isVersionCompliant", () => {
    it("门禁关（minVersion 空）恒合规", () => {
      expect(isVersionCompliant("0.0.1", "")).toBe(true);
      expect(isVersionCompliant("0.0.1", null)).toBe(true);
      expect(isVersionCompliant(undefined, "1.3.0")).toBe(true);
    });

    it("执行器未上报 version（存量旧执行器）按合规放行", () => {
      expect(isVersionCompliant(undefined, "1.3.0")).toBe(true);
      expect(isVersionCompliant(null, "1.3.0")).toBe(true);
      expect(isVersionCompliant("", "1.3.0")).toBe(true);
    });

    it("门禁开：低于拒/等于与高于合规", () => {
      expect(isVersionCompliant("1.2.9", "1.3.0")).toBe(false);
      expect(isVersionCompliant("1.3.0", "1.3.0")).toBe(true);
      expect(isVersionCompliant("1.3.1", "1.3.0")).toBe(true);
    });

    it("畸形版本号（NaN）按合规放行，不锁死执行器", () => {
      expect(isVersionCompliant("not-a-version", "1.3.0")).toBe(true);
    });
  });
});
