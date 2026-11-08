import {
  assertSafeGitRepoUrl,
  classifyAddressRisk,
  addressRiskSegmentId,
} from "../safe-http.util";

/**
 * R3-ADMIN-WIRE · A1：admin 侧 SSRF 拒列表对 `networkPolicy` 契约的**一致性闸**。
 *
 * ## 为什么这个文件存在（而不是"改了代码 + 加了几条用例"）
 *
 * R3-ADMIN-WIRE 的 A1 任务是「把 admin 的拒列表对齐契约登记的 7 类」。
 * **实测结论：admin 侧已经对齐**——`assertSafeGitRepoUrl`
 * （`common/utils/safe-http.util.ts:685`）走真实 DNS 解析 + 统一段表
 * `SSRF_DENY_HOST_PATTERNS`，7 类全部拒绝、DNS 失败 fail-closed。
 *
 * 所以本批对 A1 的真实交付物不是"改代码"，而是**这条契约一致性闸**：
 * 把「7 类必须拒 / 2 类必须放行」钉成机器可校验的断言，使这层对齐**不再
 * 依赖实现里的注释**。契约（`packages/executor-protocol/protocol.json` 的
 * `networkPolicy.addresses`）或段表任一改动导致偏离时，这里先红。
 *
 * ## 与契约的逐条对应（`networkPolicy.addresses` 的 7 个 key）
 *
 * | 契约 key | 覆盖地址 | 本文件用例 |
 * |---|---|---|
 * | `loopback` | 127.0.0.0/8、::1、localhost | ① ② ③ |
 * | `linkLocal` | 169.254.0.0/16（含 169.254.169.254）、fe80::/10 | ④ ⑤ |
 * | `cgnat` | 100.64.0.0/10 | ⑥ |
 * | `unspecified` | 0.0.0.0、:: | ⑦ ⑧ |
 * | `multicast` | 224.0.0.0/4、ff00::/8 | ⑨ |
 * | `reserved` | 240.0.0.0/4 等 | ⑩ |
 * | `privateIPv4` | 10/8、172.16/12、192.168/16 —— **放行**（文档化拓扑） | ⑪ ⑫ ⑬ |
 * | （契约外对照） | 公网地址必须**放行**（防闸开成 deny-all） | ⑭ |
 *
 * ⚠️ 另有 `fd00:ec2::254`（IPv6 云元数据）不在契约 `addresses` 的 examples 里，
 * 但它是 `fc00::/7` ULA 的实例，git 面按 "IPv6 ULA 不是文档化 git 拓扑" 拒绝
 * （N32 姿态）⇒ 用例 ⑮ 单独钉住。
 */
describe("A1: networkPolicy 契约一致性 —— git 面 SSRF 拒列表", () => {
  /** 断言放行（不抛）。 */
  const expectAllowed = async (url: string) => {
    await expect(assertSafeGitRepoUrl(url)).resolves.toBeUndefined();
  };

  /** 断言拒绝，并返回错误码（供分类核对）。 */
  const expectDenied = async (url: string): Promise<string> => {
    await expect(assertSafeGitRepoUrl(url)).rejects.toThrow();
    try {
      await assertSafeGitRepoUrl(url);
    } catch (err) {
      const code = (err as { errorCode?: string }).errorCode;
      return code ?? "UNKNOWN_CODE";
    }
    throw new Error("unreachable");
  };

  describe("① loopback（契约 allowedUnderPrivateNetwork:false）", () => {
    it("127.0.0.1 拒绝", async () => {
      await expectDenied("http://127.0.0.1/x.git");
    });

    it("127.1.2.3（127/8 内任意地址）拒绝", async () => {
      await expectDenied("http://127.1.2.3/x.git");
    });

    it("IPv6 ::1 拒绝", async () => {
      await expectDenied("http://[::1]/x.git");
    });

    it("主机名 localhost 经 DNS 解析到 127.x 后拒绝", async () => {
      await expectDenied("http://localhost/x.git");
    });
  });

  describe("② linkLocal（含云元数据 169.254.169.254）", () => {
    it("169.254.169.254（AWS/GCP/Azure 云元数据）拒绝", async () => {
      const code = await expectDenied(
        "http://169.254.169.254/latest/meta-data/",
      );
      // 拒绝必须发生在**地址判定**层（不是 URL 形态层）——否则换个形态就溜过去
      expect(code).toBe("GIT_REPO_HOST_BLOCKED");
    });

    it("169.254.1.1（link-local 内其它地址）拒绝", async () => {
      await expectDenied("http://169.254.1.1/x.git");
    });

    it("IPv6 fe80::1 拒绝", async () => {
      await expectDenied("http://[fe80::1]/x.git");
    });
  });

  describe("③ cgnat（100.64.0.0/10 —— Python 3.12 的 is_private 也不含它）", () => {
    it("100.64.0.1 拒绝", async () => {
      await expectDenied("http://100.64.0.1/x.git");
    });

    it("100.127.255.254（/10 上界）拒绝", async () => {
      await expectDenied("http://100.127.255.254/x.git");
    });
  });

  describe("④ unspecified（0.0.0.0 / :: —— Linux 上「连本机」语义）", () => {
    it("0.0.0.0 拒绝", async () => {
      await expectDenied("http://0.0.0.0/x.git");
    });

    it("IPv6 :: 拒绝", async () => {
      await expectDenied("http://[::]/x.git");
    });
  });

  describe("⑤ multicast / reserved", () => {
    it("224.0.0.1（组播）拒绝", async () => {
      await expectDenied("http://224.0.0.1/x.git");
    });

    it("240.0.0.1（保留段）拒绝", async () => {
      await expectDenied("http://240.0.0.1/x.git");
    });
  });

  describe("⑥ 契约外但同源的 IPv6 云元数据 fd00:ec2::254（fc00::/7 ULA）", () => {
    it("拒绝（git 面不认 ULA 为文档化拓扑）", async () => {
      await expectDenied("http://[fd00:ec2::254]/x.git");
    });
  });

  describe("⑦ 对照：privateIPv4 必须**放行**（防闸开成 deny-all）", () => {
    it("10.0.0.1（10/8，内网自建 GitLab 的典型地址）放行", async () => {
      await expectAllowed("http://10.0.0.1/x.git");
    });

    it("172.16.0.1（172.16/12 下界）放行", async () => {
      await expectAllowed("http://172.16.0.1/x.git");
    });

    it("192.168.1.1（192.168/16）放行", async () => {
      await expectAllowed("http://192.168.1.1/x.git");
    });

    it("公网地址放行（不因收紧而误伤）", async () => {
      await expectAllowed("http://93.184.216.34/x.git");
    });
  });

  describe("⑧ 段表与契约 key 的映射（段 id 是判据锚点）", () => {
    it("7 类各自命中正确的段 id", () => {
      expect(addressRiskSegmentId("127.0.0.1")).toBe("ipv4-loopback");
      expect(addressRiskSegmentId("::1")).toBe("ipv6-loopback");
      expect(addressRiskSegmentId("169.254.169.254")).toBe(
        "ipv4-link-local-metadata",
      );
      expect(addressRiskSegmentId("fe80::1")).toBe("ipv6-link-local");
      expect(addressRiskSegmentId("100.64.0.1")).toBe("ipv4-cgnat");
      expect(addressRiskSegmentId("0.0.0.0")).toBe("ipv4-unspecified");
      expect(addressRiskSegmentId("::")).toBe("ipv6-unspecified");
      expect(addressRiskSegmentId("224.0.0.1")).toBe("ipv4-multicast");
      expect(addressRiskSegmentId("240.0.0.1")).toBe("ipv4-reserved");
    });

    it("privateIPv4 与公网地址**不命中任何拒绝段**", () => {
      expect(addressRiskSegmentId("10.0.0.1")).toBe("ipv4-rfc1918-10");
      expect(classifyAddressRisk("10.0.0.1")).toBe("private-lan");
      expect(addressRiskSegmentId("93.184.216.34")).toBeNull();
      expect(classifyAddressRisk("93.184.216.34")).toBe("public");
    });
  });

  describe("⑨ DNS 解析失败 fail-closed（契约 resolution.onResolutionFailure: deny）", () => {
    it("不可解析的主机名被拒（不因「解析不出来」而放行）", async () => {
      await expectDenied("http://this-host-should-not-exist-acf.invalid/x.git");
    });
  });
});
