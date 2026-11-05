/**
 * R76：**地址分类纯函数**的表驱动单测 + **对照断言**。
 *
 * ## 期望值的来源（这是本文件最要紧的设计）
 *
 * 期望值**逐字从契约读**：`packages/executor-protocol/protocol.json` 的
 * `networkPolicy.addresses.*.examples` 与 `networkPolicy.metadataAddresses.addresses`。
 * **不从实现反推**（不写「`100.64.0.1` 归 `restricted`」这种从 admin 段表抄来的
 * 期望）——否则段表一改，测试跟着改，永远绿。
 *
 * 但契约给的是**契约类别**（`loopback` / `privateIPv4` / `linkLocal` / `cgnat` /
 * `unspecified` / `multicast` / `reserved`），而 admin 侧用的是**粗标签**
 * （`private-lan` / `restricted` / …，ADR-033 §2.2 的既有归并）。⇒ 需要一张
 * **契约类别 → admin 粗标签**的映射表 —— 它是 admin 侧的**既有归并口径**
 * （不是实现细节，是 ADR 记录过的决策），在这里写死并注明出处。
 *
 * ## 三组断言
 *
 * ① **表驱动**：契约的每条示例地址 ⇒ 分类结果必须等于「契约类别经映射后的粗标签」；
 * ② **独立锚定**：契约的 `allowedUnderPrivateNetwork` 字段 ⇒ 该类别在 webhook
 *    面「开关开/关」下的放行结论（**期望值来自契约字段**，不从实现反推）；
 * ③ **对照断言**：同一地址走旧入口（`classifyAddressRisk` / `isMetadataAddress`）
 *    与纯函数，结论必须相同（证明**委托**无行为变化）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isIP } from "node:net";

import {
  addressRiskSegmentId,
  classifyAddressRisk,
  isMetadataAddress,
  SSRF_DENY_HOST_PATTERNS,
} from "../safe-http.util";
import {
  addressSegmentId,
  buildAddressCategoryTables,
  classifyAddress,
  classifyMetadataAddress,
  normalizeIpLiteral,
  type AddressCategory,
  type AddressCategoryTables,
} from "../address-category.util";

/** 契约文件（**唯一**地址与类别来源）。 */
const CONTRACT = "packages/executor-protocol/protocol.json";

const networkPolicy = (
  JSON.parse(
    readFileSync(resolve(__dirname, "../../../../../../", CONTRACT), "utf8"),
  ) as {
    networkPolicy: {
      addresses: Record<
        string,
        { examples?: string[]; allowedUnderPrivateNetwork?: boolean }
      >;
      metadataAddresses: { addresses: string[] };
    };
  }
).networkPolicy;

/**
 * 契约类别 → admin 粗标签（admin 侧的**既有归并口径**，出处 ADR-033 §2.2 /
 * ADR-034 §1.2）：
 *   · `privateIPv4` → `private-lan`；
 *   · `cgnat` 与 benchmark 同归 `restricted`（admin 的段表把两者合并）；
 *   · `unspecified` / `multicast` / `reserved` 三者在 admin 合并为 `reserved`；
 *   · `ipv4Mapped` 不是独立类别 —— 契约规定「**完全按内嵌 IPv4 判定**」。
 */
const CONTRACT_CLASS_TO_ADMIN_CATEGORY: Readonly<
  Record<string, AddressCategory>
> = {
  loopback: "loopback",
  privateIPv4: "private-lan",
  linkLocal: "link-local",
  cgnat: "restricted",
  unspecified: "reserved",
  multicast: "reserved",
  reserved: "reserved",
};

/** admin 侧的真实数据装进纯函数的入参。 */
const TABLES: AddressCategoryTables = {
  ipv4: SSRF_DENY_HOST_PATTERNS.ipv4 as never,
  ipv6: SSRF_DENY_HOST_PATTERNS.ipv6 as never,
  metadataAddresses: networkPolicy.metadataAddresses.addresses,
  isIP,
};

/** R78：装配函数现在**要求**调用方传入恒拒表（模块本身零 import）。 */
const BUILD = () =>
  buildAddressCategoryTables(isIP, networkPolicy.metadataAddresses.addresses);

describe("地址分类纯函数 · 表驱动（期望值逐字来自契约）", () => {
  it("契约的每条示例地址 ⇒ 分类结果 = 契约类别经映射后的 admin 粗标签", () => {
    const mismatches: string[] = [];
    for (const [cls, def] of Object.entries(networkPolicy.addresses)) {
      if (cls === "ipv4Mapped") continue; // 契约规定按内嵌 IPv4 判定，见下方专例
      const expected = CONTRACT_CLASS_TO_ADMIN_CATEGORY[cls];
      for (const example of def.examples ?? []) {
        // 主机名形态（localhost / foo.localhost）不是 IP 字面量 ⇒ 不进分类器
        if (isIP(example) === 0) continue;
        const got = classifyAddress(example, TABLES).category;
        if (got !== expected) {
          mismatches.push(`${cls} ${example}: 期望 ${expected}，实测 ${got}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("ipv4Mapped：契约规定「完全按内嵌 IPv4 判定」⇒ 分类 = 内嵌那一类", () => {
    const mapped = networkPolicy.addresses.ipv4Mapped?.examples ?? [];
    expect(mapped.length).toBeGreaterThan(0);
    for (const example of mapped) {
      const inner = example.slice(example.lastIndexOf(":") + 1);
      const expectedInner = classifyAddress(inner, TABLES).category;
      const got = classifyAddress(example, TABLES).category;
      // 内嵌是公网（8.8.8.8）时，映射形态按契约也应是 public
      expect([example, got]).toEqual([example, expectedInner]);
    }
  });

  it("契约恒拒表：每个成员都被认成 metadata（恒拒先于分类）", () => {
    for (const entry of networkPolicy.metadataAddresses.addresses) {
      const base = entry.split("/")[0];
      expect([base, classifyAddress(base, TABLES).metadata]).toEqual([
        base,
        true,
      ]);
      // admin 侧把元数据归 `reserved`（ADR-029 §7）
      expect(classifyAddress(base, TABLES).category).toBe("reserved");
    }
  });

  it("非 IP 字面量：分类为 null、metadata 为 false（不误判）", () => {
    for (const host of ["localhost", "foo.localhost", "example.com"]) {
      expect([host, classifyAddress(host, TABLES).category]).toEqual([
        host,
        null,
      ]);
      expect([host, classifyAddress(host, TABLES).metadata]).toEqual([
        host,
        false,
      ]);
    }
  });
});

describe("独立锚定：契约的 allowedUnderPrivateNetwork 字段 ⇒ webhook 面放行结论", () => {
  it("契约声明可被开关解锁的类别只有 privateIPv4；其余恒拒", () => {
    const unlockable = Object.entries(networkPolicy.addresses)
      .filter(([, def]) => def.allowedUnderPrivateNetwork === true)
      .map(([cls]) => cls);
    expect(unlockable).toEqual(["privateIPv4"]);
  });

  it("每个契约示例地址的放行结论 = f(契约类别的 allowedUnderPrivateNetwork)", () => {
    const mismatches: string[] = [];
    for (const [cls, def] of Object.entries(networkPolicy.addresses)) {
      if (cls === "ipv4Mapped") continue;
      const expected = def.allowedUnderPrivateNetwork === true;
      for (const example of def.examples ?? []) {
        if (isIP(example) === 0) continue;
        const category = classifyAddress(example, TABLES).category;
        const metadata = classifyAddress(example, TABLES).metadata;
        // 恒拒表优先
        const allowed =
          metadata || category === null
            ? category === null && !metadata
            : category === "public" || (category === "private-lan" && expected);
        if (allowed !== (expected || cls === "public")) {
          mismatches.push(
            `${cls} ${example}: 期望 ${expected}，实测 ${allowed}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("对照断言：旧入口 vs 纯函数必须同结论（R76 的核心证据）", () => {
  it("classifyAddressRisk 与 classifyAddress：逐地址一致", () => {
    const mismatches: string[] = [];
    for (const [, def] of Object.entries(networkPolicy.addresses)) {
      for (const example of def.examples ?? []) {
        const legacy = classifyAddressRisk(example);
        const pure = classifyAddress(example, TABLES).category;
        if (legacy !== pure) {
          mismatches.push(`${example}: 旧入口 ${legacy} / 纯函数 ${pure}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("isMetadataAddress 与 classifyMetadataAddress：逐地址一致", () => {
    const mismatches: string[] = [];
    const all = [
      ...Object.values(networkPolicy.addresses).flatMap(
        (d) => d.examples ?? [],
      ),
      ...networkPolicy.metadataAddresses.addresses.map((e) => e.split("/")[0]),
      "not-an-ip",
    ];
    for (const example of all) {
      const legacy = isMetadataAddress(example);
      const pure = classifyMetadataAddress(example, TABLES);
      if (legacy !== pure) {
        mismatches.push(`${example}: 旧入口 ${legacy} / 纯函数 ${pure}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("segmentId 下沉（R77）：对照断言 + 与类别判定同源", () => {
  it("addressRiskSegmentId（旧）与 addressSegmentId（纯）：逐地址一致", () => {
    const all = [
      ...Object.values(networkPolicy.addresses).flatMap(
        (d) => d.examples ?? [],
      ),
      ...networkPolicy.metadataAddresses.addresses.map((e) => e.split("/")[0]),
      "not-an-ip",
    ];
    const mismatches: string[] = [];
    for (const example of all) {
      const legacy = addressRiskSegmentId(example);
      const pure = addressSegmentId(example, TABLES);
      if (legacy !== pure) mismatches.push(`${example}: ${legacy} / ${pure}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("与 classifyAddress **同源**：有 segmentId ⇒ 类别与 classifyAddress 一致；无 ⇒ 类别是 public/null", () => {
    const all = Object.values(networkPolicy.addresses).flatMap(
      (d) => d.examples ?? [],
    );
    const mismatches: string[] = [];
    for (const example of all) {
      const id = addressSegmentId(example, TABLES);
      const cat = classifyAddress(example, TABLES).category;
      if (id !== null) {
        // 段 id 存在 ⇒ 该段的 risk 必须等于 classifyAddress 给出的类别
        const seg = [...TABLES.ipv4, ...TABLES.ipv6].find((x) => x.id === id);
        if (!seg || seg.risk !== cat) {
          mismatches.push(
            `${example}: id=${id} seg.risk=${seg?.risk} cat=${cat}`,
          );
        }
      } else if (cat !== "public" && cat !== null) {
        // 无段 id 却给出非 public 类别 ⇒ 只允许是恒拒表（归 reserved）那一类
        if (!classifyAddress(example, TABLES).metadata) {
          mismatches.push(`${example}: 无 segmentId 但类别 ${cat}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("独立锚定：段 id 的前缀必须与**归一化后**的地址族一致（ipv4Mapped 按契约折回内嵌）", () => {
    const all = Object.values(networkPolicy.addresses).flatMap(
      (d) => d.examples ?? [],
    );
    const mismatches: string[] = [];
    for (const example of all) {
      if (isIP(example) === 0) continue;
      const id = addressSegmentId(example, TABLES);
      if (id === null) continue;
      // 期望值来自**归一化后的地址**（契约 ipv4Mapped 明文规定「完全按内嵌
      // IPv4 判定」）⇒ `::ffff:10.0.0.1` 的段 id 以 `ipv4-` 开头是**正确**的。
      const normalized = normalizeIpLiteral(example, TABLES);
      const family = isIP(normalized) === 4 ? "ipv4-" : "ipv6-";
      if (!id.startsWith(family)) mismatches.push(`${example}: ${id}`);
    }
    expect(mismatches).toEqual([]);
  });
});

describe("装配点（R77）：buildAddressCategoryTables 与手装等价", () => {
  it("工厂装出的 tables 与手装的 tables 逐字段一致（防装配漂移）", () => {
    const built = BUILD();
    expect(built.ipv4).toBe(TABLES.ipv4);
    expect(built.ipv6).toBe(TABLES.ipv6);
    expect(built.metadataAddresses).toEqual(TABLES.metadataAddresses);
    expect(built.isIP).toBe(TABLES.isIP);
  });

  it("工厂装出的 tables 与契约恒拒表同源（期望来自契约，不从实现反推）", () => {
    const built = BUILD();
    expect(built.metadataAddresses).toEqual(
      networkPolicy.metadataAddresses.addresses,
    );
  });

  it("用工厂 tables 分类，结论与手装 tables 完全相同（≥4 地址 × 两态）", () => {
    const built = BUILD();
    const hosts = ["93.184.216.34", "10.0.0.5", "127.0.0.1", "100.64.0.1"];
    const mismatches: string[] = [];
    for (const host of hosts) {
      const a = classifyAddress(host, TABLES);
      const b = classifyAddress(host, built);
      if (a.category !== b.category || a.metadata !== b.metadata) {
        mismatches.push(
          `${host}: ${a.category}/${a.metadata} vs ${b.category}/${b.metadata}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });
});
