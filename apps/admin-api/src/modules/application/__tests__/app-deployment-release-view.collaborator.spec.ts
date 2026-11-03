import { Logger } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AppDeploymentReleaseView,
  RELEASES_DEFAULT_PAGE_SIZE,
  RELEASES_MAX_PAGE_SIZE,
  RELEASES_SYNTHETIC_SCAN_PAGE_SIZE,
  type AppDeploymentReleaseViewDeps,
} from "../app-deployment-release-view.collaborator";
import type { AppDeployment } from "../entities/app-deployment.entity";
import type { ApplicationVersion } from "../entities/application-version.entity";

/**
 * T1-B5a 的独立单测（**不走 DI 装配**，`new AppDeploymentReleaseView({...})` 直构）。
 *
 * ## 这些用例钉住三件"错了会静默"的事
 *
 * 1. **只读性** —— 本簇是 `/versions` 与 `/releases` 两条只读追溯面。若哪天
 *    有人往里塞一次 `save`/`update`（哪怕"顺手补个状态"），读接口就会产生
 *    写副作用：GET 被重复调用即重复写、且可能覆盖并发心跳（ADR-026 规则 4
 *    的整行回写族缺陷）。**调用全部读面后断言零写**。
 * 2. **Facade 转发层仍在** —— 既有 spec 用 ① 直调 `service.getReleases(...)`
 *    等，转发层被删/被绕过会让 18 个 spec 文件里的直调行为改变。
 * 3. **可恢复性三重守卫** —— 跨应用/无版本号/未 released 三种都必须拒绝；
 *    漏一条就是"从别的应用回滚过来"的越权面。
 */

/** 造一个最小 deps（可覆盖任意项）。 */
function makeDeps(over: Partial<AppDeploymentReleaseViewDeps> = {}) {
  const find = jest.fn().mockResolvedValue([]);
  const findAndCount = jest.fn().mockResolvedValue([[], 0]);
  const findOne = jest.fn().mockResolvedValue(null);
  const save = jest.fn();
  const update = jest.fn();
  const deleteFn = jest.fn();
  const insert = jest.fn();

  const repo = {
    find,
    findAndCount,
    findOne,
    save,
    update,
    delete: deleteFn,
    insert,
  };
  const versionRepo = {
    find: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const warn = jest.fn();
  const logger = {
    debug: jest.fn(),
    warn,
    error: jest.fn(),
    log: jest.fn(),
  } as unknown as Logger;

  const deps: AppDeploymentReleaseViewDeps = {
    repo: repo as never,
    versionRepo: versionRepo as never,
    deploymentEventRepo: null,
    appService: {
      maskEnvForRead: (env: unknown) => ({ ...(env as object), __masked: true }),
    } as never,
    executorService: {
      getAppVersionFacts: jest.fn().mockResolvedValue([]),
    } as never,
    findAllByApp: jest.fn().mockResolvedValue([]),
    logger,
    ...over,
  };
  return {
    deps,
    repo,
    versionRepo,
    warn,
    writers: { save, update, deleteFn, insert },
  };
}

/** 私有 helper 的访问面（`as any` 直构访问，先例同 executor.mutex-claim.spec）。 */
const asAny = (c: AppDeploymentReleaseView): any => c as any;

const mkDeployment = (over: Partial<AppDeployment> = {}): AppDeployment =>
  ({
    id: "d1",
    applicationId: "app-1",
    deployedVersion: "1.0.0",
    deployedCommit: "abc",
    status: "running",
    deployedAt: new Date("2026-10-01T00:00:00Z"),
    createdAt: new Date("2026-09-30T00:00:00Z"),
    executorAddress: "10.0.0.5:3002",
    operator: "alice",
    triggerType: null,
    runMode: null,
    statusMessage: null,
    ...over,
  }) as unknown as AppDeployment;

const mkVersion = (over: Partial<ApplicationVersion> = {}): ApplicationVersion =>
  ({
    id: "v1",
    applicationId: "app-1",
    version: "1.0.0",
    gitCommit: "abc",
    status: "released",
    createdAt: new Date("2026-09-30T00:00:00Z"),
    sourceDeploymentId: "d1",
    createdBy: "alice",
    snapshot: { packageUrl: "s3://pkg/1.0.0.zip", env: { SECRET: "s" } },
    ...over,
  }) as unknown as ApplicationVersion;

describe("AppDeploymentReleaseView（T1-B5a 独立单测）", () => {
  describe("getVersionHistory", () => {
    it("无快照行 → 走 legacy 部署行回退（口径与引入前一致）", async () => {
      const { deps } = makeDeps();
      deps.findAllByApp = jest
        .fn()
        .mockResolvedValue([
          mkDeployment({ id: "d1", deployedVersion: "1.0.0" }),
          mkDeployment({ id: "d2", deployedVersion: "1.0.0" }),
        ]);
      const collab = new AppDeploymentReleaseView(deps);

      const out = await collab.getVersionHistory("app-1");

      expect(out).toHaveLength(1);
      expect(out[0].version).toBe("1.0.0");
      expect(out[0].deployCount).toBe(2);
    });

    it("有快照行 → 合并快照历史并过滤 legacy 重复版本", async () => {
      const { deps, versionRepo } = makeDeps();
      versionRepo.find.mockResolvedValue([mkVersion()]);
      deps.findAllByApp = jest
        .fn()
        .mockResolvedValue([mkDeployment({ deployedVersion: "1.0.0" })]);
      const collab = new AppDeploymentReleaseView(deps);

      const out = await collab.getVersionHistory("app-1");

      // 同一版本只出现一次（快照行胜出，legacy 被 snapshotKeys 过滤）。
      expect(out.filter((r) => r.version === "1.0.0")).toHaveLength(1);
      expect(out[0].id).toBe("v1");
    });

    it("快照 env 被掩码（读面不得回吐应用面已隐藏的秘密）", async () => {
      const { deps, versionRepo } = makeDeps();
      versionRepo.find.mockResolvedValue([mkVersion()]);
      const collab = new AppDeploymentReleaseView(deps);

      const out = await collab.getVersionHistory("app-1");

      expect((out[0].snapshot as Record<string, unknown>).env).toEqual({
        SECRET: "s",
        __masked: true,
      });
    });
  });

  describe("getReleases", () => {
    it("分页参数被限幅（默认 50 / 上限 200，防全表拖库）", async () => {
      const { deps, versionRepo } = makeDeps();
      versionRepo.findAndCount.mockResolvedValue([[], 0]);
      const collab = new AppDeploymentReleaseView(deps);

      expect((await collab.getReleases("app-1")).pageSize).toBe(
        RELEASES_DEFAULT_PAGE_SIZE,
      );
      expect((await collab.getReleases("app-1", 1, 9999)).pageSize).toBe(
        RELEASES_MAX_PAGE_SIZE,
      );
      // 非法/0/负数 → 回退默认，绝不把 0 传给 take。
      expect((await collab.getReleases("app-1", 0, 0)).pageSize).toBe(
        RELEASES_DEFAULT_PAGE_SIZE,
      );
      expect((await collab.getReleases("app-1", -5, 10)).page).toBe(1);
    });

    it("版本行聚合出部署状态与设备徽标（synthetic=false 的版本行）", async () => {
      const { deps, repo, versionRepo } = makeDeps();
      versionRepo.findAndCount.mockResolvedValue([[mkVersion()], 1]);
      repo.find.mockResolvedValue([mkDeployment({ deployedVersion: "1.0.0" })]);
      deps.executorService = {
        getAppVersionFacts: jest.fn().mockResolvedValue([
          {
            executorId: "e1",
            executorName: "node-1",
            currentVersion: "1.0.0",
            retainedVersions: ["1.0.0"],
            online: true,
            lastHeartbeat: null,
          },
        ]),
      } as never;
      const collab = new AppDeploymentReleaseView(deps);

      const out = await collab.getReleases("app-1");

      const row = out.data.find((r) => r.version === "1.0.0")!;
      expect(row.synthetic).toBe(false);
      expect(row.deploymentStatus).toBe("running");
      expect(row.devices).toHaveLength(1);
      expect(row.devices[0].retained).toBe(true);
    });

    it("第 1 页扫描上限用 RELEASES_SYNTHETIC_SCAN_PAGE_SIZE 分页（不整表 find）", async () => {
      const { deps, repo, versionRepo } = makeDeps();
      versionRepo.findAndCount.mockResolvedValue([[], 0]);
      // 返回不足一页 ⇒ 循环立即 break。
      repo.find.mockResolvedValue([]);
      const collab = new AppDeploymentReleaseView(deps);

      await collab.getReleases("app-1");

      const takeArg = repo.find.mock.calls
        .map((c) => (c[0] as { take?: number }).take)
        .filter((t): t is number => typeof t === "number");
      expect(takeArg).toContain(RELEASES_SYNTHETIC_SCAN_PAGE_SIZE);
    });
  });

  describe("assertVersionRestorable（三重守卫）", () => {
    const collab = () => new AppDeploymentReleaseView(makeDeps().deps);

    it("跨应用 → 拒绝", () => {
      expect(() =>
        collab().assertVersionRestorable("app-1", {
          applicationId: "app-2",
          version: "1.0.0",
          status: "released",
        }),
      ).toThrow();
    });

    it("无版本号 → 拒绝", () => {
      expect(() =>
        collab().assertVersionRestorable("app-1", {
          applicationId: "app-1",
          version: null,
          status: "released",
        }),
      ).toThrow();
    });

    it("未 released → 拒绝；三者全过 → 放行", () => {
      expect(() =>
        collab().assertVersionRestorable("app-1", {
          applicationId: "app-1",
          version: "1.0.0",
          status: "draft",
        }),
      ).toThrow();
      expect(() =>
        collab().assertVersionRestorable("app-1", {
          applicationId: "app-1",
          version: "1.0.0",
          status: "released",
        }),
      ).not.toThrow();
    });
  });

  describe("buildVersionRestoreDto", () => {
    it("快照键按白名单映射，且 version/runtime 恒有值", () => {
      const collab = new AppDeploymentReleaseView(makeDeps().deps);

      const dto = collab.buildVersionRestoreDto(
        { runtime: "python" },
        {
          version: "1.0.0",
          gitCommit: "abc",
          snapshot: {
            packageUrl: "s3://p",
            gitBranch: "main",
            entrypoint: "main.py",
            unknownKey: "should-not-leak",
          },
        },
      );

      expect(dto).toMatchObject({
        version: "1.0.0",
        runtime: "python",
        gitCommit: "abc",
        packageUrl: "s3://p",
        gitBranch: "main",
        entrypoint: "main.py",
      });
      expect(dto).not.toHaveProperty("unknownKey");
    });
  });

  describe("trigger 推导", () => {
    it("持久化 triggerType 优先；缺失回退 statusMessage 指纹推导", () => {
      const { deps } = makeDeps();
      const collab = new AppDeploymentReleaseView(deps);

      expect(
        asAny(collab).resolveReleaseTrigger(mkDeployment({ triggerType: "approval" })),
      ).toBe("approval");
      expect(
        asAny(collab).resolveReleaseTrigger(
          mkDeployment({
            triggerType: null,
            statusMessage: "Upgrade triggered: 1.0.0",
          }),
        ),
      ).toBe("upgrade");
      expect(
        asAny(collab).resolveReleaseTrigger(
          mkDeployment({ triggerType: null, statusMessage: null }),
        ),
      ).toBe("manual");
      expect(asAny(collab).resolveReleaseTrigger(null)).toBeNull();
    });
  });

  describe("buildReleaseDevices / buildRetainedButTruncated", () => {
    it("只列 current 命中或 retained 命中的设备", () => {
      const collab = new AppDeploymentReleaseView(makeDeps().deps);
      const facts = [
        {
          executorId: "e1",
          executorName: "a",
          currentVersion: "1.0.0",
          retainedVersions: ["1.0.0"],
          online: true,
          lastHeartbeat: null,
        },
        {
          executorId: "e2",
          executorName: "b",
          currentVersion: "2.0.0",
          retainedVersions: ["2.0.0"],
          online: true,
          lastHeartbeat: null,
        },
      ] as never;

      expect(asAny(collab).buildReleaseDevices("1.0.0", facts)).toHaveLength(1);
      expect(asAny(collab).buildReleaseDevices(null, facts)).toEqual([]);
    });

    it("差集只报「设备有保留但本页不可见」的版本号", () => {
      const collab = new AppDeploymentReleaseView(makeDeps().deps);
      const facts = [
        {
          executorId: "e1",
          executorName: "a",
          currentVersion: "9.9.9",
          retainedVersions: ["1.0.0", "9.9.9"],
          online: true,
          lastHeartbeat: null,
        },
      ] as never;
      const rows = [{ version: "1.0.0" }, { version: null }] as never;

      expect(asAny(collab).buildRetainedButTruncated(rows, facts)).toEqual(["9.9.9"]);
    });
  });

  describe("部署计数与 legacy 回退", () => {
    it("事件表可用 → 按事件聚合；事件表空 → 回退行计数", async () => {
      const { deps } = makeDeps();
      deps.deploymentEventRepo = {
        count: jest.fn().mockResolvedValue(2),
        createQueryBuilder: jest.fn(() => ({
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockReturnThis(),
          getRawMany: jest
            .fn()
            .mockResolvedValue([{ version: "1.0.0", count: "3" }]),
        })),
      } as never;
      const collab = new AppDeploymentReleaseView(deps);

      const map = await asAny(collab).buildDeployCountMap("app-1");
      expect(map.get("1.0.0")).toBe(3);
    });
  });

  describe("只读性不变量（变异测试锚点）", () => {
    it("跑遍全部读面后，repo/versionRepo **零写操作**（save/update/delete/insert 全 0）", async () => {
      const { deps, repo, versionRepo, writers } = makeDeps();
      versionRepo.find.mockResolvedValue([mkVersion()]);
      versionRepo.findAndCount.mockResolvedValue([[mkVersion()], 1]);
      repo.find.mockResolvedValue([mkDeployment()]);
      repo.findAndCount.mockResolvedValue([[mkDeployment()], 1]);
      deps.findAllByApp = jest.fn().mockResolvedValue([mkDeployment()]);
      const collab = new AppDeploymentReleaseView(deps);

      await collab.getVersionHistory("app-1");
      await collab.getReleases("app-1");
      await asAny(collab).buildDeployCountMap("app-1");
      await asAny(collab).getDeploymentVersionFallback("app-1");
      asAny(collab).buildReleaseDevices("1.0.0", [] as never);
      asAny(collab).buildRetainedButTruncated([], [] as never);
      collab.buildVersionRestoreDto({ runtime: "python" }, { version: "1.0.0" });
      asAny(collab).resolveReleaseTrigger(mkDeployment());
      asAny(collab).maskSnapshotForRead({ env: {} });

      // 结果面：读面全部走通（不是「因为没调用所以没写」）。
      expect(repo.find).toHaveBeenCalled();
      expect(versionRepo.find).toHaveBeenCalled();
      // 副作用面：**一次写都没有**。
      expect(writers.save).not.toHaveBeenCalled();
      expect(writers.update).not.toHaveBeenCalled();
      expect(writers.deleteFn).not.toHaveBeenCalled();
      expect(writers.insert).not.toHaveBeenCalled();
      expect(versionRepo.save).not.toHaveBeenCalled();
      expect(versionRepo.update).not.toHaveBeenCalled();
      expect(versionRepo.delete).not.toHaveBeenCalled();
    });

    it("协作者源码内不出现任何写 API / 事务（结构性钉子）", () => {
      const src = readFileSync(
        join(__dirname, "..", "app-deployment-release-view.collaborator.ts"),
        "utf-8",
      );
      // 去掉注释行后扫描（头注里会提到 save/update 等词作反例说明）。
      const code = src
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
        })
        .join("\n");
      for (const forbidden of [
        ".save(",
        ".update(",
        ".delete(",
        ".insert(",
        ".transaction(",
        ".query(",
      ]) {
        expect(code).not.toContain(forbidden);
      }
    });
  });

  describe("Facade 转发层不变量（变异测试锚点）", () => {
    it("Facade 保留同名转发方法且都指向 this.releaseView", () => {
      const svc = readFileSync(
        join(__dirname, "..", "app-deployment.service.ts"),
        "utf-8",
      );

      // ① 四个被外部/写面调用的成员都还有转发层，且指向同一个协作者实例。
      for (const m of [
        "getVersionHistory",
        "getReleases",
        "buildVersionRestoreDto",
        "assertVersionRestorable",
      ]) {
        expect(svc).toMatch(new RegExp(`this\\.releaseView\\.${m}\\(`));
      }
      // ② 只读簇的实现体不得再留在 Facade（否则搬了等于没搬）。
      expect(svc).not.toMatch(/this\.repo\.find\(\{[\s\S]{0,200}deployedVersion: In\(/);
    });

    it("常量从协作者 re-export（既有 spec 的 import 路径零改动）", () => {
      const svc = readFileSync(
        join(__dirname, "..", "app-deployment.service.ts"),
        "utf-8",
      );
      expect(svc).toMatch(
        /export \{[\s\S]*?RELEASES_DEFAULT_PAGE_SIZE[\s\S]*?\} from "\.\/app-deployment-release-view\.collaborator"/,
      );
      expect(svc).toMatch(
        /export \{[\s\S]*?releaseSortTimestampMs[\s\S]*?\} from "\.\/app-deployment-release-view\.collaborator"/,
      );
    });
  });
});
