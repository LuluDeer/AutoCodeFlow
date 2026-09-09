import { buildTypeOrmDataSourceOptions } from "./configuration";
// 直接复用 app.module 注册进 validationSchema 的同一 schema 对象——
// ConfigModule.forRoot 的闭包无法反射取出，抽导出是防漂移的最低成本方案。
import { DB_READ_REPLICA_URL_SCHEMA } from "../app.module";

/**
 * ARCH-24: 读写分离（只读副本）配置面钉子——可选 DB_READ_REPLICA_URL。
 *
 * DataSource 形态构造收口在 configuration.ts 的 buildTypeOrmDataSourceOptions
 * （纯函数），app.module 的 TypeOrmModule.forRootAsync 工厂仅透传
 * ConfigService 配置节并在其上叠加 DB_SYNCHRONIZE 语义（synchronize）。
 * 本 spec 覆盖：
 *  a) 未配置副本（默认）→ 无 replication 字段，产物与旧版单连接形态一致；
 *  b) 配置 DB_READ_REPLICA_URL → replication.master/slaves 形态正确；
 *  c) app.module 的 Joi schema 拒绝非 postgres scheme 的非法 URL。
 */

const baseConfig = {
  database: {
    host: "db-primary.internal",
    port: 5432,
    username: "autoflow",
    password: "db-pass",
    database: "autocodeflow",
    poolSize: 20,
  },
  app: { nodeEnv: "test" },
};

describe("buildTypeOrmDataSourceOptions (ARCH-24 read replica)", () => {
  it("a) defaults to the legacy single-connection shape (no replication field) when readReplicaUrl is unset", () => {
    const options = buildTypeOrmDataSourceOptions({ ...baseConfig });

    expect("replication" in options).toBe(false);
    expect(options).toMatchObject({
      type: "postgres",
      host: "db-primary.internal",
      port: 5432,
      username: "autoflow",
      password: "db-pass",
      database: "autocodeflow",
      migrationsRun: true,
      synchronize: false,
      logging: false,
      extra: {
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      },
    });
  });

  it("a2) empty-string readReplicaUrl behaves exactly like unset (default off)", () => {
    const options = buildTypeOrmDataSourceOptions({
      ...baseConfig,
      database: { ...baseConfig.database, readReplicaUrl: "" },
    });
    expect("replication" in options).toBe(false);
    expect(options).toMatchObject({
      type: "postgres",
      host: "db-primary.internal",
    });
  });

  it("a3) keeps the rest of the options identical between both shapes (only connection block differs)", () => {
    const off = buildTypeOrmDataSourceOptions({ ...baseConfig });
    const on = buildTypeOrmDataSourceOptions({
      ...baseConfig,
      database: {
        ...baseConfig.database,
        readReplicaUrl:
          "postgres://readonly@db-replica.internal:5432/autocodeflow",
      },
    });

    for (const key of [
      "entities",
      "migrations",
      "migrationsRun",
      "synchronize",
      "logging",
      "extra",
    ]) {
      expect(on[key]).toEqual(off[key]);
    }
  });

  it("b) uses replication { master, slaves: [replicaUrl] } when DB_READ_REPLICA_URL is configured", () => {
    const options = buildTypeOrmDataSourceOptions({
      ...baseConfig,
      database: {
        ...baseConfig.database,
        readReplicaUrl:
          "postgres://readonly@db-replica.internal:5432/autocodeflow",
      },
    }) as {
      replication: {
        master: Record<string, unknown>;
        slaves: string[];
      };
      host?: string;
      port?: number;
    };

    // master 沿用拆字段凭据；无顶层 host/port 等单连接字段。
    expect(options.replication.master).toEqual({
      host: "db-primary.internal",
      port: 5432,
      username: "autoflow",
      password: "db-pass",
      database: "autocodeflow",
    });
    expect(options.replication.slaves).toEqual([
      "postgres://readonly@db-replica.internal:5432/autocodeflow",
    ]);
    expect(options.host).toBeUndefined();
    expect(options.port).toBeUndefined();
    // 同一配置对象里 replication 与顶层拆字段互斥：其余选项仍共享。
    expect(options).toMatchObject({ type: "postgres", migrationsRun: true });
  });

  it("b2) migrationsRun follows NODE_ENV semantics in both shapes (dev off)", () => {
    const dev = buildTypeOrmDataSourceOptions({
      ...baseConfig,
      app: { nodeEnv: "development" },
    });
    expect(dev.migrationsRun).toBe(false);
  });
});

/**
 * c) Joi 注册面：app.module validationSchema 中 DB_READ_REPLICA_URL 为
 *    scheme 锁定（postgres/postgresql）的可选 uri。validationSchema 在
 *    ConfigModule.forRoot 闭包内无法反射取出，故 app.module 把该 schema
 *    抽为命名导出 DB_READ_REPLICA_URL_SCHEMA，此处直接 import 同一对象
 *    断言——注册面与测试零漂移。
 */
describe("DB_READ_REPLICA_URL Joi validation (ARCH-24)", () => {
  it("c1) rejects a non-postgres scheme URL (fail-fast on misconfiguration)", () => {
    const result = DB_READ_REPLICA_URL_SCHEMA.validate(
      "http://db-replica.internal:5432/autocodeflow",
    );
    expect(result.error).toBeDefined();
    expect(result.error!.message).toMatch(
      /scheme matching the postgres\|postgresql pattern/,
    );
  });

  it("c2) rejects a bare host:port (must be a postgres:// URI)", () => {
    const result = DB_READ_REPLICA_URL_SCHEMA.validate(
      "db-replica.internal:5432",
    );
    expect(result.error).toBeDefined();
  });

  it("c2b) rejects mysql:// and https:// schemes explicitly", () => {
    for (const url of ["mysql://u:p@h/db", "https://replica.internal/db"]) {
      const result = DB_READ_REPLICA_URL_SCHEMA.validate(url);
      expect(result.error).toBeDefined();
    }
  });

  it("c3) accepts a postgres:// / postgresql:// URL and unset (optional)", () => {
    for (const url of [
      "postgres://readonly@db-replica.internal:5432/autocodeflow",
      "postgresql://readonly:pw@db-replica.internal:5432/autocodeflow",
      "", // 空 = 显式关闭（默认形态）
    ]) {
      const result = DB_READ_REPLICA_URL_SCHEMA.validate(url);
      expect(result.error).toBeUndefined();
    }

    // 完全未设置 = 可选（读写分离默认关闭）。
    const result = DB_READ_REPLICA_URL_SCHEMA.validate(undefined);
    expect(result.error).toBeUndefined();
  });
});
