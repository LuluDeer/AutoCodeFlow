// posture-addresses: 25
/**
 * R68（meta 守卫 `check:posture-matrix-tables` 的 admin 端）：**姿态矩阵表驱动**。
 *
 * ## 这张表在证什么
 *
 * 契约 `networkPolicy` 规定了两件事：
 *   · `addresses.*.allowedUnderPrivateNetwork` —— 开关（`EXECUTOR_ALLOW_PRIVATE_NETWORK`）的
 *     **唯一**效果是放行 `privateIPv4`，其余类别在任何开关状态下都拒；
 *   · `metadataAddresses.addresses` —— 云元数据端点**任何 posture × 任何开关**都拒。
 *
 * 本表把契约里的**每一条示例地址**（25 条）逐条喂给 admin 的**真实闸层**
 * （`assertAndPinHttpUrl`，它同时承载 `policy: 'executor'` 与 `'webhook'` 两个姿态），
 * 断言「放行/拒绝」与契约逐条一致。
 *
 * ## 为什么地址**逐字从契约读**、不在本文件里写
 *
 * meta 守卫的判据 (c) 明令：表里不得出现契约地址的字面量副本 —— 写死一份就等于
 * 造「第二个事实源」，契约加了地址而这里没跟，表会静默变窄（守卫抓不到）。
 * 所以：**唯一来源是 `packages/executor-protocol/protocol.json`**，读取路径在
 * `CONTRACT` 常量里，条数由 `// posture-addresses: 25` 声明并被下面的用例反查。
 *
 * ## 与 R66 的关系
 *
 * R66 已把 admin 的 webhook 面拉齐到契约（开关只解锁 `private-lan`）。本表是那件事的
 * **端到端证据**：两个 posture 在同一张表上给出同一组结论。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lookup } from "node:dns/promises";

import { assertAndPinHttpUrl } from "./safe-http.util";

jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }));
const mockedLookup = lookup as unknown as jest.Mock<
  Promise<Array<{ address: string; family: number }>>
>;

/** 契约文件（**唯一**地址来源；本文件不写任何地址字面量）。 */
const CONTRACT = "packages/executor-protocol/protocol.json";

interface AddressClass {
  description?: string;
  examples?: string[];
  allowedUnderPrivateNetwork?: boolean;
}

const networkPolicy = (
  JSON.parse(
    readFileSync(resolve(__dirname, "../../../../../", CONTRACT), "utf8"),
  ) as {
    networkPolicy: {
      addresses: Record<string, AddressClass>;
      metadataAddresses: { addresses: string[] };
    };
  }
).networkPolicy;

const classes = networkPolicy.addresses;
/** 开关的「唯一效果」由契约自己声明；这里只按它求值。 */
const SWITCH_UNLOCKS_PRIVATE = true;

/** 云元数据端点（恒拒表）：去掉 `/32` 后缀，逐条与示例地址比较。 */
const metadataValues = networkPolicy.metadataAddresses.addresses.map(
  (a) => String(a).split("/")[0],
);

/** 供「主机名」形态使用的解析答案：**从契约里取**一个 IPv4 示例，不写字面量。 */
function firstIpv4Example(): string {
  for (const c of Object.values(classes)) {
    const hit = (c.examples ?? []).find((e) => /^\d+\.\d+\.\d+\.\d+$/.test(e));
    if (hit) return hit;
  }
  throw new Error("契约里没有任何 IPv4 示例 —— 判据面塌方");
}

/** 地址是否带 `:`（IPv6 形态在 URL 里必须加方括号）。 */
function toUrl(host: string): string {
  const h = host.includes(":") ? `[${host}]` : host;
  return `http://${h}/probe`;
}

/** 内嵌 IPv4：契约对 `ipv4Mapped` 的规定是「完全按内嵌 IPv4 判定」。 */
function embeddedIpv4(host: string): string | null {
  const idx = host.lastIndexOf(":");
  if (idx < 0) return null;
  const tail = host.slice(idx + 1);
  return /^\d+\.\d+\.\d+\.\d+$/.test(tail) ? tail : null;
}

/** 某个示例地址归属的契约类别（`ipv4Mapped` 折叠到内嵌那一类）。 */
function classOf(cls: string, host: string): AddressClass | null {
  if (cls !== "ipv4Mapped") return classes[cls] ?? null;
  const inner = embeddedIpv4(host);
  if (!inner) return null;
  for (const c of Object.values(classes)) {
    if ((c.examples ?? []).includes(inner)) return c;
  }
  return null; // 内嵌公网 ⇒ 不受限
}

/**
 * 契约期望值：`metadataAddresses` 恒拒 > 类别 `allowedUnderPrivateNetwork` >
 * 不属于任何类别（公网）⇒ 放行。
 *
 * 注意 `allowedUnderPrivateNetwork === true` ⇒ **默认拒、开关才放行**（这是契约的
 * 语义方向：那个字段是「开关能否解锁」，不是「默认是否放行」）。
 */
function contractAllows(
  cls: string,
  host: string,
  allowPrivate: boolean,
): boolean {
  if (metadataValues.includes(host)) return false;
  const owner = classOf(cls, host);
  if (owner === null) return true;
  const unlockable = owner.allowedUnderPrivateNetwork === true;
  return unlockable && SWITCH_UNLOCKS_PRIVATE && allowPrivate;
}

const cases: Array<readonly [string, string]> = Object.entries(classes).flatMap(
  ([clsName, cls]) => (cls.examples ?? []).map((ex) => [clsName, ex] as const),
);

describe("admin 姿态矩阵 · 契约逐条地址 × policy × 开关（R68）", () => {
  beforeEach(() => {
    mockedLookup.mockReset();
    // 主机名形态：解析答案取自契约（一个 IPv4 示例），不写字面量。
    const answer = firstIpv4Example();
    mockedLookup.mockResolvedValue([{ address: answer, family: 4 }]);
  });

  it("表里覆盖的地址条数与 `// posture-addresses` 声明一致（防表静默变窄）", () => {
    expect(cases).toHaveLength(25);
    expect(new Set(cases.map(([, h]) => h)).size).toBe(cases.length);
  });

  for (const policy of ["executor", "webhook"] as const) {
    for (const allowPrivate of [false, true]) {
      it(`policy=${policy} · 开关 ${allowPrivate ? "on" : "off"} · 25 条逐条符合契约`, async () => {
        const wrong: string[] = [];
        for (const [cls, host] of cases) {
          const expected = contractAllows(cls, host, allowPrivate);
          const actual = await assertAndPinHttpUrl(toUrl(host), {
            allowPrivateNetwork: allowPrivate,
            policy,
          }).then(
            () => true,
            () => false,
          );
          if (actual !== expected) {
            wrong.push(
              `${cls} ${host}: 契约为 ${expected ? "放行" : "拒"}，实测 ${actual ? "放行" : "拒"}`,
            );
          }
        }
        expect(wrong).toEqual([]);
      });
    }
  }

  it("恒拒表优先于开关：元数据端点两个 posture × 两档开关都拒（ADR-029）", async () => {
    for (const policy of ["executor", "webhook"] as const) {
      for (const allowPrivate of [false, true]) {
        for (const meta of metadataValues) {
          await expect(
            assertAndPinHttpUrl(toUrl(meta), {
              allowPrivateNetwork: allowPrivate,
              policy,
            }),
          ).rejects.toThrow();
        }
      }
    }
  });
});
