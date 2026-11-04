import { Logger } from "@nestjs/common";
import {
  ExecutorRegisterReport,
  type ExecutorRegisterReportDeps,
} from "../executor-register-report.collaborator";

/**
 * T1-B3d 的独立单测（**不走 DI 装配**，`new ExecutorRegisterReport({...})` 直构）。
 *
 * ## 钉住三件"错了会静默"的事
 *
 * 1. **容量非法 ⇒ 视同未上报**（不落库、保留既有值/列默认），**不是**钳成某个值。
 *    真机审计过的后果：`maxConcurrentTasks: 0` 落库 ⇒ 容量闸 `runningTaskCount < max`
 *    恒 false ⇒ **该执行器被永久排除在派发之外**（"注册成功、永远收不到一个任务"）。
 * 2. **三态字段的「缺省」必须与「非法」分开**：缺省 ⇒ 不动 DB（旧执行器重注册
 *    不得把已上报的事实擦掉）；非法 ⇒ 拒绝采纳 + warn；合法（含 `[]`）⇒ 覆盖。
 * 3. **入参校验先于一切 DB 读/写**：非法字段 ⇒ 400 `EXECUTOR_REGISTER_FIELD_INVALID`，
 *    且 `appName` 空白必拒（它是行的身份列）。
 */

const makeDeps = (over: Partial<ExecutorRegisterReportDeps> = {}) => {
  const warn = jest.fn();
  const logger = { warn, debug: jest.fn(), log: jest.fn(), error: jest.fn() } as unknown as Logger;
  const deps: ExecutorRegisterReportDeps = {
    logger,
    isAdoptableMaxConcurrentTasks: (v) =>
      typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10_000,
    ...over,
  };
  return { deps, warn };
};

const ADDR = "10.0.0.9:3002";

describe("ExecutorRegisterReport（T1-B3d 独立单测）", () => {
  describe("assertValidIdentityFields", () => {
    it("appName 空白 ⇒ 抛 EXECUTOR_REGISTER_FIELD_INVALID（必填）", () => {
      const { deps } = makeDeps();
      const c = new ExecutorRegisterReport(deps);
      expect(() => c.assertValidIdentityFields({ appName: "  " })).toThrow(
        /appName|必填/,
      );
    });

    it("address 含控制字符 ⇒ 抛（身份键入站闸）", () => {
      const { deps } = makeDeps();
      const c = new ExecutorRegisterReport(deps);
      expect(() =>
        c.assertValidIdentityFields({ appName: "ok", address: 'bad"quote' }),
      ).toThrow();
    });

    it("合法字段 ⇒ 不抛", () => {
      const { deps } = makeDeps();
      const c = new ExecutorRegisterReport(deps);
      expect(() =>
        c.assertValidIdentityFields({ appName: "node", address: ADDR }),
      ).not.toThrow();
    });
  });

  describe("resolveRegisterReport — 容量", () => {
    it("合法容量 ⇒ 采纳", () => {
      const { deps } = makeDeps();
      const c = new ExecutorRegisterReport(deps);
      const out = c.resolveRegisterReport(
        { appName: "n", address: ADDR, maxConcurrentTasks: 8 },
        ADDR,
      );
      expect(out.maxConcurrentTasks).toBe(8);
    });

    it("maxConcurrentTasks=0 ⇒ **视同未上报**（undefined）+ warn，**不是**钳成 1", () => {
      const { deps, warn } = makeDeps();
      const c = new ExecutorRegisterReport(deps);
      const out = c.resolveRegisterReport(
        { appName: "n", address: ADDR, maxConcurrentTasks: 0 },
        ADDR,
      );
      expect(out.maxConcurrentTasks).toBeUndefined();
      expect(warn.mock.calls.map((c2) => String(c2[0])).join("\n")).toContain(
        "invalid maxConcurrentTasks=0",
      );
    });

    it("maxConcurrentTasks=99999 ⇒ 视同未上报 + warn", () => {
      const { deps, warn } = makeDeps();
      const c = new ExecutorRegisterReport(deps);
      const out = c.resolveRegisterReport(
        { appName: "n", address: ADDR, maxConcurrentTasks: 99_999 },
        ADDR,
      );
      expect(out.maxConcurrentTasks).toBeUndefined();
      expect(warn.mock.calls.map((c2) => String(c2[0])).join("\n")).toContain(
        "invalid maxConcurrentTasks=99999",
      );
    });

    it("未上报容量 ⇒ undefined 且**零 warn**（好路径零噪音）", () => {
      const { deps, warn } = makeDeps();
      const c = new ExecutorRegisterReport(deps);
      const out = c.resolveRegisterReport({ appName: "n", address: ADDR }, ADDR);
      expect(out.maxConcurrentTasks).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it("maxConcurrent（旧字段名）同样生效", () => {
      const { deps } = makeDeps();
      const c = new ExecutorRegisterReport(deps);
      const out = c.resolveRegisterReport(
        { appName: "n", address: ADDR, maxConcurrent: 4 },
        ADDR,
      );
      expect(out.maxConcurrentTasks).toBe(4);
    });
  });

  describe("resolveRegisterReport — 三态字段", () => {
    it("缺省 ⇒ null（不动 DB）+ 零 warn", () => {
      const { deps, warn } = makeDeps();
      const c = new ExecutorRegisterReport(deps);
      const out = c.resolveRegisterReport({ appName: "n", address: ADDR }, ADDR);
      expect(out.normalizedInterpreters).toBeNull();
      expect(out.normalizedInstalledPackages).toBeNull();
      expect(out.normalizedDeployedApps).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    });

    it("interpreters=[] 是**合法上报**（池空）⇒ 采纳空数组，不 warn", () => {
      const { deps, warn } = makeDeps();
      const c = new ExecutorRegisterReport(deps);
      const out = c.resolveRegisterReport(
        { appName: "n", address: ADDR, interpreters: [] },
        ADDR,
      );
      expect(out.normalizedInterpreters).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("interpreters 结构非法 ⇒ null（保旧值）+ warn", () => {
      const { deps, warn } = makeDeps();
      const c = new ExecutorRegisterReport(deps);
      const out = c.resolveRegisterReport(
        { appName: "n", address: ADDR, interpreters: [{ nope: 1 }] as never },
        ADDR,
      );
      expect(out.normalizedInterpreters).toBeNull();
      expect(warn.mock.calls.map((c2) => String(c2[0])).join("\n")).toContain(
        "invalid interpreters payload",
      );
    });

    it("installedPackages 结构非法 ⇒ null + warn", () => {
      const { deps, warn } = makeDeps();
      const c = new ExecutorRegisterReport(deps);
      const out = c.resolveRegisterReport(
        { appName: "n", address: ADDR, installedPackages: "nope" as never },
        ADDR,
      );
      expect(out.normalizedInstalledPackages).toBeNull();
      expect(warn.mock.calls.map((c2) => String(c2[0])).join("\n")).toContain(
        "invalid installedPackages payload",
      );
    });

    it("deployedApps 结构非法 ⇒ null + warn", () => {
      const { deps, warn } = makeDeps();
      const c = new ExecutorRegisterReport(deps);
      const out = c.resolveRegisterReport(
        { appName: "n", address: ADDR, deployedApps: 42 as never },
        ADDR,
      );
      expect(out.normalizedDeployedApps).toBeNull();
      expect(warn.mock.calls.map((c2) => String(c2[0])).join("\n")).toContain(
        "invalid deployedApps payload",
      );
    });

    it("合法三态字段全部归一通过", () => {
      const { deps } = makeDeps();
      const c = new ExecutorRegisterReport(deps);
      const out = c.resolveRegisterReport(
        {
          appName: "n",
          address: ADDR,
          interpreters: [{ version: "3.12" }],
          installedPackages: [{ name: "p", type: "npm", version: "1.0.0" }],
          deployedApps: [
            {
              appId: "a1",
              currentVersion: "1.0.0",
              currentReleaseKey: null,
              retainedVersions: [],
              runMode: null,
              lastDeployedAt: null,
            },
          ],
        },
        ADDR,
      );
      expect(out.normalizedInterpreters).toEqual([{ version: "3.12" }]);
      expect(out.normalizedInstalledPackages).toHaveLength(1);
      expect(out.normalizedDeployedApps).toHaveLength(1);
    });
  });
});
