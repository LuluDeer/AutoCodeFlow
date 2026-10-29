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
 *
 * ⚠️ API-I18N（2026-10-16 教训）：本 spec 落盘的是**纯中文**文档，而入库的
 * `openapi.json` 还带 `x-i18n-en` 英文扩展键（由
 * `scripts/api-i18n/inject-openapi-en.mjs` 注入）。故 `swagger:export` 必须
 * **串联注入步骤**——只跑本 spec 会写出一份缺英文的产物，而 CI 的
 * api-types-drift job 正是「重跑 swagger:export 再 diff」，于是必然报
 * 「openapi.json 与装饰器元数据漂移」（实测：本轮推送即被该闸拦下）。
 * 注入是幂等的（已注入的键不重复写），故串联后连跑两次仍逐字节一致。
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

    // ⚠️ 只在「规范导出入口」落盘，避免**静默污染**（2026-10-27 实施轮 #10 实测）：
    //
    // 缺陷现场：`npm test`（含 e2e）或裸 `jest --config test/jest-e2e.json` 也会跑本
    // spec，它把**纯中文**文档直接覆盖写入 openapi.json —— 入库产物里的 1503 处
    // x-i18n-en 全部消失（实测 grep -c 由 1503 → 0），工作区冒出 5059 行 diff。
    // 而 swagger:export 是「spec + inject 注入」两步串联，单独跑 spec 少了第二步，
    // 产物既不是 canonical 形态、也没有任何报错：开发者只看到"e2e 全绿"加一个
    // 莫名其妙的大 diff（很容易顺手 commit，把整片英文文档面删掉）。
    //
    // 判据：只有 `npm run swagger:export` 会设 ACF_OPENAPI_EXPORT=1（见
    // apps/admin-api/package.json）。其余入口（npm test / 裸 jest / CI 的
    // admin-api-test job）只**校验**不落盘——契约漂移由 CI 的 api-types-drift job
    // 专职拦截（它跑的就是 swagger:export + git diff --exit-code）。
    const isCanonicalExport = process.env.ACF_OPENAPI_EXPORT === "1";
    const outPath = path.resolve(__dirname, "..", "openapi.json");

    if (!isCanonicalExport) {
      // 不落盘，但仍要证明"能导出"（否则本 spec 在常规 e2e 里退化成空跑）。
      expect(json.length).toBeGreaterThan(10_000);
      expect(json).toContain('"openapi"');
      console.log(
        `[openapi-export] dry: ${pathCount} paths, ${Buffer.byteLength(json)} bytes ` +
          `(未落盘；要重写产物请用 npm run swagger:export)`,
      );
      return;
    }

    fs.writeFileSync(outPath, json, "utf8");
    console.log(
      `[openapi-export] wrote ${outPath} (${Buffer.byteLength(json)} bytes, ${pathCount} paths)`,
    );
  });
});
