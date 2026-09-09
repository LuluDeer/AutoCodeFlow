/**
 * ARCH-23: OpenAPI JSON 导出脚本 —— 生成 admin-web 前端类型（gen:api-types）
 * 与 CI drift 校验（api-types-drift job）的单一事实来源。
 *
 * 设计要点（与 docs/development.md「API 契约 → 前端类型生成」一节互为参照）：
 *
 * 1. **Standalone app，不监听端口**：`NestFactory.create` 只做 DI 容器装配与
 *    路由扫描（SwaggerModule.createDocument 需要的就是这份路由元数据），不调
 *    `app.listen()`。`logger: false` 仅静默 Nest 启动日志噪音。
 *
 * 2. **无 DB / 无 Redis 环境可跑（CI 不起 PG/Redis service 容器）**：
 *    根模块用 `{ module: AppModule, imports: [overrides...] }` 形态把静态版
 *    `TypeOrmModule.forRoot` / `BullModule.forRoot` 与 AppModule 并列注册——
 *    两库的内部模块（TypeOrmCoreModule / BullModule 的共享配置 token）同名，
 *    容器按注册序去重、先注册者胜出 → AppModule 内部的 forRootAsync 连接
 *    工厂被旁路：
 *    - TypeORM：`manualInitialization: true` → DataSource 只构建不 initialize
 *      （TypeORM 的连接仅在首次 repository 查询时建立，而路由扫描不触库），
 *      `retryAttempts: 0` 关闭重试。
 *    - BullMQ（v6）：`Queue` 构造即创建 RedisConnection（ioredis 的
 *      lazyConnect 不被 bullmq 尊重——init() 仍会 connect 并做 INFO 版本
 *      探测，无 Redis 时指数退避挂死）。本脚本用 `BullModule.queueClass`
 *      注入 OfflineQueue 子类：把共享的 stub client 作为 connection 传入
 *      （结构性满足 bullmq isRedisInstance 探测：connect/disconnect/duplicate
 *      + defineCommand/info），零 socket、零真实连接。app 内全部
 *      registerQueue 的队列实例共享同一 stub（shared: true 语义）。
 *    实测：无 DB/Redis 环境导出正常，契约面来自装饰器元数据，与连接无关。
 *
 * 3. **进程收尾用 process.exit(0) 而非 app.close()**：关闭路径会逐一
 *    destroy 数据源 / close 队列，对「从未建立」的连接（未初始化 DataSource、
 *    stub client）会挂住或抛错；导出是一次性批处理，成功写盘后硬退出最稳。
 *    失败路径仍走 catch → exit(1)，CI 照常变红。
 *
 * 4. **幂等（字节级）**：文档结构由装饰器元数据决定（键序随装饰器求值序
 *    固定），序列化 `JSON.stringify(doc, null, 2)` + 结尾换行——两次生成
 *    逐字节一致，CI 才能用 git diff 做 drift 判断。
 *
 * 5. **main.ts 的 Swagger 段不变**：main.ts 只在 dev 运行期把同一份文档挂到
 *    /api/docs（生产跳过，ARCH-007）；本脚本离线导出，两侧共用
 *    SwaggerModule.createDocument 的同一份装饰器元数据，契约不会分叉。
 *
 * 用法：
 *   ⚠️ **已停用（2026-09-10）——勿再运行**。本脚本（ts-node 路径）对
 *   @IsEnum 字段的装饰器元数据反射与 Jest 路径不一致（emit {"type":"object"}
 *   而非 {"type":"string"}，CreateTaskDto 7 字段退化），两条导出路径产物
 *   md5 不同曾致 CI api-types-drift 双红。canonical writer =
 *   test/openapi-export.e2e-spec.ts（Jest，枚举类型质量更高），
 *   `npm run swagger:export` 已委托该 spec。本文件仅留档其离线装配技巧
 *   （manualInitialization / OfflineQueue stub / 0-paths fail-fast）。
 */
import "reflect-metadata";
import * as path from "path";
import * as fs from "fs";
import { NestFactory } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { EventEmitter } from "events";
// 与 main.ts 相同的 W-22 约束：app.module 里的控制器装饰器在模块求值期
// （@Throttle 读取 LOGIN_THROTTLE_LIMIT）直读 process.env，必须先加载 .env
// 再动态 import app.module —— 静态 import 会被提升到 loadEnvFile 之前。
import { config as loadEnvFile } from "dotenv";
loadEnvFile({ path: path.resolve(__dirname, "..", ".env") });

const importAppModule = async () =>
  (await import("../src/app.module")).AppModule;

/** 头注 ②：bullmq 离线 stub client —— 结构性满足 ioredis 探测的最小面。 */
function createOfflineRedisStub() {
  // 显式 let 承载运行时附加的 ioredis 最小手续（status/options/defineCommand/
  // connect/disconnect/duplicate/subscribe/psubscribe/hset/info），否则返回值的
  // 静态类型退化为 EventEmitter，scripts 目录同样过 tsc --noEmit 类型闸。
  const stub = new EventEmitter() as EventEmitter & {
    status: string;
    options: Record<string, unknown>;
    defineCommand: (name: string) => void;
    info: () => Promise<string>;
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
    duplicate: () => ReturnType<typeof createOfflineRedisStub>;
    subscribe: (..._args: unknown[]) => void;
    psubscribe: (..._args: unknown[]) => void;
    hset: (..._args: unknown[]) => Promise<number>;
    [name: string]: unknown;
  };
  stub.status = "ready";
  stub.options = {};
  // defineCommand 必须真实注册同名命令（返回 no-op async）：@nestjs/bullmq
  // 会为 @Processor 装饰器创建 Worker 实例，其 _getNextJob 循环调用
  // loadCommands 注册的 lua 命令；若 defineCommand 是纯 no-op，则
  // `client[name] is not a function` 每轮 tick 抛错 → 无限错误风暴 → OOM。
  stub.defineCommand = (name: string) => {
    stub[name] = async () => null;
  };
  stub.info = () =>
    Promise.resolve("redis_version:7.0.0\nmaxmemory_policy:noeviction");
  stub.connect = () => Promise.resolve();
  stub.disconnect = () => Promise.resolve();
  stub.duplicate = () => stub;
  stub.subscribe = () => {};
  stub.psubscribe = () => {};
  stub.hset = () => Promise.resolve(1);
  return stub;
}

/** 头注 ②：所有队列共享一个 stub client —— 零 socket、零真实连接。 */
const offlineRedisStub = createOfflineRedisStub();

/**
 * bullmq Queue 子类：恒用共享 stub client。经 BullModule.queueClass 注入后，
 * AppModule 内全部 registerQueue 的队列实例走此路径（export 管道专用，
 * 运行时 Bootstrap 不受影响）。
 */
class OfflineQueue extends Queue {
  // BullModule 的 createQueueAndWorkers 只传 (name, options) 两参。
  constructor(name: string, opts?: unknown) {
    super(name, {
      ...((opts as Record<string, unknown>) ?? {}),
      connection: offlineRedisStub,
    } as never);
  }
}

async function main(): Promise<void> {
  // 头注 ②（顺序关键）：queueClass 必须在 app.module 被动态 import **之前**
  // 设置 —— BullModule.registerQueue 在模块装饰器求值期（import 时）就把
  // _queueClass 捕获进 provider 工厂，之后再换类不生效。
  BullModule.queueClass = OfflineQueue;
  const AppModule = await importAppModule();

  // 与 main.ts ARCH-007 段相同的 DocumentBuilder 关键配置。title/version/
  // security 声明与 paths/schemas 的 drift 面无关；这里刻意精简，避免把
  // main.ts 的长 description 同步负担带进导出管道。
  const config = new DocumentBuilder()
    .setTitle("AutoFlow Admin API")
    .setVersion("1.0.0")
    .setDescription(
      "AutoCodeFlow Admin API — exported by scripts/export-openapi.ts " +
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

  // 无 DB/Redis 覆盖（机制见文件头注 ②）：静态 forRoot 与 AppModule 并列
  // 注册，先注册者生效，AppModule 内部的 forRootAsync 被旁路；queueClass
  // 已在上方（import 前）注入。
  const app = await NestFactory.create(
    {
      module: AppModule,
      imports: [
        TypeOrmModule.forRoot({
          type: "postgres",
          // 无 DB 环境：仅元数据形态，连接从不建立（manualInitialization）。
          host: "127.0.0.1",
          port: 5432,
          username: "openapi-export",
          password: "openapi-export",
          database: "openapi-export",
          entities: [],
          synchronize: false,
          migrationsRun: false,
          manualInitialization: true,
          retryAttempts: 0,
          // afterConnect 的扩展安装探针（CREATE EXTENSION）对含 uuid 列的
          // 实体会真实打库——导出场景必须整体关掉驱动侧连接后动作。
          installExtensions: false,
        }),
        BullModule.forRoot({
          connection: {
            host: "127.0.0.1",
            port: 6379,
            lazyConnect: true,
            maxRetriesPerRequest: null,
          },
        }),
      ],
    },
    undefined,
    { logger: false, abortOnError: true },
  );

  // deepScanRoutes: true —— 与 main.ts 保持一致，覆盖 lazy module 路由。
  const document = SwaggerModule.createDocument(app, config, {
    deepScanRoutes: true,
  });

  // 字节级确定性：固定 2 空格缩进 + 结尾换行。两次运行逐字节一致，
  // CI drift 校验（git diff --exit-code）才可靠。
  const outPath = path.resolve(__dirname, "..", "openapi.json");
  const json = JSON.stringify(document, null, 2) + "\n";
  fs.writeFileSync(outPath, json, "utf8");
  const bytes = Buffer.byteLength(json, "utf8");
  const pathCount = Object.keys(document.paths ?? {}).length;
  // 头注 ③：硬退出（exit 0）—— 不走 app.close() 的连接拆除路径。exit 前
  // 先同步冲一遍 stdout（pipe 场景 exit 会截断未 flush 的输出）。
  const summary =
    `OpenAPI document written to ${outPath} (${bytes} bytes, ` +
    `${pathCount} paths)`;
  if (pathCount === 0) {
    // 路由面为空 = 覆盖机制破坏了 AppModule 装配（例如上方 forRoot 旁路
    // 失效），产物无意义且会造成「合法删除全部端点」的假绿灯——fail-fast。
    console.error(
      `[FATAL] exported document has 0 paths — AppModule assembly failed (overrides misconfigured?)`,
    );
    fs.writeFileSync(outPath, json, "utf8"); // 保留现场便于排查
    process.exit(1);
  }
  fs.writeSync(1, summary + "\n");
  process.exit(0);
}

void main().catch((err: unknown) => {
  console.error("[FATAL] openapi export failed:", err);
  process.exit(1);
});
