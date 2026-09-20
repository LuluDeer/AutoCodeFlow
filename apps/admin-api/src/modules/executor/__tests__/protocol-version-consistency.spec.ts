import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
  PROTOCOL_CONTROL_PLANE_MIN,
  PROTOCOL_SUPPORTED_MIN,
} from "../protocol-compat.util";

/**
 * PROTOCOL-VER 一致性闸（ARCH-33 / ADR-016 实施时补）。
 *
 * ## 缺口背景
 *
 * 在本次改动之前，`packages/executor-protocol/protocol.json` 的 `versioning`
 * 段**没有任何测试读过**——仓库里 grep `versioning` 在全部 spec / test 文件里
 * 零命中，它只出现在注释里。也就是说协议版本号由**四处手抄**维持：
 *
 *   1. protocol.json `versioning.currentProtocolVersion`
 *   2. executor-node  `src/config.ts`  `PROTOCOL_VERSION`
 *   3. executor-python `config.py`       `PROTOCOL_VERSION`
 *   4. admin-api      `protocol-compat.util.ts` 的两个下限常量
 *
 * 抄错任何一处都没有机器兜底。后果不是理论上的：中台按 `protocolVersion`
 * 决定是否下发 `commands`，执行器上报的数字与中台认的门槛一旦错位，就会
 * 出现「中台认为对方认识 commands，实际对方静默忽略」——正是 ADR-016 要用
 * 版本门禁消灭的那种静默丢命令。
 *
 * 本 spec 把四处钉在一起。它是 admin-api 侧最合适的位置：admin 是**消费**
 * 协议版本的一方（按上报值分支），且这里已经有 `PROTOCOL_SUPPORTED_MIN`。
 *
 * ## 为什么读文件而不是 import JSON
 *
 * 与 executor-node `protocol-schemas.spec.ts` 同款理由：admin-api 的 tsconfig
 * 会把 `resolveJsonModule` 的仓库外路径拉进编译图。此处按路径向上找仓库根，
 * 构建期不跨出 app 目录。
 */

const PROTOCOL_RELATIVE = path.join(
  "packages",
  "executor-protocol",
  "protocol.json",
);

function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, PROTOCOL_RELATIVE))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`executor-protocol/protocol.json not found above ${from}`);
}

const repoRoot = findRepoRoot(__dirname);
const protocol = JSON.parse(
  readFileSync(path.join(repoRoot, PROTOCOL_RELATIVE), "utf-8"),
);

/** 从源码里抠出 `export const PROTOCOL_VERSION = <n>;` 的数字。 */
function readTsProtocolVersion(relative: string): number {
  const source = readFileSync(path.join(repoRoot, relative), "utf-8");
  const match = /export const PROTOCOL_VERSION = (\d+);/.exec(source);
  if (!match) {
    throw new Error(`PROTOCOL_VERSION not found in ${relative}`);
  }
  return Number(match[1]);
}

/** 从源码里抠出 `PROTOCOL_VERSION = <n>` 的数字（python 无分号）。 */
function readPyProtocolVersion(relative: string): number {
  const source = readFileSync(path.join(repoRoot, relative), "utf-8");
  const match = /^PROTOCOL_VERSION = (\d+)$/m.exec(source);
  if (!match) {
    throw new Error(`PROTOCOL_VERSION not found in ${relative}`);
  }
  return Number(match[1]);
}

describe("PROTOCOL-VER 版本一致性（ARCH-33 补的守卫）", () => {
  it("protocol.json 的 versioning 段可读且形状正确（防扫描器静默失效）", () => {
    const versioning = protocol.versioning;
    expect(versioning).toBeDefined();
    expect(Number.isInteger(versioning.currentProtocolVersion)).toBe(true);
    expect(Number.isInteger(versioning.supportedMinProtocolVersion)).toBe(true);
    expect(Array.isArray(versioning.compatibilityMatrix)).toBe(true);
    expect(versioning.compatibilityMatrix.length).toBeGreaterThan(0);
  });

  it("admin 的 PROTOCOL_SUPPORTED_MIN === protocol.json supportedMinProtocolVersion", () => {
    expect(PROTOCOL_SUPPORTED_MIN).toBe(
      protocol.versioning.supportedMinProtocolVersion,
    );
  });

  it("两个执行器上报的 PROTOCOL_VERSION === protocol.json currentProtocolVersion", () => {
    // 这是本 spec 的核心：三端常量与协议单一事实源必须同值。
    const node = readTsProtocolVersion(
      path.join("apps", "executor-node", "src", "config.ts"),
    );
    const python = readPyProtocolVersion(
      path.join("apps", "executor-python", "config.py"),
    );
    const declared = protocol.versioning.currentProtocolVersion;

    expect(node).toBe(declared);
    expect(python).toBe(declared);
  });

  it("控制面门禁 PROTOCOL_CONTROL_PLANE_MIN 必须被 compatibilityMatrix 覆盖", () => {
    // 门禁值指向一个矩阵里不存在的协议版本 = 要么写错了数字，要么忘了登记
    // 该版本的语义（下一条断言进一步要求矩阵条目自洽）。
    const declaredVersions = protocol.versioning.compatibilityMatrix.map(
      (entry: { protocolVersion: number }) => entry.protocolVersion,
    );
    expect(declaredVersions).toContain(PROTOCOL_CONTROL_PLANE_MIN);
  });

  it("矩阵自洽：每个条目版本 <= current，且 current 条目存在并被两端实现", () => {
    const { currentProtocolVersion, supportedMinProtocolVersion } =
      protocol.versioning;
    const matrix = protocol.versioning.compatibilityMatrix as {
      protocolVersion: number;
      adminSupported: boolean;
      executorImplementedBy: string[];
    }[];

    for (const entry of matrix) {
      expect(entry.protocolVersion).toBeLessThanOrEqual(currentProtocolVersion);
      expect(entry.protocolVersion).toBeGreaterThanOrEqual(
        supportedMinProtocolVersion,
      );
      expect(entry.adminSupported).toBe(true);
    }

    // current 必须在矩阵里有条目——否则「当前协议」没有任何语义登记
    const current = matrix.find(
      (e) => e.protocolVersion === currentProtocolVersion,
    );
    expect(current).toBeDefined();
    // 且必须两端都实现（协议文件声称的能力，两端都得真有）
    expect([...current!.executorImplementedBy].sort()).toEqual([
      "executor-node",
      "executor-python",
    ]);
  });

  it("控制面版本的矩阵条目必须声明两端实现（门禁不空转）", () => {
    const entry = (
      protocol.versioning.compatibilityMatrix as {
        protocolVersion: number;
        executorImplementedBy: string[];
        $comment?: string;
      }[]
    ).find((e) => e.protocolVersion === PROTOCOL_CONTROL_PLANE_MIN);

    expect(entry).toBeDefined();
    expect(entry!.executorImplementedBy).toContain("executor-node");
    expect(entry!.executorImplementedBy).toContain("executor-python");
    // 该版本的语义必须在协议文件里有文字说明（防「加了条目没说是什么」）
    expect(entry!.$comment ?? "").toMatch(/commands|command-result/i);
  });

  it("兼容性红线：supportedMin 不得被抬到 control-plane 门禁（旧执行器照常注册）", () => {
    // ADR-016 的明确裁决：v1 执行器继续注册、继续收任务，只是收不到控制
    // 命令（admin 退回 push）。若有人把 supportedMin 也抬到 2，v1 执行器会
    // 被判不合规——虽然 isProtocolCompliant 只 warn 不拒，但那会让「协议不
    // 兼容」的告警对全部存量执行器刷屏，且语义上把「缺新能力」误报成
    // 「协议不兼容」。
    expect(PROTOCOL_SUPPORTED_MIN).toBeLessThan(PROTOCOL_CONTROL_PLANE_MIN);
  });
});
