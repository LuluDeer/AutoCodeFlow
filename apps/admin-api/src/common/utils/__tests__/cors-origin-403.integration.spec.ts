/**
 * F-40（UIUX 审计 P1-1）：CORS 白名单拒绝的 HTTP 语义集成 spec。
 *
 * 真机缺陷：main.ts 的 origin 回调对白名单外 origin `callback(new Error(...))`，
 * cors 中间件 next(err) 冒泡到 HttpExceptionFilter 被兜成 **500「服务器内部
 * 错误」（errorCode:null）**——dev 端口（如 vite 5176）下一切带 Origin 的写
 * 请求（含登录）都报"服务器内部错误"，与真实故障不可区分。
 *
 * 修复后：corsOriginValidator 抛 AppError(CORS_ORIGIN_NOT_ALLOWED)，filter 按
 * 主路径渲染**规范 403 + 稳定码错误封套**。本 spec 用合成控制器 + 真实
 * enableCors + 全局 HttpExceptionFilter 走真 HTTP 栈（supertest），钉住：
 *   - 白名单内 / 无 Origin → 200（放行路径不回归）；
 *   - 白名单外 Origin → 403（非 500）+ 封套字段（code/errorCode/message/params）；
 *   - 预检 OPTIONS 同样 403；
 *   - 403 封套进统一错误体（与业务错误同构，前端 getErrMsg 按 errorCode 翻译）。
 *
 * 不依赖 DB/Redis：控制器无 provider，CORS 与异常过滤都在 app 级配置。
 */
import { Controller, Get, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { HttpExceptionFilter } from "../../filters/http-exception.filter";
import { corsOriginValidator } from "../cors-origin.util";

@Controller("cors-probe")
class ProbeController {
  @Get("ping")
  ping() {
    return { pong: true };
  }
}

describe("corsOriginValidator × enableCors × HttpExceptionFilter (F-40, 403 not 500)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile();

    app = moduleRef.createNestApplication();
    // 与 main.ts 同一接线：demo 栈白名单形态（8088 部署域名），生产模式（无 dev 默认放行）
    app.enableCors({
      origin: corsOriginValidator(
        ["http://localhost:8088", "http://127.0.0.1:8088"],
        false,
      ),
      methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
      credentials: true,
    });
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("无 Origin 头（curl / server-to-server）→ 200", async () => {
    const res = await request(app.getHttpServer()).get("/cors-probe/ping");
    expect(res.status).toBe(200);
  });

  it("白名单内 Origin → 200 且带 Access-Control-Allow-Origin", async () => {
    const res = await request(app.getHttpServer())
      .get("/cors-probe/ping")
      .set("Origin", "http://127.0.0.1:8088");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://127.0.0.1:8088",
    );
  });

  it("白名单外 Origin → 403（非 500）+ 统一错误封套（CORS_ORIGIN_NOT_ALLOWED）", async () => {
    const res = await request(app.getHttpServer())
      .get("/cors-probe/ping")
      .set("Origin", "http://127.0.0.1:5176");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(403);
    expect(res.body.errorCode).toBe("CORS_ORIGIN_NOT_ALLOWED");
    expect(res.body.message).toContain("跨域白名单");
    expect(res.body.params).toEqual({ origin: "http://127.0.0.1:5176" });
    // 与真实服务器故障不可混淆：errorCode 必须存在（缺陷现场是 null）
    expect(res.body.errorCode).not.toBeNull();
  });

  it("白名单外 Origin 的预检 OPTIONS → 403（不签发放行头）", async () => {
    const res = await request(app.getHttpServer())
      .options("/cors-probe/ping")
      .set("Origin", "http://127.0.0.1:5176")
      .set("Access-Control-Request-Method", "POST");
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
