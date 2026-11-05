import {
  assertAndPinHttpUrl,
  assertSafeHttpUrl,
  assertSafeExecutorUrl,
  assertSafeGitRepoUrl,
  classifyAddressRisk,
  isMetadataAddress,
  normalizeIpForClassification,
  pinnedAxiosConfig,
} from "../safe-http.util";

// N25: the DNS-answer path of isBlockedAddress is exercised by mocking
// resolution — every other test in this file uses IP literals and never
// reaches lookup().
jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }));
import { lookup } from "node:dns/promises";
// The util calls lookup(host, { all: true }) — mock the array-returning
// overload (jest.MockedFunction would pin the wrong overload).
const mockedLookup = lookup as unknown as jest.Mock<
  Promise<Array<{ address: string; family: number }>>
>;

/**
 * F-3: executor-target SSRF policy.
 *  - Always blocked: link-local / cloud metadata (169.254.169.254),
 *    unspecified (0.0.0.0), multicast/reserved, non-http(s) protocols,
 *    embedded credentials.
 *  - Private LAN (10/8, 172.16/12, 192.168/16, IPv6 ULA): ALLOWED by default —
 *    executors legitimately live on the internal network (docker-compose
 *    `autoflow-internal`, LAN installs).
 *  - Loopback (127.0.0.1, ::1): blocked unless EXECUTOR_ALLOW_PRIVATE_NETWORK=true.
 */
describe("safe-http.util — assertSafeExecutorUrl (F-3)", () => {
  const PRIVATE = process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;

  afterEach(() => {
    if (PRIVATE === undefined)
      delete process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;
    else process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = PRIVATE;
    mockedLookup.mockReset();
  });

  describe("default policy (EXECUTOR_ALLOW_PRIVATE_NETWORK unset)", () => {
    it("blocks AWS/GCP metadata address", async () => {
      await expect(
        assertSafeExecutorUrl("http://169.254.169.254:80/latest"),
      ).rejects.toThrow(/link-local/);
    });

    it("blocks unspecified 0.0.0.0", async () => {
      await expect(
        assertSafeExecutorUrl("http://0.0.0.0:3002/api/execute"),
      ).rejects.toThrow();
    });

    it("blocks loopback 127.0.0.1 by default", async () => {
      await expect(
        assertSafeExecutorUrl("http://127.0.0.1:6379/"),
      ).rejects.toThrow(/loopback/);
    });

    it("blocks IPv6 loopback ::1 by default", async () => {
      await expect(assertSafeExecutorUrl("http://[::1]:3002/")).rejects.toThrow(
        /loopback/,
      );
    });

    it("blocks non-http(s) protocols", async () => {
      await expect(assertSafeExecutorUrl("file:///etc/passwd")).rejects.toThrow(
        /http\(s\)/,
      );
      await expect(
        assertSafeExecutorUrl("gopher://10.0.0.1:25/"),
      ).rejects.toThrow(/http\(s\)/);
    });

    it("rejects URLs embedding credentials", async () => {
      await expect(
        assertSafeExecutorUrl("http://user:pass@10.0.0.9:3002/api/execute"),
      ).rejects.toThrow(/内嵌凭据/);
    });

    // R05（2026-11-05）：契约 `networkPolicy.addresses.privateIPv4.allowedUnderPrivateNetwork`
    // = **true** ⇒ 「默认放行私网」与契约相反（四向检查 `grid:privateIPv4@off:admin`）。
    // 语义改为：默认拒；`EXECUTOR_ALLOW_PRIVATE_NETWORK=true` 才放行（compose 默认栈已在
    // admin-api 服务里置 true，故 docker-compose 内部拓扑不受影响）。
    it("**refuses** private LAN 10.x by default（R05：契约要求开关才放行）", async () => {
      await expect(
        assertSafeExecutorUrl("http://10.0.0.9:3002/api/execute"),
      ).rejects.toThrow(/private-lan|SSRF|拒绝/);
    });

    it("**refuses** private LAN 172.16-31.x by default（R05，同上）", async () => {
      await expect(
        assertSafeExecutorUrl("http://172.20.0.5:3002/api/execute"),
      ).rejects.toThrow(/private-lan|SSRF|拒绝/);
    });

    it("**refuses** private LAN 192.168.x by default（R05，同上）", async () => {
      await expect(
        assertSafeExecutorUrl("http://192.168.1.100:3002/api/config/reload"),
      ).rejects.toThrow(/private-lan|SSRF|拒绝/);
    });

    it("**refuses** IPv6 unique-local fc00::/7 by default（2026-11-05 契约归类修正）", async () => {
      // ⚠️ 本条原断言「放行」（旧口径：ULA 归 private-lan）。契约
      // `networkPolicy.addresses.linkLocal` 明确写「fc00::/7（ULA，**含 AWS IPv6 元数据
      // `fd00:ec2::254`**）」且 `allowedUnderPrivateNetwork: false` ⇒ **恒拒**。
      // 旧分类的实测后果：`http://[fd00:ec2::254]/latest/` 在**两种开关状态都被放行** ⇒
      // IPv6 云元数据可达（dispatch / broadcast / package push / gitRepo 全走这条闸）。
      await expect(
        assertSafeExecutorUrl("http://[fd00::5]:3002/api/execute"),
      ).rejects.toThrow(/SSRF|拒绝|denied/i);
    });

    it("allows public IPs", async () => {
      await expect(
        assertSafeExecutorUrl("http://93.184.216.34:3002/api/execute"),
      ).resolves.toBeInstanceOf(URL);
    });

    // V3 (round-7): benchmark (RFC 2544) and CGNAT (RFC 6598) ranges follow
    // the loopback rule for executor traffic — refused by default.
    it("blocks RFC 2544 benchmark 198.18.0.0/15 by default", async () => {
      await expect(
        assertSafeExecutorUrl("http://198.18.0.1:3002/api/execute"),
      ).rejects.toThrow(/restricted/);
      await expect(
        assertSafeExecutorUrl("http://198.19.255.254:3002/api/execute"),
      ).rejects.toThrow(/restricted/);
    });

    it("blocks CGNAT 100.64.0.0/10 by default", async () => {
      await expect(
        assertSafeExecutorUrl("http://100.64.0.5:3002/api/execute"),
      ).rejects.toThrow(/restricted/);
      await expect(
        assertSafeExecutorUrl("http://100.127.255.254:3002/api/execute"),
      ).rejects.toThrow(/restricted/);
    });
  });

  describe("EXECUTOR_ALLOW_PRIVATE_NETWORK=true", () => {
    beforeEach(() => {
      process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = "true";
    });

    // R05（2026-11-05）：契约 `networkPolicy.addresses.loopback.allowedUnderPrivateNetwork`
    // = **false**，`switch.semantics`「开关开启 ⇒ 放行 privateIPv4，**其余一律仍拒**」，
    // `switch.$comment` 原文「loopback（打自己回环）… 在任何开关状态下都拒」
    // ⇒ 此前「开关解锁 loopback」与契约相反（四向检查 `grid:loopback@on:admin`）。
    it("**STILL refuses** loopback 127.0.0.1 under the flag（开关不解锁回环）", async () => {
      await expect(
        assertSafeExecutorUrl("http://127.0.0.1:8001/api/execute"),
      ).rejects.toThrow(/loopback/);
    });

    it("**STILL refuses** IPv6 loopback ::1 under the flag", async () => {
      await expect(
        assertSafeExecutorUrl("http://[::1]:8001/"),
      ).rejects.toThrow(/loopback/);
    });

    it("allows private LAN under the flag（契约 privateIPv4.allowedUnderPrivateNetwork=true）", async () => {
      for (const url of [
        "http://10.0.0.9:3002/api/execute",
        "http://172.20.0.5:3002/api/execute",
        "http://192.168.1.100:3002/api/config/reload",
      ]) {
        await expect(assertSafeExecutorUrl(url)).resolves.toBeInstanceOf(URL);
      }
    });

    it("STILL blocks metadata / link-local even when private network allowed", async () => {
      await expect(
        assertSafeExecutorUrl("http://169.254.169.254:80/latest"),
      ).rejects.toThrow();
      await expect(
        assertSafeExecutorUrl("http://0.0.0.0:3002/"),
      ).rejects.toThrow();
    });

    // R01（2026-11-05）：**本条此前断言「放行」**（旧口径：`restricted` 跟 loopback 同档，
    // 开关开启即解锁）。契约 `networkPolicy.addresses.cgnat.allowedUnderPrivateNetwork`
    // = **false**，且 node/python 两侧**两态都拒** ⇒ admin 是唯一离群者（真四向检查实测
    // `grid:cgnat@on:admin` 不一致）。`restricted` 的另一成员 198.18.0.0/15（RFC 2544）
    // 属 IANA special-purpose，契约 `reserved` 口径同样恒拒。
    // 后果（为什么不是策略偏好）：`100.64.0.0/10` 含**阿里云元数据 `100.100.100.200`**，
    // 且 `::ffff:100.64.0.1` 经 `normalizeIpForClassification` 折回 IPv4 后同样落
    // `restricted` ⇒ 开关一开，dispatch / broadcast / reload-config / package push
    // 四条出站面都能打 CGNAT 段里的元数据端点。
    it("STILL blocks CGNAT / RFC2544 under the flag (contract: cgnat never unlocked)", async () => {
      for (const url of [
        "http://100.64.0.5:3002/api/execute",
        "http://100.127.255.254:3002/api/execute",
        "http://198.18.0.1:3002/api/execute",
        "http://198.19.255.254:3002/api/execute",
      ]) {
        await expect(assertSafeExecutorUrl(url)).rejects.toThrow(/restricted/);
      }
      // R08/ADR-029：阿里云元数据 100.100.100.200 走**元数据恒拒**这条更早的判定
      // （错误标签为 reserved，不再带 restricted 字样）⇒ 只断言"拒"，精确语义由
      // ssrf-deny-matrix 的「R08 — 元数据地址恒拒」那组用例钉住。
      await expect(
        assertSafeExecutorUrl("http://100.100.100.200:3002/api/execute"),
      ).rejects.toThrow();
    });
  });

  // V3 (round-7): the notification/AI guard (assertSafeHttpUrl) blocks these
  // ranges outright — no env flag relaxes it (verified in round-7 e2e §1.4).
  describe("assertSafeHttpUrl — V3 deny-list additions", () => {
    it("blocks RFC 2544 benchmark 198.18.0.0/15 (the round-7 TUN bypass)", async () => {
      await expect(
        assertSafeHttpUrl("http://198.18.0.1:9999/webhook"),
      ).rejects.toThrow(/拒绝名单/);
      await expect(
        assertSafeHttpUrl("http://198.19.0.1/webhook"),
      ).rejects.toThrow(/拒绝名单/);
    });

    it("blocks CGNAT 100.64.0.0/10 (Tailscale range)", async () => {
      await expect(
        assertSafeHttpUrl("http://100.64.0.1/webhook"),
      ).rejects.toThrow(/拒绝名单/);
      await expect(
        assertSafeHttpUrl("http://100.127.255.254/webhook"),
      ).rejects.toThrow(/拒绝名单/);
    });

    it("keeps adjacent public ranges reachable (no over-block)", async () => {
      await expect(
        assertSafeHttpUrl("http://198.17.0.1/webhook"),
      ).resolves.toBeInstanceOf(URL);
      await expect(
        assertSafeHttpUrl("http://198.20.0.1/webhook"),
      ).resolves.toBeInstanceOf(URL);
      await expect(
        assertSafeHttpUrl("http://100.128.0.1/webhook"),
      ).resolves.toBeInstanceOf(URL);
      await expect(
        assertSafeHttpUrl("http://100.63.255.1/webhook"),
      ).resolves.toBeInstanceOf(URL);
    });
  });

  // ARCH-31（2026-09-13）: opts.allowPrivateNetwork 私网豁免矩阵。
  // R66 起与契约 `networkPolicy.switch.semantics` 逐类同构：开关只解锁
  // `private-lan`；loopback / link-local / restricted(cgnat+benchmark) / reserved
  // 任何开关状态都拒。缺省行为零变化（除 public 外全拒）。
  describe("assertSafeHttpUrl — allowPrivateNetwork option (ARCH-31)", () => {
    it("default (no opts) keeps the blanket posture — loopback/private-LAN refused", async () => {
      await expect(assertSafeHttpUrl("http://127.0.0.1:9000")).rejects.toThrow(
        /拒绝名单/,
      );
      await expect(assertSafeHttpUrl("http://10.0.0.5/admin")).rejects.toThrow(
        /拒绝名单/,
      );
    });

    // R66：开关的**唯一**效果是解锁 `private-lan`（契约 switch.semantics）。
    // loopback / CGNAT / benchmark 在契约里 `allowedUnderPrivateNetwork=false`
    // ⇒ 任何开关状态都拒。此前此用例断言它们「放行」（比契约宽两类）。
    it("allow=true admits private-LAN only（契约口径：只解锁 privateIPv4）", async () => {
      const allow = { allowPrivateNetwork: true };
      await expect(
        assertSafeHttpUrl("http://10.0.0.5/admin", allow),
      ).resolves.toBeInstanceOf(URL);
      await expect(
        assertSafeHttpUrl("http://172.16.0.1/admin", allow),
      ).resolves.toBeInstanceOf(URL);
      await expect(
        assertSafeHttpUrl("http://192.168.1.10/admin", allow),
      ).resolves.toBeInstanceOf(URL);
    });

    it("allow=true **STILL refuses** loopback / CGNAT / benchmark（契约恒拒三类）", async () => {
      const allow = { allowPrivateNetwork: true };
      for (const url of [
        "http://127.0.0.1:11434",
        "http://[::1]:9000",
        "http://100.64.0.1/webhook",
        "http://198.18.0.1:9999/webhook",
      ]) {
        await expect(assertSafeHttpUrl(url, allow)).rejects.toThrow(/拒绝名单/);
      }
    });

    it("allow=true still refuses link-local cloud-metadata and reserved classes", async () => {
      const allow = { allowPrivateNetwork: true };
      await expect(
        assertSafeHttpUrl("http://169.254.169.254/latest", allow),
      ).rejects.toThrow(/拒绝名单/);
      await expect(
        assertSafeHttpUrl("http://0.0.0.0:9000", allow),
      ).rejects.toThrow(/拒绝名单/);
    });
  });

  it("existing webhook/AI policy (assertSafeHttpUrl) is unchanged — private LAN stays blocked there", async () => {
    await expect(assertSafeHttpUrl("http://10.0.0.5/admin")).rejects.toThrow();
    await expect(assertSafeHttpUrl("http://127.0.0.1:9000")).rejects.toThrow();
    await expect(
      assertSafeHttpUrl("http://169.254.169.254/latest"),
    ).rejects.toThrow();
  });
});

/**
 * N25 (round-8): IPv4-mapped IPv6 literals used to slip through both
 * classifiers — `split(".")` produced NaN for every IPv4 rule and the
 * address fell through to "public". normalizeIpForClassification folds
 * them back to the embedded IPv4 before classification.
 */
describe("safe-http.util — N25 IPv4-mapped IPv6 normalization", () => {
  const PRIVATE = process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;
  afterEach(() => {
    if (PRIVATE === undefined)
      delete process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;
    else process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = PRIVATE;
    mockedLookup.mockReset();
  });

  describe("normalizeIpForClassification", () => {
    it("extracts the embedded IPv4 from ::ffff:0:0/96 literals (dotted and hex forms)", () => {
      expect(normalizeIpForClassification("::ffff:127.0.0.1")).toBe(
        "127.0.0.1",
      );
      expect(normalizeIpForClassification("::ffff:7f00:1")).toBe("127.0.0.1");
      expect(normalizeIpForClassification("::ffff:169.254.169.254")).toBe(
        "169.254.169.254",
      );
      expect(normalizeIpForClassification("::ffff:a9fe:a9fe")).toBe(
        "169.254.169.254",
      );
      expect(normalizeIpForClassification("::ffff:10.0.0.1")).toBe("10.0.0.1");
      expect(normalizeIpForClassification("::ffff:198.18.0.1")).toBe(
        "198.18.0.1",
      );
      expect(normalizeIpForClassification("::ffff:8.8.8.8")).toBe("8.8.8.8");
      expect(normalizeIpForClassification("0:0:0:0:0:ffff:808:808")).toBe(
        "8.8.8.8",
      );
      expect(normalizeIpForClassification("::ffff:0:0")).toBe("0.0.0.0");
    });

    it("folds deprecated IPv4-compatible (::/96) literals but keeps :: and ::1", () => {
      expect(normalizeIpForClassification("::127.0.0.1")).toBe("127.0.0.1");
      expect(normalizeIpForClassification("::7f00:1")).toBe("127.0.0.1");
      expect(normalizeIpForClassification("::1")).toBe("::1");
      expect(normalizeIpForClassification("::")).toBe("::");
    });

    it("leaves pure IPv6, IPv4 and non-IP strings untouched", () => {
      expect(normalizeIpForClassification("fe80::1")).toBe("fe80::1");
      expect(normalizeIpForClassification("fd00::5")).toBe("fd00::5");
      expect(normalizeIpForClassification("2001:db8::1")).toBe("2001:db8::1");
      expect(normalizeIpForClassification("ff02::1")).toBe("ff02::1");
      expect(normalizeIpForClassification("10.0.0.1")).toBe("10.0.0.1");
      expect(normalizeIpForClassification("93.184.216.34")).toBe(
        "93.184.216.34",
      );
      expect(normalizeIpForClassification("example.com")).toBe("example.com");
    });
  });

  describe("assertSafeExecutorUrl — mapped literals reach the IPv4 rules", () => {
    it("blocks mapped cloud metadata (dotted and WHATWG-normalized hex form)", async () => {
      await expect(
        assertSafeExecutorUrl("http://[::ffff:169.254.169.254]:80/latest"),
      ).rejects.toThrow(/link-local/);
      await expect(
        assertSafeExecutorUrl("http://[::ffff:a9fe:a9fe]/"),
      ).rejects.toThrow(/link-local/);
    });

    it("maps ::ffff:127.0.0.1 to loopback — **两种开关状态都拒**（R05：契约 loopback 恒拒）", async () => {
      await expect(
        assertSafeExecutorUrl("http://[::ffff:127.0.0.1]:3002/"),
      ).rejects.toThrow(/loopback/);
      await expect(
        assertSafeExecutorUrl("http://[::ffff:7f00:1]:3002/"),
      ).rejects.toThrow(/loopback/);
      process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = "true";
      await expect(
        assertSafeExecutorUrl("http://[::ffff:127.0.0.1]:3002/"),
      ).rejects.toThrow(/loopback/);
    });

    it("blocks mapped benchmark/CGNAT as restricted (unlocked by nothing on the executor path)", async () => {
      await expect(
        assertSafeExecutorUrl("http://[::ffff:198.18.0.1]:3002/"),
      ).rejects.toThrow(/restricted/);
      await expect(
        assertSafeExecutorUrl("http://[::ffff:6440:5]:3002/"),
      ).rejects.toThrow(/restricted/);
      // R01：开关开启后**仍然拒**（契约 cgnat.allowedUnderPrivateNetwork=false；
      // node/python 两态都拒）。映射形态按内嵌 IPv4 判定 ⇒ 与裸 `100.64.0.5` 同档。
      process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = "true";
      await expect(
        assertSafeExecutorUrl("http://[::ffff:198.18.0.1]:3002/"),
      ).rejects.toThrow(/restricted/);
      await expect(
        assertSafeExecutorUrl("http://[::ffff:6440:5]:3002/"),
      ).rejects.toThrow(/restricted/);
    });

    it("mapped private-LAN follows the switch（默认拒 / 开开关放行）；mapped public 恒放行", async () => {
      // R05：映射形态按内嵌 IPv4 判定 ⇒ 内嵌私网与裸私网同档（契约 privateIPv4=true）。
      await expect(
        assertSafeExecutorUrl("http://[::ffff:10.0.0.1]:3002/"),
      ).rejects.toThrow(/private-lan|SSRF|拒绝/);
      await expect(
        assertSafeExecutorUrl("http://[::ffff:a00:1]:3002/"),
      ).rejects.toThrow(/private-lan|SSRF|拒绝/);
      await expect(
        assertSafeExecutorUrl("http://[::ffff:8.8.8.8]:3002/"),
      ).resolves.toBeInstanceOf(URL);
      process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = "true";
      await expect(
        assertSafeExecutorUrl("http://[::ffff:10.0.0.1]:3002/"),
      ).resolves.toBeInstanceOf(URL);
      await expect(
        assertSafeExecutorUrl("http://[::ffff:a00:1]:3002/"),
      ).resolves.toBeInstanceOf(URL);
    });

    it("pure IPv6 behaviour: ::1 loopback / fe80::1 link-local / **fd00::1 (ULA) 全部拒绝**", async () => {
      // 2026-11-05 契约归类修正：ULA 原归 private-lan（执行器姿态放行），契约归
      // linkLocal 且 `allowedUnderPrivateNetwork: false` ⇒ **恒拒**。旧行为的实测后果是
      // `http://[fd00:ec2::254]/latest/`（**AWS IPv6 元数据**）在两种开关状态下都被放行。
      await expect(assertSafeExecutorUrl("http://[::1]:3002/")).rejects.toThrow(
        /loopback/,
      );
      await expect(
        assertSafeExecutorUrl("http://[fe80::1]:3002/"),
      ).rejects.toThrow(/link-local/);
      await expect(
        assertSafeExecutorUrl("http://[fd00::1]:3002/"),
      ).rejects.toThrow(/link-local/);
    });
  });

  describe("assertSafeHttpUrl — DNS answers carrying mapped literals (isBlockedAddress path)", () => {
    it("blocks a hostname resolving to ::ffff:169.254.169.254", async () => {
      mockedLookup.mockResolvedValue([
        { address: "::ffff:169.254.169.254", family: 6 },
      ]);
      await expect(
        assertSafeHttpUrl("http://evil.example.com/webhook"),
      ).rejects.toThrow(/解析到被阻断的地址/);
    });

    it("blocks mapped loopback / private / benchmark DNS answers", async () => {
      for (const addr of [
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "::ffff:198.18.0.1",
        "::ffff:7f00:1",
      ]) {
        mockedLookup.mockResolvedValue([{ address: addr, family: 6 }]);
        await expect(
          assertSafeHttpUrl("http://evil.example.com/webhook"),
        ).rejects.toThrow(/解析到被阻断的地址/);
      }
    });

    it("still allows a hostname resolving to a mapped PUBLIC address", async () => {
      mockedLookup.mockResolvedValue([
        { address: "::ffff:8.8.8.8", family: 6 },
      ]);
      await expect(
        assertSafeHttpUrl("http://ok.example.com/webhook"),
      ).resolves.toBeInstanceOf(URL);
    });

    it("blocks pure IPv6 dangers via DNS (::1, fe80::1, fd00::1)", async () => {
      for (const addr of ["::1", "fe80::1", "fd00::1"]) {
        mockedLookup.mockResolvedValue([{ address: addr, family: 6 }]);
        await expect(
          assertSafeHttpUrl("http://evil.example.com/webhook"),
        ).rejects.toThrow(/解析到被阻断的地址/);
      }
    });
  });

  describe("assertAndPinHttpUrl — pinned IP selection (F-3 pinning)", () => {
    afterEach(() => mockedLookup.mockReset());

    it("prefers an IPv4 answer over IPv6 when both resolve (dual-stack)", async () => {
      // R05：原用例用 `localhost`（loopback）—— 契约下 loopback **恒拒**，故改用
      // 「公网 IPv6 + 私网 IPv4」的双栈组合验证 pin 选择：两者在开关开启时都放行。
      mockedLookup.mockResolvedValue([
        { address: "2606:4700:4700::1111", family: 6 },
        { address: "10.0.0.5", family: 4 },
      ]);
      process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = "true";
      const target = await assertAndPinHttpUrl(
        "http://dualstack.internal:8002/api/execute",
        { policy: "executor" },
      );
      expect(target.pinned).toBe(true);
      // IPv6 comes first from DNS, but the pin must pick the IPv4 answer —
      // dual-stack services of this shape usually listen on IPv4 only.
      expect(target.pinnedIp).toBe("10.0.0.5");
      delete process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;
    });

    it("keeps the only (IPv6) answer when no IPv4 resolves（用 **公网** IPv6，ULA 现已恒拒）", async () => {
      // 2026-11-05：本条原用 `fd00::1`（ULA）当"唯一 IPv6 答案"。ULA 改归 linkLocal
      // 后它会被拒 ⇒ 改用文档化公网 IPv6（2001:db8::/32 是 RFC 3849 文档前缀，不路由，
      // 但对**纯分类/固化**逻辑足够，且本用例只测 pinning 的选择行为）。
      mockedLookup.mockResolvedValue([{ address: "2606:4700:4700::1111", family: 6 }]);
      const target = await assertAndPinHttpUrl(
        "http://ipv6-only.example.com/x",
        {
          policy: "executor",
        },
      );
      expect(target.pinned).toBe(true);
      expect(target.pinnedIp).toBe("2606:4700:4700::1111");
    });

    it("pinnedAxiosConfig lookup honors Node>=22 all:true (array shape)", async () => {
      // R05：原用 `10.0.0.5`（私网）—— 契约下私网默认拒，而本用例测的是 agent 的
      // lookup 形状（与姿态无关）⇒ 改用**公网**字面量，保持断言意图不变。
      const target = await assertAndPinHttpUrl(
        "http://93.184.216.34:3002/api/execute",
        {
          policy: "executor",
        },
      );
      // Host was an IP literal → pinned:false, no custom agent.
      expect(target.pinned).toBe(false);

      // Build a synthetic pinned target to exercise the agent's lookup.
      const url = new URL("http://10.0.0.5:3002/api/execute");
      const cfg = pinnedAxiosConfig({
        url,
        pinnedIp: "10.0.0.5",
        pinned: true,
      });
      expect(cfg.httpAgent).toBeDefined();
      const lookup = (
        cfg.httpAgent as unknown as {
          options: {
            lookup: (
              h: string,
              o: { all?: boolean },
              cb: (err: Error | null, res?: unknown, family?: number) => void,
            ) => void;
          };
        }
      ).options.lookup;
      expect(lookup).toBeDefined();

      let allShape: unknown = null;
      let scalarShape: unknown = null;
      let scalarFamily: unknown = null;
      lookup("10.0.0.5", { all: true }, (err, res) => {
        allShape = res;
      });
      lookup("10.0.0.5", { all: false }, (err, res, family) => {
        scalarShape = res;
        scalarFamily = family;
      });
      // all:true → array of {address, family} (Node>=22 lookupAndConnect)
      expect(allShape).toEqual([{ address: "10.0.0.5", family: 4 }]);
      // all:false/omitted → scalar (addr, family) legacy shape
      expect(scalarShape).toBe("10.0.0.5");
      expect(scalarFamily).toBe(4);
    });
  });
});

/**
 * R4: git-repo SSRF guard (deployFromGit clone target). Policy: public and
 * private-LAN allowed (self-hosted GitLab topology); loopback / link-local /
 * metadata / reserved / benchmark / CGNAT / IPv6-ULA refused; all three repo
 * URL shapes (https, ssh://, scp-like git@host:path) covered.
 */
describe("safe-http.util — assertSafeGitRepoUrl (R4)", () => {
  afterEach(() => mockedLookup.mockReset());

  it("allows a public https repo (hostname resolving to a public IP)", async () => {
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(
      assertSafeGitRepoUrl("https://github.com/org/repo.git"),
    ).resolves.toBeUndefined();
  });

  it("allows a private-LAN git host (self-hosted GitLab topology)", async () => {
    mockedLookup.mockResolvedValue([{ address: "10.0.0.42", family: 4 }]);
    await expect(
      assertSafeGitRepoUrl("https://gitlab.internal/org/repo.git"),
    ).resolves.toBeUndefined();
  });

  it("blocks cloud metadata via DNS answer", async () => {
    mockedLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(
      assertSafeGitRepoUrl("http://evil.example.com/r.git"),
    ).rejects.toThrow(/link-local.*已拒绝克隆|已拒绝克隆/);
  });

  it("blocks loopback IP literal in https form", async () => {
    await expect(
      assertSafeGitRepoUrl("http://127.0.0.1:3000/r.git"),
    ).rejects.toThrow(/loopback/);
  });

  it("blocks IPv6 loopback literal in ssh:// form", async () => {
    await expect(assertSafeGitRepoUrl("ssh://git@[::1]/r.git")).rejects.toThrow(
      /loopback/,
    );
  });

  it("blocks loopback in scp-like git@host:path form", async () => {
    await expect(
      assertSafeGitRepoUrl("git@127.0.0.1:org/repo.git"),
    ).rejects.toThrow(/loopback/);
  });

  it("blocks CGNAT / benchmark ranges (Tailscale/TUN overlays)", async () => {
    for (const addr of ["100.64.0.1", "198.18.0.1"]) {
      mockedLookup.mockResolvedValue([{ address: addr, family: 4 }]);
      await expect(
        assertSafeGitRepoUrl("https://overlay.example.com/r.git"),
      ).rejects.toThrow(/已拒绝克隆/);
    }
  });

  it("blocks IPv6 ULA (fc00::/7) even though it classifies as private-lan", async () => {
    mockedLookup.mockResolvedValue([{ address: "fd12:3456::7", family: 6 }]);
    await expect(
      assertSafeGitRepoUrl("https://ula.example.com/r.git"),
    ).rejects.toThrow(/已拒绝克隆/);
  });

  it("blocks IPv4-mapped IPv6 metadata literal (::ffff:169.254.169.254)", async () => {
    await expect(
      assertSafeGitRepoUrl("http://[::ffff:169.254.169.254]/r.git"),
    ).rejects.toThrow(/link-local/);
  });

  it("rejects unsupported repo shapes (no https/ssh/git@ prefix)", async () => {
    await expect(assertSafeGitRepoUrl("/etc/passwd")).rejects.toThrow(
      /不支持的 Git 仓库 URL 形式/,
    );
  });

  it("rejects when the host does not resolve", async () => {
    mockedLookup.mockResolvedValue([]);
    await expect(
      assertSafeGitRepoUrl("https://nx.example.invalid/r.git"),
    ).rejects.toThrow(/无法解析/);
  });
});

/**
 * R66（ADR-032 收口最后一格）：**webhook 面的开关姿态与契约同构**。
 *
 * 契约 `networkPolicy.switch.semantics`：
 * 「开关开启 ⇒ 放行 privateIPv4；**其余五类（loopback / linkLocal / cgnat /
 * unspecified / multicast / reserved）一律仍拒**。」
 *
 * 契约七类 → admin 的 risk 类映射（见 `IPV4_DENY_SEGMENTS`）：
 *   privateIPv4 ↔ `private-lan`；cgnat ↔ `restricted`；loopback ↔ `loopback`；
 *   linkLocal ↔ `link-local`；unspecified/multicast/reserved ↔ `reserved`；
 *   ipv4Mapped 按内嵌 IPv4 判定（`normalizeIpForClassification`）。
 *
 * R66 前的 webhook 面（`safe-http.util.ts` 的 `allowedWebhook` 与
 * `assertSafeHttpUrl` 内联的同名谓词）在开关**开启**时放行
 * `private-lan` + **`loopback`** + **`restricted`(cgnat/benchmark)**
 * ⇒ 比契约宽**两类**：`loopback`（契约 `allowedUnderPrivateNetwork=false`）与
 * `cgnat`（同上 false；`restricted` 的另一成员 198.18/15 是 benchmark，
 * 契约亦归 `reserved` 语义）。
 *
 * 本 describe 逐类钉住契约口径（**关**态恒放行 public、其余全拒；
 * **开**态只多放行 private-lan）。恒拒表（`metadataAddresses`）优先于
 * 一切 posture —— 那是 ADR-029 的硬要求，本轮不动它的位置，只钉住它。
 */
describe("R66 — webhook 面姿态与契约逐类同构", () => {
  /** IPv6 字面量在 URL 里必须带方括号（`new URL` 的硬要求）。 */
  const urlOf = (host: string): string =>
    `http://${host.includes(":") ? `[${host}]` : host}/hook`;

  /** 契约七类 → 一个代表地址（ipv4Mapped 的判定按内嵌 IPv4 走同一路径）。 */
  const CONTRACT_CLASSES: ReadonlyArray<
    readonly [contractClass: string, host: string, allowedUnderSwitch: boolean]
  > = [
    ["public", "93.184.216.34", true],
    ["privateIPv4", "10.0.0.5", true],
    ["loopback", "127.0.0.1", false],
    ["linkLocal", "169.254.1.1", false],
    ["cgnat", "100.64.0.1", false],
    ["unspecified", "0.0.0.0", false],
    ["multicast", "224.0.0.1", false],
    ["reserved", "240.0.0.1", false],
    ["ipv4Mapped(privateIPv4)", "::ffff:10.0.0.5", true],
    ["ipv4Mapped(loopback)", "::ffff:127.0.0.1", false],
  ];

  it("开关关闭：public 放行，其余七类全拒", async () => {
    for (const [cls, host] of CONTRACT_CLASSES) {
      const verdict = await assertSafeHttpUrl(urlOf(host)).then(
        () => "allowed",
        () => "denied",
      );
      expect([cls, host, verdict]).toEqual(
        cls === "public" ? [cls, host, "allowed"] : [cls, host, "denied"],
      );
    }
  });

  it("开关开启：**只**多放行 privateIPv4（含其 ipv4Mapped 形态）", async () => {
    const allow = { allowPrivateNetwork: true };
    for (const [cls, host, allowedUnderSwitch] of CONTRACT_CLASSES) {
      const verdict = await assertSafeHttpUrl(urlOf(host), allow).then(
        () => "allowed",
        () => "denied",
      );
      expect([cls, host, verdict]).toEqual(
        [cls, host, allowedUnderSwitch ? "allowed" : "denied"],
      );
    }
  });

  it("恒拒表（metadataAddresses）优先于开关：两个厂商端点任何姿态都拒", async () => {
    // 契约 metadataAddresses 的两个成员：阿里云 100.100.100.200 / Oracle 192.0.0.192
    for (const host of ["100.100.100.200", "192.0.0.192"]) {
      await expect(assertSafeHttpUrl(urlOf(host))).rejects.toThrow();
      await expect(
        assertSafeHttpUrl(urlOf(host), { allowPrivateNetwork: true }),
      ).rejects.toThrow();
    }
  });

  it("恒拒表是**独立一层**：判定先于风险分类（摘掉任一层都必须露出来）", async () => {
    // 探针设计（ADR-029 的硬要求 ②）：恒拒判定必须在**风险分类之前**。
    // admin 侧实测两个厂商端点的分类结果是 `reserved`（而 `reserved` 在契约里
    // 任何开关状态都拒）⇒ 只断言「被拒」**测不出**任何短路 —— 这就是「双层
    // 防御」带来的盲区：两层都在 ⇒ 结果相同。
    //
    // 可观测的差异只有一处：**分类层被摘掉后，元数据地址会落进哪个类**。
    // 若 `classifyAddressRisk` 里的 metadata 分支存在，它返回 `reserved`；
    // 把它短路掉，100.100.100.200 就会落进 `restricted`（CGNAT 100.64/10）——
    // 而 `restricted` **在旧姿态下是随开关放行的** ⇒ 那正是 ADR-029 判定的
    // 「R07 成因形态」。因此这里断言**分类层的具体归类**：
    //   · 元数据端点被分类为 `reserved`（恒拒层把它钉在这里）；
    //   · 同段内非元数据地址仍按契约归类（100.64.0.1 → restricted）。
    // 短路分类层的 metadata 分支 ⇒ 第一条断言红（落成 restricted）。
    expect(classifyAddressRisk("100.100.100.200")).toBe("reserved");
    expect(classifyAddressRisk("192.0.0.192")).toBe("reserved");
    expect(classifyAddressRisk("100.64.0.1")).toBe("restricted");
    // 恒拒层的独立判定：元数据成员为真，非元数据成员为假。
    expect(isMetadataAddress("100.100.100.200")).toBe(true);
    expect(isMetadataAddress("169.254.169.254")).toBe(false);
  });

  it("webhook 出站面（assertAndPinHttpUrl 的 webhook policy）同格", async () => {
    // 通知渠道（slack/dingtalk/飞书/企微/webhook + 事件订阅出站）走的正是它。
    for (const host of ["127.0.0.1", "100.64.0.1", "169.254.1.1"]) {
      await expect(
        assertAndPinHttpUrl(urlOf(host), {
          allowPrivateNetwork: true,
          policy: "webhook",
        }),
      ).rejects.toThrow();
    }
    await expect(
      assertAndPinHttpUrl(urlOf("10.0.0.5"), {
        allowPrivateNetwork: true,
        policy: "webhook",
      }),
    ).resolves.toBeDefined();
  });
});
