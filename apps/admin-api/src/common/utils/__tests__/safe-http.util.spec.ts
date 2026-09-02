import {
  assertSafeHttpUrl,
  assertSafeExecutorUrl,
} from "../safe-http.util";

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
    if (PRIVATE === undefined) delete process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;
    else process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = PRIVATE;
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
      await expect(
        assertSafeExecutorUrl("file:///etc/passwd"),
      ).rejects.toThrow(/http\(s\)/);
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
      await expect(assertSafeExecutorUrl("http://[::1]:8001/")).resolves.toBeInstanceOf(
        URL,
      );
    });

    it("STILL blocks metadata / link-local even when private network allowed", async () => {
      await expect(
        assertSafeExecutorUrl("http://169.254.169.254:80/latest"),
      ).rejects.toThrow();
      await expect(
        assertSafeExecutorUrl("http://0.0.0.0:3002/"),
      ).rejects.toThrow();
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
