/**
 * R74：**webhook 姿态纯函数**的表驱动单测 + **对照断言**。
 *
 * ## 为什么要有「对照断言」
 *
 * 本次抽出的纯函数（`outbound-posture.util.ts`）是**新代码**，`safe-http.util.ts`
 * 改为委托它。若委托写错，旧的 spec **可能仍然全绿**（它们只断言「某地址被拒」，
 * 不断言「被拒的**理由**与判定路径没变」）。⇒ 这里加一条**对照**断言：
 * **同一个地址、同一个开关态**，既走旧入口（`assertAndPinHttpUrl` /
 * `assertSafeHttpUrl`），又走纯函数（`evaluateOutboundPosture`），
 * **结论必须完全相同**（放行/拒绝 + 类别）。
 *
 * 这条断言是「抽出即不改行为」的可执行证据，也是**反向验证**的抓手
 * （把纯函数里某类判定改宽松 ⇒ 对照必然红）。
 */
import { lookup } from "node:dns/promises";

import {
  assertAndPinHttpUrl,
  assertSafeHttpUrl,
  classifyAddressRisk,
  isMetadataAddress,
} from "../safe-http.util";
import {
  evaluateOutboundPosture,
  type OutboundRisk,
} from "../outbound-posture.util";

jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }));
const mockedLookup = lookup as unknown as jest.Mock<
  Promise<Array<{ address: string; family: number }>>
>;

/** IPv6 字面量在 URL 里必须带方括号（`new URL` 的硬要求）。 */
const toUrl = (host: string): string =>
  `http://${host.includes(":") ? `[${host}]` : host}/hook`;

/**
 * 代表性地址：每个风险类别各一个（类别由 `classifyAddressRisk` 给出，
 * 本文件**不**写死类别名，而是从地址实测 ⇒ 契约改了类别归属，这里自动跟随）。
 */
const REPRESENTATIVE_HOSTS = [
  "93.184.216.34", // 公网
  "10.0.0.5", // RFC1918 私网
  "127.0.0.1", // 环回
  "169.254.1.1", // 链路本地
  "100.64.0.1", // CGNAT
  "0.0.0.0", // 未指定
  "224.0.0.1", // 组播
  "240.0.0.1", // 保留段
];

describe("evaluateOutboundPosture（R74 抽出的纯函数）", () => {
  beforeEach(() => {
    mockedLookup.mockReset();
    mockedLookup.mockResolvedValue([]);
  });

  it("纯函数本身：公网放行、私网仅开关开启时放行、其余类别恒拒", () => {
    const pub = evaluateOutboundPosture({
      risk: "public",
      metadata: false,
      allowPrivateNetwork: false,
      posture: "webhook",
    });
    expect(pub).toMatchObject({ allowed: true, reason: "public" });

    const privOff = evaluateOutboundPosture({
      risk: "private-lan",
      metadata: false,
      allowPrivateNetwork: false,
      posture: "webhook",
    });
    expect(privOff).toMatchObject({ allowed: false, reason: "category_denied" });

    const privOn = evaluateOutboundPosture({
      risk: "private-lan",
      metadata: false,
      allowPrivateNetwork: true,
      posture: "webhook",
    });
    expect(privOn).toMatchObject({ allowed: true, reason: "private_allowed" });

    for (const risk of [
      "loopback",
      "link-local",
      "restricted",
      "reserved",
    ] as OutboundRisk[]) {
      for (const allowPrivateNetwork of [false, true]) {
        const out = evaluateOutboundPosture({
          risk,
          metadata: false,
          allowPrivateNetwork,
          posture: "webhook",
        });
        expect([risk, allowPrivateNetwork, out.allowed]).toEqual([
          risk,
          allowPrivateNetwork,
          false,
        ]);
      }
    }
  });

  it("恒拒表先于分类：metadata 命中时任何开关态都拒，理由是 metadata", () => {
    for (const allowPrivateNetwork of [false, true]) {
      const out = evaluateOutboundPosture({
        risk: "public",
        metadata: true,
        allowPrivateNetwork,
        posture: "webhook",
      });
      expect(out.allowed).toBe(false);
      expect(out.reason).toBe("metadata");
    }
  });
});

/**
 * **独立锚定**：断言纯函数的结论**本身**符合契约，而不是「与旧入口一致」。
 *
 * ## 为什么必须有这条（委托式的盲区）
 *
 * `safe-http.util.ts` 现在**委托**给纯函数 ⇒ 一旦把纯函数改宽松，**旧入口也
 * 一起变宽松** ⇒ 「对照断言」（旧 vs 纯函数）**仍然一致** ⇒ 对照断言**不会红**。
 * 本轮实测正是如此：把 loopback 改宽松后，对照三条仍绿，只有「纯函数本身」
 * 那条红。
 *
 * ⇒ 对照断言证明的是「**委托没改行为**」（抽出即等价），而**不能**证明
 * 「结论符合契约」。后者要由这条**独立锚定**断言承担：它把期望值**写死**
 * （来自契约 `networkPolicy.switch.semantics`），不依赖任何被测实现。
 */
describe("独立锚定：纯函数的结论必须符合契约（不依赖被测实现）", () => {
  it("契约口径：public 恒放行；private-lan 仅开关开时放行；其余五类恒拒", () => {
    const CONTRACT: ReadonlyArray<
      readonly [risk: OutboundRisk, allowedOff: boolean, allowedOn: boolean]
    > = [
      ["public", true, true],
      ["private-lan", false, true],
      ["loopback", false, false],
      ["link-local", false, false],
      ["restricted", false, false],
      ["reserved", false, false],
    ];
    for (const [risk, allowedOff, allowedOn] of CONTRACT) {
      for (const [allowPrivateNetwork, expected] of [
        [false, allowedOff],
        [true, allowedOn],
      ] as const) {
        const out = evaluateOutboundPosture({
          risk,
          metadata: false,
          allowPrivateNetwork,
          posture: "webhook",
        });
        expect([risk, allowPrivateNetwork, out.allowed]).toEqual([
          risk,
          allowPrivateNetwork,
          expected,
        ]);
      }
    }
  });

  it("旧入口也必须符合同一张契约表（委托后不能被纯函数的改动带偏）", async () => {
    const CONTRACT: ReadonlyArray<
      readonly [host: string, allowedOff: boolean, allowedOn: boolean]
    > = [
      ["93.184.216.34", true, true],
      ["10.0.0.5", false, true],
      ["127.0.0.1", false, false],
      ["169.254.1.1", false, false],
      ["100.64.0.1", false, false],
      ["0.0.0.0", false, false],
      ["224.0.0.1", false, false],
      ["240.0.0.1", false, false],
    ];
    for (const [host, allowedOff, allowedOn] of CONTRACT) {
      for (const [allowPrivateNetwork, expected] of [
        [false, allowedOff],
        [true, allowedOn],
      ] as const) {
        let legacyAllowed = true;
        try {
          await assertAndPinHttpUrl(toUrl(host), {
            allowPrivateNetwork,
            policy: "webhook",
          });
        } catch {
          legacyAllowed = false;
        }
        expect([host, allowPrivateNetwork, legacyAllowed]).toEqual([
          host,
          allowPrivateNetwork,
          expected,
        ]);
      }
    }
  });
});

describe("对照断言：旧入口 vs 纯函数必须同结论（R74 的核心证据）", () => {
  beforeEach(() => {
    mockedLookup.mockReset();
    mockedLookup.mockResolvedValue([]);
  });

  it("assertAndPinHttpUrl(webhook) 与纯函数：逐地址 × 开关两态", async () => {
    const mismatches: string[] = [];
    for (const host of REPRESENTATIVE_HOSTS) {
      for (const allowPrivateNetwork of [false, true]) {
        const risk = classifyAddressRisk(host);
        const pure = evaluateOutboundPosture({
          risk,
          metadata: isMetadataAddress(host),
          allowPrivateNetwork,
          posture: "webhook",
        });
        let legacyAllowed = true;
        try {
          await assertAndPinHttpUrl(toUrl(host), {
            allowPrivateNetwork,
            policy: "webhook",
          });
        } catch {
          legacyAllowed = false;
        }
        if (legacyAllowed !== pure.allowed) {
          mismatches.push(
            `${host} @${allowPrivateNetwork ? "on" : "off"}: 旧入口 ${
              legacyAllowed ? "放行" : "拒"
            } / 纯函数 ${pure.allowed ? "放行" : "拒"}`,
          );
        }
        // 类别也要一致（旧入口不暴露类别 ⇒ 用 classifyAddressRisk 侧对照）
        if (pure.allowed && risk !== null && pure.risk !== risk) {
          mismatches.push(
            `${host}: 纯函数返回类别 ${pure.risk}，实测类别 ${risk}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("assertSafeHttpUrl 与纯函数：逐地址 × 开关两态", async () => {
    const mismatches: string[] = [];
    for (const host of REPRESENTATIVE_HOSTS) {
      for (const allowPrivateNetwork of [false, true]) {
        const risk = classifyAddressRisk(host);
        const pure = evaluateOutboundPosture({
          risk,
          metadata: isMetadataAddress(host),
          allowPrivateNetwork,
          posture: "webhook",
        });
        let legacyAllowed = true;
        try {
          await assertSafeHttpUrl(toUrl(host), { allowPrivateNetwork });
        } catch {
          legacyAllowed = false;
        }
        if (legacyAllowed !== pure.allowed) {
          mismatches.push(
            `${host} @${allowPrivateNetwork ? "on" : "off"}: 旧入口 ${
              legacyAllowed ? "放行" : "拒"
            } / 纯函数 ${pure.allowed ? "放行" : "拒"}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("executor 姿态同样与纯函数同结论（纯函数的 posture 参数不是摆设）", async () => {
    const mismatches: string[] = [];
    for (const host of REPRESENTATIVE_HOSTS) {
      for (const allowPrivateNetwork of [false, true]) {
        const risk = classifyAddressRisk(host);
        const pure = evaluateOutboundPosture({
          risk,
          metadata: isMetadataAddress(host),
          allowPrivateNetwork,
          posture: "executor",
        });
        let legacyAllowed = true;
        try {
          await assertAndPinHttpUrl(toUrl(host), {
            allowPrivateNetwork,
            policy: "executor",
          });
        } catch {
          legacyAllowed = false;
        }
        if (legacyAllowed !== pure.allowed) {
          mismatches.push(`${host} @${allowPrivateNetwork}: 结论不同`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
