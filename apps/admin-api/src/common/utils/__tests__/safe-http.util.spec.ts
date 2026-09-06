import {
  assertSafeHttpUrl,
  assertSafeExecutorUrl,
  assertSafeGitRepoUrl,
  normalizeIpForClassification,
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
      ).rejects.toThrow(/credentials/);
    });

    it("allows private LAN 10.x by default (docker-compose internal topology)", async () => {
      await expect(
        assertSafeExecutorUrl("http://10.0.0.9:3002/api/execute"),
      ).resolves.toBeInstanceOf(URL);
    });

    it("allows private LAN 172.16-31.x by default", async () => {
      await expect(
        assertSafeExecutorUrl("http://172.20.0.5:3002/api/execute"),
      ).resolves.toBeInstanceOf(URL);
    });

    it("allows private LAN 192.168.x by default", async () => {
      await expect(
        assertSafeExecutorUrl("http://192.168.1.100:3002/api/config/reload"),
      ).resolves.toBeInstanceOf(URL);
    });

    it("allows IPv6 unique-local fc00::/7 by default (private-lan class)", async () => {
      await expect(
        assertSafeExecutorUrl("http://[fd00::5]:3002/api/execute"),
      ).resolves.toBeInstanceOf(URL);
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

    it("allows loopback 127.0.0.1 (same-host dev deployment)", async () => {
      await expect(
        assertSafeExecutorUrl("http://127.0.0.1:8001/api/execute"),
      ).resolves.toBeInstanceOf(URL);
    });

    it("allows IPv6 loopback ::1", async () => {
      await expect(
        assertSafeExecutorUrl("http://[::1]:8001/"),
      ).resolves.toBeInstanceOf(URL);
    });

    it("STILL blocks metadata / link-local even when private network allowed", async () => {
      await expect(
        assertSafeExecutorUrl("http://169.254.169.254:80/latest"),
      ).rejects.toThrow();
      await expect(
        assertSafeExecutorUrl("http://0.0.0.0:3002/"),
      ).rejects.toThrow();
    });

    it("allows benchmark/CGNAT ranges under the private-network flag (loopback-like semantics)", async () => {
      await expect(
        assertSafeExecutorUrl("http://198.18.0.1:3002/api/execute"),
      ).resolves.toBeInstanceOf(URL);
      await expect(
        assertSafeExecutorUrl("http://100.64.0.5:3002/api/execute"),
      ).resolves.toBeInstanceOf(URL);
    });
  });

  // V3 (round-7): the notification/AI guard (assertSafeHttpUrl) blocks these
  // ranges outright — no env flag relaxes it (verified in round-7 e2e §1.4).
  describe("assertSafeHttpUrl — V3 deny-list additions", () => {
    it("blocks RFC 2544 benchmark 198.18.0.0/15 (the round-7 TUN bypass)", async () => {
      await expect(
        assertSafeHttpUrl("http://198.18.0.1:9999/webhook"),
      ).rejects.toThrow(/deny list/);
      await expect(
        assertSafeHttpUrl("http://198.19.0.1/webhook"),
      ).rejects.toThrow(/deny list/);
    });

    it("blocks CGNAT 100.64.0.0/10 (Tailscale range)", async () => {
      await expect(
        assertSafeHttpUrl("http://100.64.0.1/webhook"),
      ).rejects.toThrow(/deny list/);
      await expect(
        assertSafeHttpUrl("http://100.127.255.254/webhook"),
      ).rejects.toThrow(/deny list/);
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

    it("maps ::ffff:127.0.0.1 to loopback — blocked by default, gated by EXECUTOR_ALLOW_PRIVATE_NETWORK", async () => {
      await expect(
        assertSafeExecutorUrl("http://[::ffff:127.0.0.1]:3002/"),
      ).rejects.toThrow(/loopback/);
      await expect(
        assertSafeExecutorUrl("http://[::ffff:7f00:1]:3002/"),
      ).rejects.toThrow(/loopback/);
      process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = "true";
      await expect(
        assertSafeExecutorUrl("http://[::ffff:127.0.0.1]:3002/"),
      ).resolves.toBeInstanceOf(URL);
    });

    it("blocks mapped benchmark/CGNAT as restricted (same gate as loopback)", async () => {
      await expect(
        assertSafeExecutorUrl("http://[::ffff:198.18.0.1]:3002/"),
      ).rejects.toThrow(/restricted/);
      await expect(
        assertSafeExecutorUrl("http://[::ffff:6440:5]:3002/"),
      ).rejects.toThrow(/restricted/);
      process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = "true";
      await expect(
        assertSafeExecutorUrl("http://[::ffff:198.18.0.1]:3002/"),
      ).resolves.toBeInstanceOf(URL);
    });

    it("mapped private-LAN stays allowed; mapped public stays public", async () => {
      await expect(
        assertSafeExecutorUrl("http://[::ffff:10.0.0.1]:3002/"),
      ).resolves.toBeInstanceOf(URL);
      await expect(
        assertSafeExecutorUrl("http://[::ffff:a00:1]:3002/"),
      ).resolves.toBeInstanceOf(URL);
      await expect(
        assertSafeExecutorUrl("http://[::ffff:8.8.8.8]:3002/"),
      ).resolves.toBeInstanceOf(URL);
    });

    it("pure IPv6 behaviour does not regress: ::1 loopback, fe80::1 link-local blocked; fd00::1 private-lan allowed", async () => {
      await expect(assertSafeExecutorUrl("http://[::1]:3002/")).rejects.toThrow(
        /loopback/,
      );
      await expect(
        assertSafeExecutorUrl("http://[fe80::1]:3002/"),
      ).rejects.toThrow(/link-local/);
      await expect(
        assertSafeExecutorUrl("http://[fd00::1]:3002/"),
      ).resolves.toBeInstanceOf(URL);
    });
  });

  describe("assertSafeHttpUrl — DNS answers carrying mapped literals (isBlockedAddress path)", () => {
    it("blocks a hostname resolving to ::ffff:169.254.169.254", async () => {
      mockedLookup.mockResolvedValue([
        { address: "::ffff:169.254.169.254", family: 6 },
      ]);
      await expect(
        assertSafeHttpUrl("http://evil.example.com/webhook"),
      ).rejects.toThrow(/blocked address/);
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
        ).rejects.toThrow(/blocked address/);
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
        ).rejects.toThrow(/blocked address/);
      }
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
    ).rejects.toThrow(/link-local.*clone refused|clone refused/);
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
      ).rejects.toThrow(/clone refused/);
    }
  });

  it("blocks IPv6 ULA (fc00::/7) even though it classifies as private-lan", async () => {
    mockedLookup.mockResolvedValue([{ address: "fd12:3456::7", family: 6 }]);
    await expect(
      assertSafeGitRepoUrl("https://ula.example.com/r.git"),
    ).rejects.toThrow(/clone refused/);
  });

  it("blocks IPv4-mapped IPv6 metadata literal (::ffff:169.254.169.254)", async () => {
    await expect(
      assertSafeGitRepoUrl("http://[::ffff:169.254.169.254]/r.git"),
    ).rejects.toThrow(/link-local/);
  });

  it("rejects unsupported repo shapes (no https/ssh/git@ prefix)", async () => {
    await expect(assertSafeGitRepoUrl("/etc/passwd")).rejects.toThrow(
      /Unsupported git repository URL shape/,
    );
  });

  it("rejects when the host does not resolve", async () => {
    mockedLookup.mockResolvedValue([]);
    await expect(
      assertSafeGitRepoUrl("https://nx.example.invalid/r.git"),
    ).rejects.toThrow(/did not resolve/);
  });
});
