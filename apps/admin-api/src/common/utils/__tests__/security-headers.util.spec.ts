import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import helmet from "helmet";
import { Controller, Get } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import {
  buildHelmetOptions,
  PRODUCTION_CSP_DIRECTIVES,
} from "../security-headers.util";

// 最小控制器：helmet 是 app.use 级全局中间件，headers 断言只需要一个可达端点。
@Controller("sec08-probe")
class ProbeController {
  @Get()
  probe() {
    return { ok: true };
  }
}

/** 复刻 main.ts 的接线方式（同参数、同顺序），使断言反映真实 bootstrap 行为。 */
async function bootstrapApp(isProduction: boolean): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    controllers: [ProbeController],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = module.createNestApplication();
  app.setGlobalPrefix("api");
  app.use(helmet(buildHelmetOptions(isProduction)));
  await app.init();
  return app;
}

describe("security-headers.util (SEC-08)", () => {
  describe("buildHelmetOptions — 配置工厂", () => {
    it("生产：CSP 显式收紧（default-src/script-src 'self'，object-src/frame-ancestors 'none'）", () => {
      const opts = buildHelmetOptions(true);
      expect(opts.contentSecurityPolicy).not.toBe(false);
      const csp = opts.contentSecurityPolicy as {
        useDefaults: boolean;
        directives: Record<string, readonly string[]>;
      };
      expect(csp.useDefaults).toBe(false);
      expect(csp.directives["default-src"]).toEqual(["'self'"]);
      expect(csp.directives["script-src"]).toEqual(["'self'"]);
      expect(csp.directives["object-src"]).toEqual(["'none'"]);
      expect(csp.directives["frame-ancestors"]).toEqual(["'none'"]);
    });

    it("生产：HSTS 半年 + includeSubDomains、不 preload；Referrer-Policy same-origin", () => {
      const opts = buildHelmetOptions(true);
      expect(opts.hsts).toEqual({
        maxAge: 15768000,
        includeSubDomains: true,
        preload: false,
      });
      expect(opts.referrerPolicy).toEqual({ policy: "same-origin" });
    });

    it("非生产：CSP 关闭（Swagger UI 内联脚本可用）、HSTS 关闭，保持开发宽松", () => {
      const opts = buildHelmetOptions(false);
      expect(opts.contentSecurityPolicy).toBe(false);
      expect(opts.hsts).toBe(false);
      expect(opts.referrerPolicy).toEqual({ policy: "same-origin" });
    });

    it("upgrade-insecure-requests 声明为空数组（helmet 序列化为无值指令）", () => {
      expect(PRODUCTION_CSP_DIRECTIVES["upgrade-insecure-requests"]).toEqual(
        [],
      );
    });
  });

  describe("端到端响应头（supertest 复刻 main.ts 接线）", () => {
    let prodApp: INestApplication;
    let devApp: INestApplication;

    beforeAll(async () => {
      prodApp = await bootstrapApp(true);
      devApp = await bootstrapApp(false);
    });

    afterAll(async () => {
      await prodApp.close();
      await devApp.close();
    });

    it("生产实例：CSP 头存在且 default-src 'self'；X-Frame-Options 由 frame-ancestors 替代", async () => {
      const res = await request(prodApp.getHttpServer()).get(
        "/api/sec08-probe",
      );
      expect(res.status).toBe(200);
      const csp = String(res.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      // helmet 默认同时输出 X-Frame-Options SAMEORIGIN 兜底（老浏览器不支持
      // frame-ancestors 时仍受保护）——防嵌入双保险，断言其存在。
      expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    });

    it("生产实例：Referrer-Policy same-origin；HSTS 半年+includeSubDomains（helmet 不区分请求协议，置头由配置驱动）", async () => {
      const res = await request(prodApp.getHttpServer()).get(
        "/api/sec08-probe",
      );
      expect(res.headers["referrer-policy"]).toBe("same-origin");
      // helmet 的 hsts 中间件按配置置头（不嗅探请求协议）；preload 未开启，
      // 头中不出现 preload 指令。TLS 真实链路断言留真机轮（需 https 反代）。
      expect(res.headers["strict-transport-security"]).toBe(
        "max-age=15768000; includeSubDomains",
      );
    });

    it("开发实例：无 CSP 头（宽松，Swagger 可用），其余默认头保持", async () => {
      const res = await request(devApp.getHttpServer()).get("/api/sec08-probe");
      expect(res.status).toBe(200);
      expect(res.headers["content-security-policy"]).toBeUndefined();
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });
  });
});
