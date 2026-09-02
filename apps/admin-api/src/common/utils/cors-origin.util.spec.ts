import {
  isOriginAllowed,
  parseAllowedOrigins,
} from "./cors-origin.util";

describe("cors-origin.util (ARCH-001)", () => {
  describe("parseAllowedOrigins", () => {
    it("splits a comma separated list and trims whitespace", () => {
      expect(
        parseAllowedOrigins("https://a.example.com , https://b.example.com,"),
      ).toEqual(["https://a.example.com", "https://b.example.com"]);
    });

    it("returns an empty array for undefined/empty input", () => {
      expect(parseAllowedOrigins(undefined)).toEqual([]);
      expect(parseAllowedOrigins("")).toEqual([]);
      expect(parseAllowedOrigins("  ,  ")).toEqual([]);
    });
  });

  describe("isOriginAllowed", () => {
    const prodOrigins = ["https://admin.example.com"];

    it("allows origins explicitly present in the whitelist", () => {
      expect(isOriginAllowed("https://admin.example.com", prodOrigins, false)).toBe(
        true,
      );
    });

    it("rejects origins not in the whitelist regardless of environment", () => {
      expect(isOriginAllowed("https://evil.example.com", prodOrigins, false)).toBe(
        false,
      );
      expect(isOriginAllowed("https://admin.example.com.evil.com", prodOrigins, false)).toBe(
        false,
      );
    });

    it("no longer auto-allows private/LAN network origins (ARCH-001 regression)", () => {
      const lanOrigins = [
        "http://192.168.3.47:5176",
        "http://10.0.0.5:3000",
        "http://172.16.1.1:8080",
        "http://172.31.255.255:9000",
        "http://127.0.0.1:5176",
        "http://localhost:5176",
      ];
      for (const origin of lanOrigins) {
        // 配置了白名单后，一切以白名单为准，私有网段不再自动放行
        expect(isOriginAllowed(origin, prodOrigins, false)).toBe(false);
        expect(isOriginAllowed(origin, prodOrigins, true)).toBe(false);
      }
    });

    it("defaults to localhost/127.0.0.1 on any port in development when no whitelist is configured", () => {
      expect(isOriginAllowed("http://localhost:5176", [], true)).toBe(true);
      expect(isOriginAllowed("http://127.0.0.1:5176", [], true)).toBe(true);
      expect(isOriginAllowed("http://localhost", [], true)).toBe(true);
      expect(isOriginAllowed("https://localhost:5176", [], true)).toBe(true);
    });

    it("does not apply the development default outside development", () => {
      expect(isOriginAllowed("http://localhost:5176", [], false)).toBe(false);
      expect(isOriginAllowed("http://127.0.0.1:5176", [], false)).toBe(false);
    });

    it("does not apply the development default to non-local hosts even in development", () => {
      expect(isOriginAllowed("http://192.168.1.10:5176", [], true)).toBe(false);
      expect(isOriginAllowed("http://0.0.0.0:5176", [], true)).toBe(false);
      expect(isOriginAllowed("http://localhost.evil.com:5176", [], true)).toBe(
        false,
      );
    });

    it("explicit configuration takes precedence over the development default", () => {
      // 显式白名单非空时，localhost 之外的来源不再被默认放行
      expect(
        isOriginAllowed("http://localhost:9999", ["https://a.example.com"], true),
      ).toBe(false);
      // 白名单里显式包含 LAN origin 时按白名单放行
      expect(
        isOriginAllowed(
          "http://192.168.3.47:5176",
          ["http://192.168.3.47:5176"],
          true,
        ),
      ).toBe(true);
    });
  });
});
