import { HttpException } from "@nestjs/common";
import { isOriginAllowed, parseAllowedOrigins, corsOriginValidator } from "./cors-origin.util";

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
      expect(
        isOriginAllowed("https://admin.example.com", prodOrigins, false),
      ).toBe(true);
    });

    it("rejects origins not in the whitelist regardless of environment", () => {
      expect(
        isOriginAllowed("https://evil.example.com", prodOrigins, false),
      ).toBe(false);
      expect(
        isOriginAllowed(
          "https://admin.example.com.evil.com",
          prodOrigins,
          false,
        ),
      ).toBe(false);
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
        isOriginAllowed(
          "http://localhost:9999",
          ["https://a.example.com"],
          true,
        ),
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

  // F-40（UIUX 审计 P1-1）：拒绝从裸 Error（冒泡成 500 errorCode:null）改为
  // 带稳定码的 AppError（规范 403 错误封套）。回调形态与 enableCors 的
  // origin 选项一致，这里直接钉回调行为。
  describe("corsOriginValidator (F-40)", () => {
    // cors 包的 OriginCallback：error 即 next(err)，第二参无实际语义
    type OriginCallback = (err: Error | null, allow?: boolean) => void;

    function run(
      validator: ReturnType<typeof corsOriginValidator>,
      origin: string | undefined,
    ): { err: Error | null; allow?: boolean } {
      let captured: { err: Error | null; allow?: boolean } = {
        err: null,
        allow: undefined,
      };
      const cb: OriginCallback = (err, allow) => {
        captured = { err, allow };
      };
      validator(origin, cb);
      return captured;
    }

    it("无 Origin 头（server-to-server）放行", () => {
      const validator = corsOriginValidator(["https://admin.example.com"], false);
      const { err, allow } = run(validator, undefined);
      expect(err).toBeNull();
      expect(allow).toBe(true);
    });

    it("白名单内 origin 放行", () => {
      const validator = corsOriginValidator(["http://127.0.0.1:8088"], false);
      const { err, allow } = run(validator, "http://127.0.0.1:8088");
      expect(err).toBeNull();
      expect(allow).toBe(true);
    });

    it("dev 无白名单时默认放行本机来源", () => {
      const validator = corsOriginValidator([], true);
      const { err, allow } = run(validator, "http://localhost:5176");
      expect(err).toBeNull();
      expect(allow).toBe(true);
    });

    it("白名单外 origin → 403 HttpException（errorCode=CORS_ORIGIN_NOT_ALLOWED，params.origin 透出）", () => {
      const validator = corsOriginValidator(
        ["http://localhost:8088", "http://127.0.0.1:8088"],
        false,
      );
      const { err } = run(validator, "http://127.0.0.1:5176");
      // AppError 按 status 挂对应内置异常原型（403 → ForbiddenException，
      // app-error.ts 的 instanceof 设计），故断言落在 HttpException 面上；
      // HttpExceptionFilter 据此渲染统一封套（errorCode/params 透出）。
      expect(err).toBeInstanceOf(HttpException);
      const httpErr = err as HttpException;
      expect(httpErr.getStatus()).toBe(403);
      const resp = httpErr.getResponse() as Record<string, unknown>;
      expect(resp["errorCode"]).toBe("CORS_ORIGIN_NOT_ALLOWED");
      expect(resp["params"]).toEqual({ origin: "http://127.0.0.1:5176" });
      // 文案不插值请求方可控的 origin（前端按码翻译，origin 只走 params）
      expect(httpErr.message).not.toContain("5176");
    });

    it("生产环境白名单外 origin（含 localhost）同样 403 拒绝", () => {
      const validator = corsOriginValidator(["https://admin.example.com"], false);
      for (const origin of [
        "http://localhost:5176",
        "http://127.0.0.1:5176",
        "https://evil.example.com",
      ]) {
        const { err } = run(validator, origin);
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(403);
        expect(
          ((err as HttpException).getResponse() as Record<string, unknown>)[
            "errorCode"
          ],
        ).toBe("CORS_ORIGIN_NOT_ALLOWED");
      }
    });
  });
});
