/**
 * ARCH-35 P1：`executor-deployment-affinity.util.ts` 单测。
 *
 * 覆盖重点（按风险排序）：
 *  1. **稳定分区**：命中前置但组内保序——这是「不影响负载择优」的唯一保证；
 *  2. **零行为变化**：无部署 / 无 running / 单候选 → 原序，调用方无从感知；
 *  3. **匹配语义**：id 优先、address 兜底、id 命中不重复计 address；
 *  4. **状态过滤**：只有 running 计入（pending/stopped/failed 不得吸附任务）；
 *  5. **健壮性**：空值、空白串、重复部署行、同一台多条部署。
 */

import {
  collectDeploymentExecutorKeys,
  DEPLOYMENT_CONSTRAINT_STATUSES,
  DEPLOYMENT_STATUS_RUNNING,
  partitionByDeploymentAffinity,
  pickDeploymentVersionForExecutor,
  type DeploymentAffinityCandidate,
} from "../executor-deployment-affinity.util";

/** 造候选：地址与 id 由同一序号派生，便于断言顺序。 */
const cand = (n: number): DeploymentAffinityCandidate => ({
  id: `id-${n}`,
  address: `10.0.0.${n}:8002`,
});

/** 造部署行。 */
const dep = (
  executorId: string | null,
  executorAddress: string | null,
  status: string | null = DEPLOYMENT_STATUS_RUNNING,
) => ({ executorId, executorAddress, status });

const addressesOf = (r: { ordered: DeploymentAffinityCandidate[] }): string[] =>
  r.ordered.map((c) => c.address);

describe("partitionByDeploymentAffinity（ARCH-35 部署归属偏好）", () => {
  describe("稳定分区（核心不变量）", () => {
    it("命中的候选前置，组内严格保持入参顺序", () => {
      // 入参 = 评分升序：1 最优、3 最差；部署在 3 上。
      const result = partitionByDeploymentAffinity(
        [cand(1), cand(2), cand(3)],
        [dep("id-3", "10.0.0.3:8002")],
      );
      // 3 前置，1、2 保序在后。
      expect(addressesOf(result)).toEqual([
        "10.0.0.3:8002",
        "10.0.0.1:8002",
        "10.0.0.2:8002",
      ]);
      expect(result.preferredCount).toBe(1);
    });

    it("多个命中时，命中组内也保持入参相对顺序（不重排、不排序）", () => {
      // 部署在 2、4 上；入参顺序 1,2,3,4 → 期望 2,4,1,3。
      const result = partitionByDeploymentAffinity(
        [cand(1), cand(2), cand(3), cand(4)],
        [dep("id-4", null), dep("id-2", null)],
      );
      expect(addressesOf(result)).toEqual([
        "10.0.0.2:8002",
        "10.0.0.4:8002",
        "10.0.0.1:8002",
        "10.0.0.3:8002",
      ]);
      expect(result.preferredCount).toBe(2);
    });

    it("部署命中的恰是评分最优者时，顺序完全不变（前置是幂等的）", () => {
      const result = partitionByDeploymentAffinity(
        [cand(1), cand(2), cand(3)],
        [dep("id-1", "10.0.0.1:8002")],
      );
      expect(addressesOf(result)).toEqual([
        "10.0.0.1:8002",
        "10.0.0.2:8002",
        "10.0.0.3:8002",
      ]);
      expect(result.preferredCount).toBe(1);
    });

    it("全部命中时顺序不变，且计数等于候选数", () => {
      const result = partitionByDeploymentAffinity(
        [cand(1), cand(2)],
        [dep("id-1", null), dep("id-2", null)],
      );
      expect(addressesOf(result)).toEqual(["10.0.0.1:8002", "10.0.0.2:8002"]);
      expect(result.preferredCount).toBe(2);
      expect(result.matchedByExecutorId).toBe(2);
    });

    it("返回新数组，不修改入参（调用方可能复用 all）", () => {
      const candidates = [cand(1), cand(2)];
      const snapshot = [...candidates];
      const result = partitionByDeploymentAffinity(candidates, [
        dep("id-2", null),
      ]);
      expect(candidates).toEqual(snapshot);
      expect(result.ordered).not.toBe(candidates);
    });
  });

  describe("零行为变化（回退面）", () => {
    it("无部署行 → 原序，preferredCount=0", () => {
      const result = partitionByDeploymentAffinity(
        [cand(1), cand(2), cand(3)],
        [],
      );
      expect(addressesOf(result)).toEqual([
        "10.0.0.1:8002",
        "10.0.0.2:8002",
        "10.0.0.3:8002",
      ]);
      expect(result.preferredCount).toBe(0);
      expect(result.runningDeployments).toBe(0);
    });

    it("部署行全部非 running → 原序（不得吸附任务）", () => {
      const result = partitionByDeploymentAffinity(
        [cand(1), cand(2)],
        [
          dep("id-2", "10.0.0.2:8002", "pending"),
          dep("id-2", "10.0.0.2:8002", "deploying"),
          dep("id-2", "10.0.0.2:8002", "stopped"),
          dep("id-2", "10.0.0.2:8002", "failed"),
        ],
      );
      expect(addressesOf(result)).toEqual(["10.0.0.1:8002", "10.0.0.2:8002"]);
      expect(result.preferredCount).toBe(0);
      expect(result.runningDeployments).toBe(0);
    });

    it("混合状态时只有 running 生效", () => {
      const result = partitionByDeploymentAffinity(
        [cand(1), cand(2)],
        [
          dep("id-2", null, "failed"), // 不算
          dep("id-1", null, DEPLOYMENT_STATUS_RUNNING), // 算
        ],
      );
      expect(addressesOf(result)).toEqual(["10.0.0.1:8002", "10.0.0.2:8002"]);
      expect(result.runningDeployments).toBe(1);
    });

    it("候选 ≤1 时直接原序（分区无意义）", () => {
      const single = partitionByDeploymentAffinity(
        [cand(1)],
        [dep("id-1", null)],
      );
      expect(addressesOf(single)).toEqual(["10.0.0.1:8002"]);
      expect(single.preferredCount).toBe(0);

      const empty = partitionByDeploymentAffinity([], [dep("id-1", null)]);
      expect(empty.ordered).toEqual([]);
      expect(empty.preferredCount).toBe(0);
    });

    it("部署行存在但无一命中候选 → 原序", () => {
      const result = partitionByDeploymentAffinity(
        [cand(1), cand(2)],
        [dep("id-99", "10.0.0.99:8002")],
      );
      expect(addressesOf(result)).toEqual(["10.0.0.1:8002", "10.0.0.2:8002"]);
      expect(result.preferredCount).toBe(0);
      expect(result.runningDeployments).toBe(1);
    });
  });

  describe("匹配语义：id 优先、address 兜底", () => {
    it("executorId 命中（address 不同）也判归属——抗地址漂移", () => {
      const result = partitionByDeploymentAffinity(
        [cand(1), cand(2)],
        [dep("id-2", "10.9.9.9:8002")], // 地址已变，id 不变
      );
      expect(addressesOf(result)).toEqual(["10.0.0.2:8002", "10.0.0.1:8002"]);
      expect(result.matchedByExecutorId).toBe(1);
      expect(result.matchedByAddressOnly).toBe(0);
    });

    it("executorId 为空（存量行）时按 address 命中", () => {
      const result = partitionByDeploymentAffinity(
        [cand(1), cand(2)],
        [dep(null, "10.0.0.2:8002")],
      );
      expect(addressesOf(result)).toEqual(["10.0.0.2:8002", "10.0.0.1:8002"]);
      expect(result.matchedByAddressOnly).toBe(1);
      expect(result.matchedByExecutorId).toBe(0);
    });

    it("id 命中时不再重复计 address（两个计数互斥，合计=preferredCount）", () => {
      const result = partitionByDeploymentAffinity(
        [cand(1), cand(2), cand(3)],
        [dep("id-2", "10.0.0.2:8002")], // 同一台，id 与 address 都对
      );
      expect(result.matchedByExecutorId).toBe(1);
      expect(result.matchedByAddressOnly).toBe(0);
      expect(result.matchedByExecutorId + result.matchedByAddressOnly).toBe(
        result.preferredCount,
      );
    });

    it("同一台执行器有多条部署行时只前置一次（不重复入列）", () => {
      const result = partitionByDeploymentAffinity(
        [cand(1), cand(2)],
        [dep("id-2", "10.0.0.2:8002"), dep("id-2", "10.0.0.2:8002")],
      );
      expect(addressesOf(result)).toEqual(["10.0.0.2:8002", "10.0.0.1:8002"]);
      expect(result.preferredCount).toBe(1);
      expect(result.runningDeployments).toBe(2);
    });

    it("id 与 address 分别命中不同候选时，两台都前置", () => {
      const result = partitionByDeploymentAffinity(
        [cand(1), cand(2), cand(3)],
        [dep("id-3", null), dep(null, "10.0.0.2:8002")],
      );
      expect(addressesOf(result)).toEqual([
        "10.0.0.2:8002",
        "10.0.0.3:8002",
        "10.0.0.1:8002",
      ]);
      expect(result.matchedByExecutorId).toBe(1);
      expect(result.matchedByAddressOnly).toBe(1);
    });
  });

  describe("健壮性：脏数据不得制造误命中", () => {
    it("空白串 id/address 不参与匹配", () => {
      const result = partitionByDeploymentAffinity(
        [cand(1), cand(2)],
        [dep("   ", "   ")],
      );
      expect(result.preferredCount).toBe(0);
      expect(result.runningDeployments).toBe(1);
    });

    it("候选 address 为空串时不会被空串部署行误命中", () => {
      const result = partitionByDeploymentAffinity(
        [{ id: "id-1", address: "" }],
        [dep(null, "")],
      );
      expect(result.preferredCount).toBe(0);
    });

    it("id/address 两端空白被 trim 后仍能命中", () => {
      const result = partitionByDeploymentAffinity(
        [cand(1), cand(2)],
        [dep("  id-2  ", "  10.0.0.2:8002  ")],
      );
      expect(result.preferredCount).toBe(1);
      expect(result.ordered[0].address).toBe("10.0.0.2:8002");
    });

    it("status 为 null/undefined 的部署行不计入（不吸附）", () => {
      const result = partitionByDeploymentAffinity(
        [cand(1), cand(2)],
        [
          { executorId: "id-2", executorAddress: null, status: null },
          { executorId: "id-2", executorAddress: null },
        ],
      );
      expect(result.preferredCount).toBe(0);
      expect(result.runningDeployments).toBe(0);
    });

    it("status 大小写敏感：'RUNNING' 不等于 'running'（枚举值即小写）", () => {
      const result = partitionByDeploymentAffinity(
        [cand(1), cand(2)],
        [dep("id-2", null, "RUNNING")],
      );
      expect(result.preferredCount).toBe(0);
    });
  });

  describe("降级语义（调用方按序占坑的契约）", () => {
    it("前置组永远非空且与候选集同元素——调用方逐个占坑必然覆盖全机队", () => {
      const candidates = [cand(1), cand(2), cand(3)];
      const result = partitionByDeploymentAffinity(candidates, [
        dep("id-3", null),
      ]);
      // 元素集合与候选集完全一致（只是顺序变化）——这是「偏好而非过滤」的
      // 形式化保证：部署那台满了/离线了，后面仍有全机队可试。
      expect(
        [...result.ordered].sort((a, b) => a.id.localeCompare(b.id)),
      ).toEqual([...candidates].sort((a, b) => a.id.localeCompare(b.id)));
      expect(result.ordered).toHaveLength(candidates.length);
    });
  });
});

/**
 * FEAT-22 方案 A v1：`collectDeploymentExecutorKeys`（strict 约束的键提取）。
 *
 * 覆盖重点：与分区函数同源的收集语义（trim / 去空白 / 去重 / 双键并存）、
 * 以及「id 与 address 同时可用」的存量混合口径——SQL 直查的 OR 匹配正确性
 * 依赖这两点。
 */
describe("collectDeploymentExecutorKeys（FEAT-22 strict 集合键提取）", () => {
  it("收集非空 id 与 address，各自去重", () => {
    const keys = collectDeploymentExecutorKeys([
      dep("id-1", "10.0.0.1:8002"),
      dep("id-1", "10.0.0.1:8002"), // 同一台的多条部署行（once + scheduled）
      dep("id-2", "10.0.0.2:8002"),
    ]);
    expect(keys.ids).toEqual(["id-1", "id-2"]);
    expect(keys.addresses).toEqual(["10.0.0.1:8002", "10.0.0.2:8002"]);
  });

  it("空白串与 null/undefined 一律跳过（与分区函数的 trim 语义一致）", () => {
    const keys = collectDeploymentExecutorKeys([
      dep("  id-1  ", "  10.0.0.1:8002  "),
      dep("   ", null),
      dep(null, ""),
      dep(undefined, undefined),
      {},
    ]);
    expect(keys.ids).toEqual(["id-1"]);
    expect(keys.addresses).toEqual(["10.0.0.1:8002"]);
  });

  it("全空输入返回双空数组（调用方据此直接返回空候选池）", () => {
    expect(collectDeploymentExecutorKeys([])).toEqual({
      ids: [],
      addresses: [],
    });
  });

  it("id 与 address 双键并存：同一台设备以两种键出现时各自收集（SQL OR 匹配）", () => {
    // 存量行 executorId 为空只有 address；新行有 id——两行可能指向同一台，
    // 也可能指向不同台。本函数不判断归属（纯收集），由调用方 SQL 的
    // `id IN OR address IN` + 按 id 去重兜底。
    const keys = collectDeploymentExecutorKeys([
      dep(null, "10.0.0.9:8002"),
      dep("id-1", "10.0.0.1:8002"),
    ]);
    expect(keys.ids).toEqual(["id-1"]);
    expect(keys.addresses).toEqual(["10.0.0.9:8002", "10.0.0.1:8002"]);
  });

  it("strict 口径常量：stopped 必须计入（once 跑完即 stopped，本特性的触发场景）", () => {
    expect(DEPLOYMENT_CONSTRAINT_STATUSES).toContain("stopped");
    expect(DEPLOYMENT_CONSTRAINT_STATUSES).toContain("upgrading");
    expect(DEPLOYMENT_CONSTRAINT_STATUSES).toContain("running");
    // failed / pending / deploying 不计入——部署失败与在途未确认不构成
    // 「用户显式指定过设备」（宁可从严；解除出口是删除部署行）。
    expect(DEPLOYMENT_CONSTRAINT_STATUSES).not.toContain("failed");
    expect(DEPLOYMENT_CONSTRAINT_STATUSES).not.toContain("pending");
    expect(DEPLOYMENT_CONSTRAINT_STATUSES).not.toContain("deploying");
  });
});

/**
 * FEAT-22 方案 B：`pickDeploymentVersionForExecutor`（版本跟随的行选择）。
 *
 * 覆盖重点：id/address 双口径匹配、running 优先于 stopped、deployedAt 时序
 * 兜底、legacy 无版本行的跳过、未命中设备返回 null（跑当前版）。
 */
describe("pickDeploymentVersionForExecutor（FEAT-22 方案 B 版本跟随）", () => {
  const exec = (id: string, address: string): DeploymentAffinityCandidate => ({
    id,
    address,
  });

  it("按 executorId 命中，返回部署行的版本", () => {
    expect(
      pickDeploymentVersionForExecutor(
        [
          {
            executorId: "e-1",
            executorAddress: null,
            status: "running",
            deployedVersion: "1.2.0",
          },
        ],
        exec("e-1", "10.0.0.1:8002"),
      ),
    ).toBe("1.2.0");
  });

  it("legacy 行无 executorId 时按 address 兜底命中", () => {
    expect(
      pickDeploymentVersionForExecutor(
        [
          {
            executorId: null,
            executorAddress: "10.0.0.1:8002",
            status: "running",
            deployedVersion: "0.9.0",
          },
        ],
        exec("e-1", "10.0.0.1:8002"),
      ),
    ).toBe("0.9.0");
  });

  it("同设备多行：running 行优先于 stopped 行（once + scheduled 并存）", () => {
    const version = pickDeploymentVersionForExecutor(
      [
        {
          executorId: "e-1",
          executorAddress: "a1",
          status: "stopped",
          deployedVersion: "1.0.0",
        },
        {
          executorId: "e-1",
          executorAddress: "a1",
          status: "running",
          deployedVersion: "2.0.0",
        },
      ],
      exec("e-1", "a1"),
    );
    expect(version).toBe("2.0.0");
  });

  it("全部 stopped（once 跑完）：仍取版本——strict 指定机器 + 指定版本闭环", () => {
    const version = pickDeploymentVersionForExecutor(
      [
        {
          executorId: "e-1",
          executorAddress: "a1",
          status: "stopped",
          deployedVersion: "1.0.0",
        },
      ],
      exec("e-1", "a1"),
    );
    expect(version).toBe("1.0.0");
  });

  it("同状态并列取 deployedAt 最新", () => {
    const version = pickDeploymentVersionForExecutor(
      [
        {
          executorId: "e-1",
          executorAddress: "a1",
          status: "running",
          deployedVersion: "1.0.0",
          deployedAt: "2026-09-30T10:00:00Z",
        },
        {
          executorId: "e-1",
          executorAddress: "a1",
          status: "running",
          deployedVersion: "3.0.0",
          deployedAt: "2026-09-30T12:00:00Z",
        },
      ],
      exec("e-1", "a1"),
    );
    expect(version).toBe("3.0.0");
  });

  it("deployedAt 缺失视为最旧（Date 对象与 ISO 字符串均可解析）", () => {
    const version = pickDeploymentVersionForExecutor(
      [
        {
          executorId: "e-1",
          executorAddress: "a1",
          status: "running",
          deployedVersion: "1.0.0",
          deployedAt: new Date("2026-09-30T08:00:00Z"),
        },
        {
          executorId: "e-1",
          executorAddress: "a1",
          status: "running",
          deployedVersion: "2.0.0",
          deployedAt: undefined,
        },
      ],
      exec("e-1", "a1"),
    );
    expect(version).toBe("1.0.0");
  });

  it("命中行全部无版本（legacy null）→ 返回 null（调用方回退当前版）", () => {
    expect(
      pickDeploymentVersionForExecutor(
        [
          {
            executorId: "e-1",
            executorAddress: "a1",
            status: "running",
            deployedVersion: null,
          },
        ],
        exec("e-1", "a1"),
      ),
    ).toBeNull();
  });

  it("设备未命中任何部署行 → 返回 null（prefer 降级到非部署设备跑当前版）", () => {
    expect(
      pickDeploymentVersionForExecutor(
        [
          {
            executorId: "e-2",
            executorAddress: "a2",
            status: "running",
            deployedVersion: "1.0.0",
          },
        ],
        exec("e-1", "a1"),
      ),
    ).toBeNull();
  });

  it("空白版本串视为无版本", () => {
    expect(
      pickDeploymentVersionForExecutor(
        [
          {
            executorId: "e-1",
            executorAddress: "a1",
            status: "running",
            deployedVersion: "   ",
          },
        ],
        exec("e-1", "a1"),
      ),
    ).toBeNull();
  });
});
