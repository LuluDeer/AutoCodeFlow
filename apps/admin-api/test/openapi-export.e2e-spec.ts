/**
 * ARCH-23: OpenAPI 导出 e2e —— openapi.json 的**唯一写入方**（N28 式单事实源）。
 *
 * 实测（2026-09-09，本机 develop）：裸 `node`/`ts-node` 进程内
 * NestFactory.create(AppModule) 在 DI 装配阶段挂起（InternalCoreModule
 * useFactory 链 + paramBarrier 死等，debug 栈见 PR 描述）；而 Jest 环境下
 * 同一 createTestApp 形状（CI admin-api-test 的 e2e 用例）稳定可引导。
 * 因此导出管道复用既有 e2e 基建：boots 完整 AppModule → createDocument →
 * 落盘 ../openapi.json。运行需要 DB + Redis（与 test:e2e 相同前置）。
 *
 * **为何本 spec 是唯一写入方**（2026-09-10 CI drift 双红教训）：曾并存两条
 * 导出路径——本 spec（Jest/ts-jest）与 scripts/export-openapi.ts（ts-node），
 * 两者对 `@IsEnum` 字段的装饰器元数据反射不一致：Jest 路径 emit
 * `{"type":"string"}`（enum 正确反射），ts-node 路径 emit `{"type":"object"}`
 * （CreateTaskDto 的 status/triggerType 等 7 字段退化为 object）→ 两条路径
 * 产物 md5 不同，`npm test` 全量跑一次本 spec 就会静默改写 openapi.json，
 * 与 gen:api-types 产物错配 → CI api-types-drift 双红。裁定：**Jest 路径
 * （枚举类型质量更高）为 canonical writer**，`npm run swagger:export` 已
 * 改为委托本 spec；scripts/export-openapi.ts 仅留档（勿再运行）。
 *
 * 字节级幂等：JSON.stringify(document, null, 2) + 尾部换行；装饰器元数据
 * 键序稳定，两次运行逐字节一致（CI git diff --exit-code drift 闸依赖此性质）。
 */
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import * as fs from "fs";
import * as path from "path";
import { AppModule } from "../src/app.module";

describe("OpenAPI export (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("exports a deterministic openapi.json", async () => {
    const config = new DocumentBuilder()
      .setTitle("AutoFlow Admin API")
      .setVersion("1.0.0")
      .setDescription(
        "AutoCodeFlow Admin API — exported by test/openapi-export.e2e-spec.ts " +
          "(ARCH-23). Single source of truth for generated frontend types " +
          "(apps/admin-web gen:api-types) and the CI api-types-drift check. " +
          "Regenerate with `npm run swagger:export` after any API contract change.",
      )
      .addBearerAuth(
        { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        "JWT",
      )
      .addSecurityRequirements("JWT")
      .addServer("http://localhost:3105", "Local development")
      .build();

    const document = SwaggerModule.createDocument(app, config, {
      deepScanRoutes: true,
    });

    const pathCount = Object.keys(document.paths ?? {}).length;
    expect(pathCount).toBeGreaterThan(0);

    const json = JSON.stringify(document, null, 2) + "\n";
    const outPath = path.resolve(__dirname, "..", "openapi.json");
    fs.writeFileSync(outPath, json, "utf8");
    // eslint-disable-next-line no-console
    console.log(
      `[openapi-export] wrote ${outPath} (${Buffer.byteLength(json)} bytes, ${pathCount} paths)`,
    );
  });
});
