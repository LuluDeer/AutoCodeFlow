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
import { lookup } from "node:dns/promises";
// R89：类别 → admin 粗标签的映射来自契约生成物（单一事实源）。
import { END_LABELS_ADMIN } from "../../../generated/protocol-categories";

// R80：DNS 替身 —— 让测试能**注入**解析结果（旁路成立的环境 = 解析到公网）。
jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }));
const mockedLookup = lookup as unknown as jest.Mock<
  Promise<Array<{ address: string; family: number }>>
>;

import {
  addressRiskSegmentId,
  assertAndPinHttpUrl,
  assertSafeExecutorUrl,
  assertSafeGitRepoUrl,
  assertSafeHttpUrl,
  classifyAddressRisk,
  isMetadataAddress,
  SSRF_DENY_HOST_PATTERNS,
} from "../safe-http.util";
import {
  addressSegmentId,
  buildAddressCategoryTables,
  withAdminLabels,
  classifyAddress,
  isLoopbackHostname,
  normalizeHostname,
  classifyMetadataAddress,
  normalizeIpLiteral,
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
      /** R93：类别 → admin 标签的**权威来源**（本文件的期望值从这里读，不再手抄）。 */
      categories: {
        order: string[];
        allowedUnderPrivateNetwork: string[];
        endLabels: { admin: Record<string, string> };
      };
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
/**
 * 契约类别 → admin 标签。
 *
 * R93（ADR-034 遗留清扫）：此前本文件**手抄**了一份映射（`unspecified: "reserved"` 等），
 * 那是契约 `categories.endLabels.admin` 的**第二份真理** —— R91 拆细标签时它误红过一次
 * （手抄值停在粗标签）。现改为**直接读契约**（同一份 `protocol.json`，本文件本来就在读它）：
 * 期望值仍**独立于被测实现**（读的是契约，不是生成物），但不再有副本可漂移。
 */

/** admin 侧的真实数据装进纯函数的入参。 */
const TABLES: AddressCategoryTables = {
  // 段表的内部形态是**契约键**；这里用契约的 endLabels 反查回 admin 粗标签
  // （与 safe-http 对外暴露的形态一致）—— R89 起 admin 的标签也来自契约。
  ipv4: withAdminLabels(
    SSRF_DENY_HOST_PATTERNS.ipv4 as never,
    END_LABELS_ADMIN as never,
  ) as never,
  ipv6: withAdminLabels(
    SSRF_DENY_HOST_PATTERNS.ipv6 as never,
    END_LABELS_ADMIN as never,
  ) as never,
  metadataAddresses: networkPolicy.metadataAddresses.addresses,
  isIP,
  endLabels: END_LABELS_ADMIN as never,
};

/** R78：装配函数现在**要求**调用方传入恒拒表（模块本身零 import）。 */
const BUILD = () =>
  buildAddressCategoryTables(
    isIP,
    networkPolicy.metadataAddresses.addresses,
    END_LABELS_ADMIN as never,
  );

describe("地址分类纯函数 · 表驱动（期望值逐字来自契约）", () => {
  it("契约的每条示例地址 ⇒ 分类结果 = 契约类别经映射后的 admin 粗标签", () => {
    const mismatches: string[] = [];
    for (const [cls, def] of Object.entries(networkPolicy.addresses)) {
      if (cls === "ipv4Mapped") continue; // 契约规定按内嵌 IPv4 判定，见下方专例
      const expected = networkPolicy.categories.endLabels.admin[cls];
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
  it("工厂装出的 tables 与手装的 tables 等价（防装配漂移）", () => {
    const built = BUILD();
    expect(built.metadataAddresses).toEqual(TABLES.metadataAddresses);
    expect(built.isIP).toBe(TABLES.isIP);
    expect(built.endLabels).toEqual(TABLES.endLabels);
    // 段表：工厂装的是**契约键**形态，手装的是**粗标签**形态 ⇒ 经 endLabels
    // 反查后必须逐条相等（R89 起 admin 的标签也来自契约）。
    const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);
    expect(ids(built.ipv4)).toEqual(ids(TABLES.ipv4));
    expect(ids(built.ipv6)).toEqual(ids(TABLES.ipv6));
    expect(
      built.ipv4.map((x) => ({
        id: x.id,
        risk: (built.endLabels as Record<string, string>)[x.risk] ?? x.risk,
      })),
    ).toEqual(TABLES.ipv4.map((x) => ({ id: x.id, risk: x.risk })));
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

/**
 * R79：**主机名形态的 loopback 同义判定**（零依赖纯函数）。
 *
 * ## 职责边界（为什么必须有它）
 *
 * `classifyAddress` 对非 IP 字面量一律返回 `category: null`（"交给 DNS"）。
 * admin 对 `localhost` / `foo.localhost` 的拒绝此前**完全依赖 DNS 解析结果**
 * （`localhost` → 127.0.0.1；`foo.localhost` → 解析失败 → fail-closed）。
 * ⇒ 仓外探针（不做 DNS）覆盖不到契约 `loopback.examples` 里的这两条。
 *
 * ## 期望值来源
 *
 * 契约 `networkPolicy.addresses.loopback.description` 逐字：
 * 「回环地址：IPv4 127.0.0.0/8、IPv6 ::1，**以及主机名 localhost / *.localhost /
 * localhost.localdomain**」⇒ 表里的每个期望值都能回到这句话。
 *
 * ## 与 admin 现状的一致性
 *
 * 本文件另有一条**行为对照**：admin 的 `assertSafeHttpUrl` 对同样的主机名给出的
 * 结论（拒/放行）必须与纯函数一致 —— 现状实测：`localhost` / `foo.localhost` /
 * `LOCALHOST` / `localhost.` 四者 admin 全拒、纯函数也全判受限、`example.com` 两边
 * 都放行。⇒ 纯函数与 admin 的**结论**一致（分歧只在「理由」：admin 靠 DNS，
 * 纯函数靠契约的后缀规则）。
 */
describe("R79 · 主机名形态：loopback 同义判定（期望值来自契约 description）", () => {
  it("契约点名的三个形态 ⇒ 受限", () => {
    const cases = [
      ["localhost", true],
      ["localhost.localdomain", true],
      ["foo.localhost", true],
    ] as const;
    for (const [host, expected] of cases) {
      expect([host, isLoopbackHostname(host)]).toEqual([host, expected]);
    }
  });

  it("大小写与尾点：DNS 名不区分大小写、尾点是绝对名 ⇒ 同义", () => {
    for (const host of [
      "LOCALHOST",
      "LocalHost",
      "localhost.",
      "FOO.LOCALHOST.",
    ]) {
      expect([host, isLoopbackHostname(host)]).toEqual([host, true]);
    }
  });

  it("契约未点名的形态：普通域名 / IP 字面量 ⇒ 不受本函数管", () => {
    for (const host of [
      "example.com",
      "notlocalhost.com", // 后缀不等于 .localhost，不能误判
      "localhost.evil.com", // 同理
      "127.0.0.1", // IP 字面量交给 classifyAddress
      "::1",
      "10.0.0.5",
      "",
    ]) {
      expect([host, isLoopbackHostname(host)]).toEqual([host, false]);
    }
  });

  it("normalizeHostname：剥方括号 / 去尾点 / 小写（三条都来自 DNS 语义）", () => {
    expect(normalizeHostname("[::1]")).toBe("::1");
    expect(normalizeHostname("Example.COM.")).toBe("example.com");
    expect(normalizeHostname("  LOCALHOST  ")).toBe("localhost");
  });

  it("行为对照：admin 的 assertSafeHttpUrl 对同样主机名的结论必须与纯函数一致", async () => {
    // R80 起本文件 mock 了 DNS（为注入"解析到公网"的旁路场景）⇒ 这里显式给
    // example.com 一个公网答案，否则它会被判"解析不到"（fail-closed）而显得像拒。
    mockedLookup.mockReset();
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    // 现状取证（R79）：admin 对这四个主机名全拒、对 example.com 放行。
    // 若哪天 admin 放开某个 localhost 同义名，这条会红 —— 那正是要人看的。
    const hosts = ["localhost", "foo.localhost", "LOCALHOST", "localhost."];
    const mismatches: string[] = [];
    for (const host of hosts) {
      let adminDenied = false;
      try {
        await assertSafeHttpUrl(`http://${host}/hook`);
      } catch {
        adminDenied = true;
      }
      const pureDenied = isLoopbackHostname(host);
      if (adminDenied !== pureDenied) {
        mismatches.push(`${host}: admin ${adminDenied} / 纯函数 ${pureDenied}`);
      }
    }
    let exampleDenied = false;
    try {
      await assertSafeHttpUrl("http://example.com/hook");
    } catch {
      exampleDenied = true;
    }
    expect(mismatches).toEqual([]);
    expect([exampleDenied, isLoopbackHostname("example.com")]).toEqual([
      false,
      false,
    ]);
  });
});

/**
 * R80：**`*.localhost` 的 DNS 旁路**（R79 发现、本轮修）。
 *
 * ## 旁路怎么成立
 *
 * admin 对 `localhost` 系主机名的拒绝**完全依赖 DNS 结果**：解析到 127.0.0.1 才拒。
 * 契约 `loopback.description` 要求「`localhost` / `*.localhost` /
 * `localhost.localdomain` 一律是回环」——与 DNS 实际解析成什么**无关**（RFC 6761
 * 把 `*.localhost` 定为回环专用名）。
 * ⇒ 只要某环境的 DNS 把 `foo.localhost` 解析到**公网地址**，旧实现就会**放行**，
 * 而契约要求拒。这是一条真实的旁路（不依赖攻击者的运气：`.localhost` 的解析
 * 完全由本机 resolver / hosts / 上游 DNS 决定）。
 *
 * ## 本文件的断言
 *
 * 用 jest 的 DNS 替身让 `*.localhost` 解析到**公网 IP**（`93.184.216.34`），
 * 断言新实现**拒**、且**不发起任何出站请求**（只是判定，不连 socket）。
 */
describe("R80 · *.localhost 的 DNS 旁路：解析到公网也必须拒", () => {
  const PUBLIC_IP = "93.184.216.34";

  beforeEach(() => {
    mockedLookup.mockReset();
    // 注入式替身：把任何 *.localhost 都解析到公网地址（旁路成立的环境）
    mockedLookup.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);
  });

  it("foo.localhost 解析到公网 ⇒ 仍必须拒（旧实现会放行 = 旁路）", async () => {
    await expect(
      assertSafeHttpUrl("http://foo.localhost/hook"),
    ).rejects.toThrow();
  });

  it("localhost 解析到公网 ⇒ 仍必须拒", async () => {
    await expect(assertSafeHttpUrl("http://localhost/hook")).rejects.toThrow();
  });

  it("四种形态（大小写 / 尾点）全部拒", async () => {
    for (const host of [
      "LOCALHOST",
      "localhost.",
      "foo.localhost.",
      "LOCALHOST.LOCALDOMAIN".toLowerCase(),
    ]) {
      await expect(assertSafeHttpUrl(`http://${host}/hook`)).rejects.toThrow();
    }
  });

  it("合规域名（example.com 解析到公网）仍放行（闸不能开成 deny-all）", async () => {
    await expect(
      assertSafeHttpUrl("http://example.com/hook"),
    ).resolves.toBeDefined();
  });

  it("pin 版（assertAndPinHttpUrl）同样拒，且不受影响", async () => {
    for (const policy of ["webhook", "executor"] as const) {
      await expect(
        assertAndPinHttpUrl("http://foo.localhost/hook", { policy }),
      ).rejects.toThrow();
    }
  });
});

/**
 * R81：**同族两面的同款旁路**（ADR-036 §3.3 登记的遗留）。
 *
 * `assertSafeGitRepoUrl`（git 面）与 `assertSafeExecutorUrl`（executor 面）
 * 与 webhook 面结构完全一致：非 IP 字面量 ⇒ `lookup()` ⇒ 逐答案判定
 * ⇒ **主机名的拒与不拒完全取决于 DNS 解析结果**。⇒ 同样的旁路：
 * `*.localhost` 解析到公网时它们会放行。
 *
 * 两面的**错误码保持各自既有语义**（不套用 webhook 面的 SSRF_HOST_DENIED）：
 *   · git 面   ⇒ `GIT_REPO_HOST_BLOCKED`（既有「地址判定层拒绝」的码）
 *   · executor ⇒ `EXECUTOR_HOST_BLOCKED`
 * 理由：这两面的调用方与文案域不同（git 克隆失败 vs 执行器不可达），
 * 混用 webhook 的码会让运维按错误域排查。
 */
describe("R81 · 同族两面：git / executor 的 localhost 旁路", () => {
  const PUBLIC_IP = "93.184.216.34";

  beforeEach(() => {
    mockedLookup.mockReset();
    mockedLookup.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);
  });

  it("git 面：foo.localhost 解析到公网 ⇒ 必须拒（旧实现放行）", async () => {
    await expect(
      assertSafeGitRepoUrl("http://foo.localhost/repo.git"),
    ).rejects.toThrow();
  });

  it("git 面：localhost 解析到公网 ⇒ 必须拒", async () => {
    await expect(
      assertSafeGitRepoUrl("http://localhost/repo.git"),
    ).rejects.toThrow();
  });

  it("executor 面：foo.localhost 解析到公网 ⇒ 必须拒（旧实现放行）", async () => {
    await expect(
      assertSafeExecutorUrl("http://foo.localhost:3002/api/execute"),
    ).rejects.toThrow();
  });

  it("executor 面：localhost 解析到公网 ⇒ 必须拒", async () => {
    await expect(
      assertSafeExecutorUrl("http://localhost:3002/api/execute"),
    ).rejects.toThrow();
  });

  it("两面的错误码各自保留（不套用 webhook 面的 SSRF_HOST_DENIED）", async () => {
    const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
        return "NO_THROW";
      } catch (err: unknown) {
        // AppError 的业务码字段是 `errorCode`（不是 Node 的 `code`）。
        return String((err as { errorCode?: string }).errorCode ?? "NO_CODE");
      }
    };
    expect(
      await codeOf(() => assertSafeGitRepoUrl("http://foo.localhost/r.git")),
    ).toBe("GIT_REPO_HOST_BLOCKED");
    expect(
      await codeOf(() => assertSafeExecutorUrl("http://foo.localhost:3002/x")),
    ).toBe("EXECUTOR_HOST_BLOCKED");
  });

  it("不误伤：example.com（公网）两面都放行", async () => {
    await expect(
      assertSafeGitRepoUrl("http://example.com/repo.git"),
    ).resolves.toBeUndefined();
    await expect(
      assertSafeExecutorUrl("http://example.com:3002/api/execute"),
    ).resolves.toBeDefined();
  });

  it("不误伤：RFC1918 在开关开启时 executor 面仍放行（内网 git/executor 拓扑）", async () => {
    // executor 面的既有语义：private-lan 只在 EXECUTOR_ALLOW_PRIVATE_NETWORK=true 时放行
    const prev = process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;
    process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = "true";
    try {
      mockedLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
      await expect(
        assertSafeExecutorUrl("http://gitlab.internal:3002/api/execute"),
      ).resolves.toBeDefined();
      // git 面：RFC1918 是文档化拓扑 ⇒ 恒放行（与开关无关）
      await expect(
        assertSafeGitRepoUrl("http://gitlab.internal/repo.git"),
      ).resolves.toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;
      else process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = prev;
    }
  });
});

/**
 * R86b：**连续尾点**（`localhost..`）的跨端收口。
 *
 * ## 事实（W1 的跨端判据实测）
 * admin 放行 `localhost..`，node / python 拒绝。根因：admin 的 `normalizeHostname`
 * **只折一个尾点** ⇒ `localhost..` 折完剩 `localhost.` ⇒ 不等于 `localhost` ⇒ 判「非回环」。
 *
 * ## 契约立场：沉默区
 * `loopback.description` 对**连续尾点**未表态（只写了 `localhost.` 这种单尾点绝对名）。
 * ⇒ Lead 裁决：按 **fail-closed 对齐到「拒绝」**（node/python 已拒，让 admin 也拒是
 * **收紧**方向）；**不**采用「折叠所有尾点后当成 localhost 放行」的解释——沉默区不该
 * 往放行方向解释。
 *
 * ⇒ 归一化改为**折所有尾点**（`replace(/\.+$/, "")`），于是 `localhost..` → `localhost`
 * ⇒ 判为回环 ⇒ 拒绝。
 */
describe("R86b · 连续尾点（localhost..）必须判为回环", () => {
  it("连续尾点三种形态 ⇒ 受限（旧实现：归一化只折一个尾点 ⇒ 放行）", () => {
    for (const host of ["localhost..", "foo.localhost..", "LOCALHOST.."]) {
      expect([host, isLoopbackHostname(host)]).toEqual([host, true]);
    }
  });

  it("normalizeHostname 折**所有**尾点（不只一个）", () => {
    expect(normalizeHostname("localhost..")).toBe("localhost");
    expect(normalizeHostname("foo.localhost...")).toBe("foo.localhost");
    expect(normalizeHostname("example.com.")).toBe("example.com");
  });

  it("误伤检查：单尾点 FQDN 与相似域名行为不变", () => {
    // example.com.（单尾点 FQDN）不是回环名 —— 与修前一致
    expect(isLoopbackHostname("example.com.")).toBe(false);
    // 后缀不等价的两个负例 —— 与修前一致
    expect(isLoopbackHostname("notlocalhost.com")).toBe(false);
    expect(isLoopbackHostname("localhost.evil.com")).toBe(false);
  });

  it("行为对照：admin 的 assertSafeHttpUrl 对连续尾点也必须拒", async () => {
    mockedLookup.mockReset();
    // 即使 DNS 把它解析到公网，名字判定也应先拒（与 R80 同款）
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    for (const host of ["localhost..", "foo.localhost.."]) {
      await expect(assertSafeHttpUrl(`http://${host}/hook`)).rejects.toThrow();
    }
  });
});

/**
 * R89（ADR-034 步骤 1）：**内置兜底映射与契约生成物逐字一致**。
 *
 * 纯模块 `address-category.util.ts` 必须保持**零 import**（仓外探针用
 * `--experimental-strip-types` 直接 require 它，任何相对导入都可能解析失败）⇒
 * 契约的 `endLabels.admin` 由调用方注入。但仓外探针（cross-end 的 admin 探针）
 * 自己拼 tables、不引生成物 ⇒ 模块内必须有一份**兜底映射**。
 *
 * ⇒ 两份必须逐字一致，否则「注入时」与「未注入时」的 admin 标签会不同 ⇒
 * 分类结论随调用方式变化（隐蔽的分叉）。
 */
/** R91：每个契约类别一个代表地址（用于「注入 vs 未注入」逐类对齐）。 */
const SAMPLE_BY_CONTRACT_KEY: Readonly<Record<string, string>> = {
  loopback: "127.0.0.1",
  privateIPv4: "10.0.0.1",
  linkLocal: "169.254.1.1",
  cgnat: "100.64.0.1",
  unspecified: "0.0.0.0",
  multicast: "224.0.0.1",
  reserved: "240.0.0.1",
};

describe("R89 · 内置兜底映射与契约生成物逐字一致", () => {
  it("ADMIN_LABEL_FALLBACK 与生成物 END_LABELS_ADMIN 逐字相同", () => {
    // R91：改为**与生成物动态比对**（原先把粗标签快照写死 ⇒ 步骤4 拆细后必然误红）。
    // 判据本意是「兜底 == 契约」，不是「兜底 == 某个历史快照」。
    const fromContract = Object.fromEntries(
      Object.entries(END_LABELS_ADMIN).map(([k, v]) => [k, v]),
    );
    const fallback = (classifyAddress as unknown as {
      ADMIN_LABEL_FALLBACK?: never;
    })
      ? null
      : null;
    void fallback;
    // 用「未注入 endLabels 的分类结果」与「注入后的分类结果」逐类对齐来验证等价：
    // 探针（未注入）与生产（注入）必须给同一标签。
    for (const key of Object.keys(fromContract)) {
      const sample = SAMPLE_BY_CONTRACT_KEY[key];
      if (!sample) continue;
      const withoutLabels = classifyAddress(sample, {
        ...TABLES,
        endLabels: undefined,
      });
      const withLabels = classifyAddress(sample, TABLES);
      expect([key, withoutLabels.category]).toEqual([key, withLabels.category]);
      expect([key, withLabels.category]).toEqual([key, fromContract[key]]);
    }
  });

  it("未注入 endLabels 时，分类结论与注入时**相同**（两种调用方式不得分叉）", () => {
    const withLabels = classifyAddress("10.0.0.1", TABLES);
    const withoutLabels = classifyAddress("10.0.0.1", {
      ...TABLES,
      endLabels: undefined,
    });
    expect([withLabels.category, withoutLabels.category]).toEqual([
      "private-lan",
      "private-lan",
    ]);
  });
});
