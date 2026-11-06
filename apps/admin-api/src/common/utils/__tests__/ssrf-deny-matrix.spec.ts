/**
 * SEC-04 — unified SSRF deny matrix.
 *
 * The three guards (assertSafeHttpUrl for webhook/AI, assertSafeExecutorUrl
 * for executor traffic, assertSafeGitRepoUrl for git clones) used to keep
 * separate deny lists which historically drifted (the V3 198.18/100.64 gap,
 * the R3 first-hop bypass). They now all classify through the single
 * SSRF_DENY_HOST_PATTERNS table in safe-http.util.ts. This spec runs the
 * SAME danger list against all three guards and asserts the documented
 * posture of each, so a future segment edit cannot silently diverge again.
 */
import { isIP } from "node:net";
import {
  AddressRisk,
  addressRiskSegmentId,
  assertAndPinHttpUrl,
  assertSafeExecutorUrl,
  assertSafeGitRepoUrl,
  assertSafeHttpUrl,
  classifyAddressRisk,
  normalizeIpForClassification,
  SSRF_DENY_HOST_PATTERNS,
} from "../safe-http.util";

// DNS-answer paths are exercised by mocking resolution — every other test
// uses IP literals and never reaches lookup().
jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }));
import { lookup } from "node:dns/promises";
const mockedLookup = lookup as unknown as jest.Mock<
  Promise<Array<{ address: string; family: number }>>
>;

/** WHATWG URL keeps IPv6 brackets in url.hostname — re-add them for literals. */
const urlHostOf = (addr: string): string =>
  addr.includes(":") ? `[${addr}]` : addr;

/**
 * The unified danger list. Every entry is non-public; `risk` is what the
 * shared classifier must return (the guard policies branch on these classes:
 * webhook/AI denies every non-public class; executor additionally allows
 * private-lan and gates loopback/restricted behind
 * EXECUTOR_ALLOW_PRIVATE_NETWORK; git allows public + IPv4 private-lan only).
 */
const DANGER_MATRIX: Array<{ name: string; addr: string; risk: AddressRisk }> =
  [
    { name: "IPv4 loopback", addr: "127.0.0.1", risk: "loopback" },
    { name: "IPv4 RFC1918 10/8", addr: "10.1.2.3", risk: "private-lan" },
    { name: "IPv4 RFC1918 172.16/12", addr: "172.16.0.1", risk: "private-lan" },
    {
      name: "IPv4 RFC1918 192.168/16",
      addr: "192.168.1.1",
      risk: "private-lan",
    },
    {
      name: "IPv4 link-local (cloud metadata)",
      addr: "169.254.169.254",
      risk: "link-local",
    },
    { name: "IPv4 CGNAT lower bound", addr: "100.64.0.1", risk: "restricted" },
    {
      name: "IPv4 CGNAT upper bound",
      addr: "100.127.255.254",
      risk: "restricted",
    },
    {
      name: "IPv4 benchmark lower bound",
      addr: "198.18.0.1",
      risk: "restricted",
    },
    {
      name: "IPv4 benchmark upper bound",
      addr: "198.19.255.255",
      risk: "restricted",
    },
    // R91：标签拆细（原先 unspecified/multicast 并入 reserved）。行为不变（两者恒拒）。
    { name: "IPv4 unspecified", addr: "0.0.0.0", risk: "unspecified" },
    { name: "IPv4 multicast", addr: "224.0.0.1", risk: "multicast" },
    { name: "IPv4 reserved 240/4", addr: "240.0.0.1", risk: "reserved" },
    { name: "IPv4 broadcast", addr: "255.255.255.255", risk: "reserved" },
    { name: "IPv6 loopback", addr: "::1", risk: "loopback" },
    {
      name: "IPv6 loopback full-form",
      addr: "0:0:0:0:0:0:0:1",
      risk: "loopback",
    },
    { name: "IPv6 unspecified", addr: "::", risk: "unspecified" },
    { name: "IPv6 ULA fd00::/8（含 AWS IPv6 元数据段）", addr: "fd00::1234", risk: "link-local" },
    { name: "IPv6 ULA fc00::", addr: "fc00::1", risk: "link-local" },
    { name: "IPv6 link-local fe80::", addr: "fe80::a1", risk: "link-local" },
    { name: "IPv6 link-local febf::", addr: "febf::ffff", risk: "link-local" },
    { name: "IPv6 multicast", addr: "ff02::1", risk: "multicast" },
    {
      name: "mapped loopback (dotted)",
      addr: "::ffff:127.0.0.1",
      risk: "loopback",
    },
    {
      name: "mapped metadata (dotted)",
      addr: "::ffff:169.254.169.254",
      risk: "link-local",
    },
    {
      name: "mapped metadata (hex)",
      addr: "::ffff:a9fe:a9fe",
      risk: "link-local",
    },
    { name: "mapped private", addr: "::ffff:10.0.0.1", risk: "private-lan" },
    { name: "mapped benchmark", addr: "::ffff:198.18.0.1", risk: "restricted" },
    { name: "mapped CGNAT (hex)", addr: "::ffff:6440:5", risk: "restricted" },
  ];

const isIpv4AfterNormalize = (addr: string): boolean =>
  isIP(normalizeIpForClassification(addr)) === 4;

/** Segment id → sample addresses that MUST land in that segment. */
const SEGMENT_SAMPLES: Record<string, string[]> = {
  "ipv4-unspecified": ["0.0.0.0", "0.1.2.3"],
  "ipv4-rfc1918-10": ["10.0.0.0", "10.255.255.255"],
  "ipv4-cgnat": ["100.64.0.0", "100.127.255.255"],
  "ipv4-loopback": ["127.0.0.1", "127.255.0.1"],
  "ipv4-link-local-metadata": ["169.254.0.1", "169.254.169.254"],
  "ipv4-rfc1918-172": ["172.16.0.0", "172.31.255.255"],
  "ipv4-rfc1918-192": ["192.168.0.0", "192.168.255.255"],
  "ipv4-benchmark": ["198.18.0.0", "198.19.255.255"],
  "ipv4-multicast": ["224.0.0.1", "239.255.255.255"],
  "ipv4-reserved": ["240.0.0.1", "255.255.255.255"],
  "ipv6-unspecified": ["::", "0:0:0:0:0:0:0:0"],
  "ipv6-loopback": ["::1", "0:0:0:0:0:0:0:1"],
  "ipv6-unique-local": ["fc00::1", "fdff::ffff"],
  "ipv6-link-local": ["fe80::1", "febf::1"],
  "ipv6-multicast": ["ff00::1", "ffff::1"],
};

describe("SEC-04 — SSRF_DENY_HOST_PATTERNS is the single source of truth", () => {
  it("exposes exactly the merged union deny segments (golden list)", () => {
    expect(
      SSRF_DENY_HOST_PATTERNS.ipv4.map((s) => `${s.cidr} => ${s.risk}`),
    ).toEqual([
      "0.0.0.0/8 => unspecified",
      "10.0.0.0/8 => private-lan",
      "100.64.0.0/10 => restricted",
      "127.0.0.0/8 => loopback",
      "169.254.0.0/16 => link-local",
      "172.16.0.0/12 => private-lan",
      "192.168.0.0/16 => private-lan",
      "198.18.0.0/15 => restricted",
      "224.0.0.0/4 => multicast",
      "240.0.0.0/4 => reserved",
    ]);
    expect(
      SSRF_DENY_HOST_PATTERNS.ipv6.map((s) => `${s.cidr} => ${s.risk}`),
    ).toEqual([
      "::/128 => unspecified",
      "::1/128 => loopback",
      "fc00::/7 => link-local",   // 2026-11-05：契约归 linkLocal（含 AWS IPv6 元数据），恒拒
      "fe80::/10 => link-local",
      "ff00::/8 => multicast",
    ]);
  });

  it("routes every segment's boundary samples to its declared risk and id", () => {
    for (const family of ["ipv4", "ipv6"] as const) {
      for (const segment of SSRF_DENY_HOST_PATTERNS[family]) {
        for (const sample of SEGMENT_SAMPLES[segment.id] ?? []) {
          expect(classifyAddressRisk(sample)).toBe(segment.risk);
          expect(addressRiskSegmentId(sample)).toBe(segment.id);
        }
      }
    }
  });

  it("keeps adjacent public ranges out of the table (no over-block)", () => {
    for (const addr of [
      "11.0.0.1",
      "100.63.255.255",
      "100.128.0.1",
      "126.255.255.255",
      "128.0.0.1",
      "172.32.0.1",
      "192.169.0.1",
      "198.17.255.255",
      "198.20.0.1",
      "223.255.255.254",
      "fec0::1", // deprecated site-local, below ff00::/8 and outside fe80::/10
      "2001:db8::1",
    ]) {
      expect(classifyAddressRisk(addr)).toBe("public");
      expect(addressRiskSegmentId(addr)).toBeNull();
    }
  });

  it("classifies every matrix entry exactly as declared", () => {
    for (const { addr, risk } of DANGER_MATRIX) {
      expect(classifyAddressRisk(addr)).toBe(risk);
    }
  });
});

describe("SEC-04 — same danger list against all three guards (default executor env)", () => {
  const PRIVATE = process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;
  afterEach(() => {
    if (PRIVATE === undefined)
      delete process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;
    else process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = PRIVATE;
    mockedLookup.mockReset();
  });

  it("assertSafeHttpUrl (webhook/AI) rejects EVERY non-public entry", async () => {
    for (const { addr } of DANGER_MATRIX) {
      await expect(
        assertSafeHttpUrl(`http://${urlHostOf(addr)}/x`),
      ).rejects.toThrow();
    }
  });

  // R05（2026-11-05）：契约 `networkPolicy.addresses.privateIPv4.allowedUnderPrivateNetwork`
  // = **true** ⇒ 私网**也**要开关才放行；此前 admin 是「private-lan 恒放行」，与契约相反
  // （四向检查 `grid:privateIPv4@off:admin`）。⇒ 默认环境下**只有 public 放行**。
  it("assertSafeExecutorUrl 默认只放行 public（private-lan 亦需开关 —— 契约 allowedUnderPrivateNetwork=true）", async () => {
    for (const { addr, risk } of DANGER_MATRIX) {
      const outcome = assertSafeExecutorUrl(`http://${urlHostOf(addr)}:3002/x`);
      if (risk === "public") {
        await expect(outcome).resolves.toBeInstanceOf(URL);
      } else {
        await expect(outcome).rejects.toThrow();
      }
    }
  });

  // R05：`grid:privateIPv4@off:admin` 与 `grid:loopback@on:admin` 两格的**直接判据**
  // （四向检查的第四面已经逐格比对；这里把两条契约语义钉在单测里，改错必红）。
  it("R05 两格 · off 态：私网四例全部拒绝（契约 privateIPv4.allowedUnderPrivateNetwork=true ⇒ 默认拒）", async () => {
    for (const addr of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.1"]) {
      await expect(
        assertSafeExecutorUrl(`http://${addr}:3002/x`),
      ).rejects.toThrow();
      await expect(
        assertAndPinHttpUrl(`http://${addr}:3002/x`, { policy: "executor" }),
      ).rejects.toThrow();
    }
  });

  it("assertSafeGitRepoUrl allows public + IPv4 private-lan, refuses the rest (incl. ULA)", async () => {
    for (const { addr, risk } of DANGER_MATRIX) {
      const outcome = assertSafeGitRepoUrl(
        `http://${urlHostOf(addr)}/repo.git`,
      );
      const allowed =
        risk === "public" ||
        (risk === "private-lan" && isIpv4AfterNormalize(addr));
      if (allowed) {
        await expect(outcome).resolves.toBeUndefined();
      } else {
        await expect(outcome).rejects.toThrow();
      }
    }
  });

  it("assertSafeHttpUrl classifies bracketed IPv6 literals directly now (SEC-04 bracket strip)", async () => {
    // Previously bracketed literals missed isIP() and fell into the
    // resolver path — refused only incidentally (Linux getaddrinfo rejects
    // "[::1]", Windows accepts it).
    await expect(assertSafeHttpUrl("http://[::1]:9000/")).rejects.toThrow(
      /拒绝名单/,
    );
    await expect(assertSafeHttpUrl("http://[fd00::1]/")).rejects.toThrow(
      /拒绝名单/,
    );
    await expect(assertSafeHttpUrl("http://[fe80::1]/")).rejects.toThrow(
      /拒绝名单/,
    );
    await expect(
      assertSafeHttpUrl("http://[::ffff:127.0.0.1]/"),
    ).rejects.toThrow(/拒绝名单/);
    await expect(
      assertSafeHttpUrl("http://[2606:4700::6810:84e5]/"),
    ).resolves.toBeInstanceOf(URL);
  });
});

describe("SEC-04 — EXECUTOR_ALLOW_PRIVATE_NETWORK=true (documented exemption)", () => {
  const PRIVATE = process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;
  beforeEach(() => {
    process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = "true";
  });
  afterEach(() => {
    if (PRIVATE === undefined)
      delete process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;
    else process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = PRIVATE;
    mockedLookup.mockReset();
  });

  // R01（2026-11-05）：本条此前把 `restricted`（198.18/15 + 100.64/10）与 loopback 一起
  // 断言为「开关开启即解锁」。契约 `networkPolicy.addresses.cgnat.allowedUnderPrivateNetwork`
  // = false 且 node/python 两态都拒 ⇒ 执行器姿态下 `restricted` **两态都拒**；开关的唯一效果
  // 是 loopback（文档化的同机 dev 部署）。两档拆成两条用例，避免"一起断言"掩盖分叉。
  // R05（2026-11-05）：契约 `networkPolicy.addresses.loopback.allowedUnderPrivateNetwork`
  // = **false**，且 `switch.semantics` 写「开关开启 ⇒ 放行 privateIPv4；**其余五类一律仍拒**」
  // ⇒ **loopback 在任何开关状态下都拒**（契约 $comment ④ 原话：「loopback 不随
  // private-network 开关放行（打自己回环没有合法拓扑）」）。此前 admin 把 loopback 放进
  // 开关解锁组，与契约相反（四向检查 `grid:loopback@on:admin`）。
  it("R05 两格 · on 态：开关只解锁 privateIPv4；loopback（含 mapped/full-form）仍**恒拒**", async () => {
    // on 态：私网放行（契约 privateIPv4.allowedUnderPrivateNetwork=true）
    for (const addr of ["10.0.0.1", "172.16.0.1", "192.168.1.1", "::ffff:10.0.0.1"]) {
      await expect(
        assertSafeExecutorUrl(`http://${urlHostOf(addr)}:3002/`),
      ).resolves.toBeInstanceOf(URL);
      await expect(
        assertAndPinHttpUrl(`http://${urlHostOf(addr)}:3002/`, { policy: "executor" }),
      ).resolves.toBeTruthy();
    }
    // on 态：loopback 仍拒（契约 loopback.allowedUnderPrivateNetwork=false）
    for (const addr of [
      "127.0.0.1",
      "::1",
      "0:0:0:0:0:0:0:1", // WHATWG compresses to ::1 before classification
      "::ffff:127.0.0.1",
    ]) {
      await expect(
        assertSafeExecutorUrl(`http://${urlHostOf(addr)}:3002/`),
      ).rejects.toThrow();
      await expect(
        assertAndPinHttpUrl(`http://${urlHostOf(addr)}:3002/`, { policy: "executor" }),
      ).rejects.toThrow();
    }
  });

  it("STILL refuses restricted classes (benchmark / CGNAT) under the flag", async () => {
    for (const addr of [
      "198.18.0.1",
      "100.64.0.1",
      "::ffff:100.64.0.1",
    ]) {
      await expect(
        assertSafeExecutorUrl(`http://${urlHostOf(addr)}:3002/`),
      ).rejects.toThrow(/restricted/);
    }
    // R08/ADR-029：阿里云元数据 100.100.100.200 现在走**元数据恒拒**这条更早的判定
    // （错误文案由具体姿态的错误码决定，不再带 `restricted` 字样）⇒ 这里只断言"拒"，
    // 精确语义由上方「R08 — 元数据地址恒拒」那组用例钉住。
    await expect(
      assertSafeExecutorUrl("http://100.100.100.200:3002/"),
    ).rejects.toThrow();
  });

  it("STILL refuses link-local and reserved classes", async () => {
    for (const addr of [
      "169.254.169.254",
      "0.0.0.0",
      "::",
      "fe80::1",
      "ff02::1",
      "224.0.0.1",
      "240.0.0.1",
    ]) {
      await expect(
        assertSafeExecutorUrl(`http://${urlHostOf(addr)}:3002/`),
      ).rejects.toThrow();
    }
  });

  it("metadata hostnames stay refused via DNS even under the flag", async () => {
    mockedLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(
      assertSafeExecutorUrl("http://metadata.google.internal:3002/"),
    ).rejects.toThrow(/link-local/);
  });
});

/**
 * R08（2026-11-05）：**元数据地址恒拒** —— 契约 `networkPolicy.metadataAddresses`。
 *
 * 裁决背景（R07）：webhook 面把 `restricted` 放在「开关开启才放行」组，而**同一份文档**
 * 又承诺「云元数据恒拒」；而阿里云 ECS 元数据 `100.100.100.200` 实测分类正是 `restricted`
 * ⇒ 三个 webhook 开关任一开启即可达。裁决为方案②：把「真正要拒的元数据地址」从
 * `restricted` 里**拆出来单列**（恒拒、不受任何 posture/开关影响），从而：
 *   · 不降级安全承诺（排除"改文档"）；
 *   · 不打断 Tailscale `100.64/10` 合法用户（排除"restricted 恒拒"）。
 *
 * 判据三条（覆盖三个姿态 × 两态），**判定顺序**必须是「先元数据、后 posture/开关」。
 */
/**
 * R09（2026-11-05）：**Oracle Cloud 元数据 `192.0.0.192` 被判 `public` ⇒ 四姿态全放行**。
 *
 * 事实（IANA IPv4 Special-Purpose Registry，2025-10-09 版）：
 * `192.0.0.0/24` = **IETF Protocol Assignments**，整段 Source/Destination/Forwardable/
 * Globally Reachable **全 False**，且脚注[2]「Not useable unless by virtue of a more
 * specific reservation」。⇒ 该段的默认取向是**不可用**，把 `192.0.0.192`（Oracle 实例元数据）
 * 归 `public` 是**拒绝清单漏项**：不受任何姿态/开关约束地全放行。
 *
 * 判据：分类必须**不再是 public**，且四姿态 × 两态都拒（复用 ADR-029 的
 * `metadataAddresses` 机制，而不是新造第二套）。
 */
describe("R09 — Oracle 元数据 192.0.0.192 不得被判 public，且四姿态恒拒", () => {
  const ORACLE_METADATA = "192.0.0.192";

  it("classifyAddressRisk 不再是 public（这是本轮硬判据）", () => {
    expect(classifyAddressRisk(ORACLE_METADATA)).not.toBe("public");
    expect(classifyAddressRisk(ORACLE_METADATA)).not.toBeNull();
  });

  it("webhook 姿态：开关开启也拒（与 R08 的阿里云元数据同档）", async () => {
    await expect(
      assertSafeHttpUrl(`http://${ORACLE_METADATA}/opc/v2/instance/`, {
        allowPrivateNetwork: true,
      }),
    ).rejects.toThrow();
    await expect(
      assertSafeHttpUrl(`http://${ORACLE_METADATA}/opc/v2/instance/`),
    ).rejects.toThrow();
  });

  it("执行器 / git 姿态：两态都拒", async () => {
    for (const flag of [false, true]) {
      await expect(
        assertAndPinHttpUrl(`http://${ORACLE_METADATA}/x`, {
          policy: "executor",
          allowPrivateNetwork: flag,
        }),
      ).rejects.toThrow();
    }
    await expect(
      assertSafeGitRepoUrl(`http://${ORACLE_METADATA}/repo.git`),
    ).rejects.toThrow();
  });
});

describe("R08 — 元数据地址恒拒（契约 networkPolicy.metadataAddresses）", () => {
  const METADATA = ["100.100.100.200"];

  it("webhook 姿态：开关**开启**也拒（R07 的裁决点；文档承诺「云元数据恒拒」）", async () => {
    for (const addr of METADATA) {
      await expect(
        assertSafeHttpUrl(`http://${addr}/latest/meta-data/`, {
          allowPrivateNetwork: true,
        }),
      ).rejects.toThrow();
    }
  });

  it("webhook 姿态：开关关闭同样拒（默认姿态，无需额外断言也拒）", async () => {
    for (const addr of METADATA) {
      await expect(
        assertSafeHttpUrl(`http://${addr}/latest/meta-data/`),
      ).rejects.toThrow();
    }
  });

  it("执行器姿态：两个入口 × 两态都拒（元数据判定在 risk/posture 之前）", async () => {
    for (const addr of METADATA) {
      for (const flag of [false, true]) {
        await expect(
          assertAndPinHttpUrl(`http://${addr}/x`, {
            policy: "executor",
            allowPrivateNetwork: flag,
          }),
        ).rejects.toThrow();
        process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = flag ? "true" : "false";
        try {
          await expect(
            assertSafeExecutorUrl(`http://${addr}/x`),
          ).rejects.toThrow();
        } finally {
          delete process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;
        }
      }
    }
  });

  it("git 姿态：恒拒（git 面本就拒 restricted，此处钉住元数据语义不依赖分类）", async () => {
    for (const addr of METADATA) {
      await expect(
        assertSafeGitRepoUrl(`http://${addr}/repo.git`),
      ).rejects.toThrow();
    }
  });
});

describe("SEC-04 — DNS-answer path agreement (metadata hostnames, hostile answers)", () => {
  const PRIVATE = process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;
  afterEach(() => {
    if (PRIVATE === undefined)
      delete process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;
    else process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = PRIVATE;
    mockedLookup.mockReset();
  });

  it("a metadata hostname is refused by all three guards", async () => {
    mockedLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(
      assertSafeHttpUrl("http://metadata.google.internal/webhook"),
    ).rejects.toThrow(/解析到被阻断的地址/);
    await expect(
      assertSafeExecutorUrl("http://metadata.google.internal:3002/"),
    ).rejects.toThrow(/link-local/);
    await expect(
      assertSafeGitRepoUrl("http://metadata.google.internal/repo.git"),
    ).rejects.toThrow(/已拒绝克隆/);
  });

  it("full-form IPv6 loopback/unspecified DNS answers are refused by all three (classifier gap fix)", async () => {
    for (const addr of ["0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:0"]) {
      mockedLookup.mockResolvedValue([{ address: addr, family: 6 }]);
      await expect(
        assertSafeHttpUrl("http://evil.example.com/webhook"),
      ).rejects.toThrow(/解析到被阻断的地址/);
      await expect(
        assertSafeExecutorUrl("http://evil.example.com:3002/"),
      ).rejects.toThrow();
      await expect(
        assertSafeGitRepoUrl("http://evil.example.com/repo.git"),
      ).rejects.toThrow(/已拒绝克隆/);
    }
  });

  it("public and private-LAN DNS answers keep their documented postures", async () => {
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(
      assertSafeHttpUrl("http://cdn.example.com/webhook"),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeExecutorUrl("http://cdn.example.com:3002/"),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeGitRepoUrl("http://cdn.example.com/repo.git"),
    ).resolves.toBeUndefined();

    mockedLookup.mockResolvedValue([{ address: "10.0.0.42", family: 4 }]);
    await expect(
      assertSafeHttpUrl("http://gitlab.internal/webhook"),
    ).rejects.toThrow(/解析到被阻断的地址/);
    // R05（2026-11-05）：执行器姿态下私网 DNS 解析结果**默认拒**（契约
    // privateIPv4.allowedUnderPrivateNetwork=true）；开关开启才放行 —— 见下方断言。
    await expect(
      assertSafeExecutorUrl("http://gitlab.internal:3002/"),
    ).rejects.toThrow(/private-lan|EXECUTOR_HOST_BLOCKED|拒绝名单/);
    const prevFlag = process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;
    process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = "true";
    try {
      await expect(
        assertSafeExecutorUrl("http://gitlab.internal:3002/"),
      ).resolves.toBeInstanceOf(URL);
    } finally {
      if (prevFlag === undefined) delete process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;
      else process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = prevFlag;
    }
    await expect(
      assertSafeGitRepoUrl("http://gitlab.internal/repo.git"),
    ).resolves.toBeUndefined();
  });

  it("scp-like git@host:path shape follows the same unified policy", async () => {
    mockedLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(
      assertSafeGitRepoUrl("git@gitlab.internal:org/repo.git"),
    ).resolves.toBeUndefined();

    mockedLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(
      assertSafeGitRepoUrl("git@metadata.internal:org/repo.git"),
    ).rejects.toThrow(/已拒绝克隆/);
    await expect(
      assertSafeGitRepoUrl("git@127.0.0.1:org/repo.git"),
    ).rejects.toThrow(/loopback/);
  });
});
