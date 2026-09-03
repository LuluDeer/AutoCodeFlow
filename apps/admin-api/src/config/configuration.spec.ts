const ORIGINAL_ENV = process.env;

describe("configuration production secret validation", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "production",
      DB_PASSWORD: "strong-database-password",
      JWT_SECRET: "strong-jwt-secret-at-least-32-characters",
      JWT_REFRESH_SECRET: "strong-refresh-secret-at-least-32-characters",
      EXECUTOR_SECRET: "strong-executor-secret",
      CORS_ORIGINS: "https://admin.example.com",
      INITIAL_ADMIN_PASSWORD: "changed-on-first-login",
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.resetModules();
  });

  it.each([
    ["JWT_SECRET", "change_me_to_a_random_secret_32chars", /JWT_SECRET/],
    [
      "JWT_REFRESH_SECRET",
      "change_me_to_another_random_secret_32chars",
      /JWT_REFRESH_SECRET/,
    ],
    [
      "EXECUTOR_SECRET",
      "change_me_to_a_random_token_16chars",
      /EXECUTOR_SECRET/,
    ],
  ])(
    "rejects the .env.example placeholder for %s in production",
    (name, value, expectedError) => {
      process.env[name] = value;

      expect(() => {
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require("./configuration");
        });
      }).toThrow(expectedError);
    },
  );
});

describe("configuration (ARCH-004/005/006) throttle, redis tls, db synchronize", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.NODE_ENV;
    delete process.env.THROTTLE_LIMIT;
    delete process.env.THROTTLE_TTL;
    delete process.env.DB_SYNCHRONIZE;
    delete process.env.REDIS_TLS;
    delete process.env.REDIS_TLS_REJECT_UNAUTHORIZED;
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_ORIGINS;
    delete process.env.DB_PASSWORD;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.resetModules();
  });

  const loadConfig = () => {
    let cfg: Record<string, any>;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cfg = require("./configuration").default();
    });
    return cfg!;
  };

  it("defaults throttle to 60 requests / 60s (tightened from 100)", () => {
    const cfg = loadConfig();
    expect(cfg.throttle.limit).toBe(60);
    expect(cfg.throttle.ttl).toBe(60000);
  });

  it("allows throttle override via THROTTLE_LIMIT / THROTTLE_TTL", () => {
    process.env.THROTTLE_LIMIT = "30";
    process.env.THROTTLE_TTL = "30000";
    const cfg = loadConfig();
    expect(cfg.throttle.limit).toBe(30);
    expect(cfg.throttle.ttl).toBe(30000);
  });

  it("defaults DB_SYNCHRONIZE to false regardless of NODE_ENV inference", () => {
    expect(loadConfig().database.synchronize).toBe(false);
    process.env.NODE_ENV = "development";
    expect(loadConfig().database.synchronize).toBe(false);
  });

  it("enables synchronize only with explicit DB_SYNCHRONIZE=true outside production", () => {
    process.env.DB_SYNCHRONIZE = "true";
    process.env.NODE_ENV = "development";
    expect(loadConfig().database.synchronize).toBe(true);
  });

  it("forces synchronize=false in production even with DB_SYNCHRONIZE=true, and fails fast", () => {
    process.env = {
      ...process.env,
      NODE_ENV: "production",
      DB_PASSWORD: "strong-database-password",
      JWT_SECRET: "strong-jwt-secret-at-least-32-characters",
      JWT_REFRESH_SECRET: "strong-refresh-secret-at-least-32-characters",
      EXECUTOR_SECRET: "strong-executor-secret",
      CORS_ALLOWED_ORIGINS: "https://admin.example.com",
      DB_SYNCHRONIZE: "true",
    };
    // production fail-fast block (module load) rejects DB_SYNCHRONIZE outright
    expect(() => loadConfig()).toThrow(/DB_SYNCHRONIZE/);
  });

  it("exposes redis TLS options: off by default, enabled via REDIS_TLS=true", () => {
    expect(loadConfig().redis.tls).toBe(false);
    process.env.REDIS_TLS = "true";
    const cfg = loadConfig();
    expect(cfg.redis.tls).toBe(true);
    expect(cfg.redis.tlsRejectUnauthorized).toBe(true);
    process.env.REDIS_TLS_REJECT_UNAUTHORIZED = "false";
    expect(loadConfig().redis.tlsRejectUnauthorized).toBe(false);
  });
});

describe("configuration (ARCH-001) CORS_ALLOWED_ORIGINS whitelist", () => {
  const ORIGINAL_ENV = process.env;

  // production 模块加载即触发全部 fail-fast 校验，需要先满足其它强校验
  const STRONG_PRODUCTION_ENV = {
    NODE_ENV: "production",
    DB_PASSWORD: "strong-database-password",
    JWT_SECRET: "strong-jwt-secret-at-least-32-characters",
    JWT_REFRESH_SECRET: "strong-refresh-secret-at-least-32-characters",
    EXECUTOR_SECRET: "strong-executor-secret",
  };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_ORIGINS;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.resetModules();
  });

  const loadConfig = () => {
    let cfg: Record<string, any>;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cfg = require("./configuration").default();
    });
    return cfg!;
  };

  it("parses CORS_ALLOWED_ORIGINS into cors.allowedOrigins", () => {
    process.env.CORS_ALLOWED_ORIGINS =
      "https://a.example.com, https://b.example.com";
    expect(loadConfig().cors.allowedOrigins).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });

  it("falls back to legacy CORS_ORIGINS when CORS_ALLOWED_ORIGINS is unset", () => {
    process.env.CORS_ORIGINS = "http://localhost:5176,http://192.168.3.47:5176";
    expect(loadConfig().cors.allowedOrigins).toEqual([
      "http://localhost:5176",
      "http://192.168.3.47:5176",
    ]);
  });

  it("defaults to an empty whitelist in development (localhost:* applies at runtime)", () => {
    expect(loadConfig().cors.allowedOrigins).toEqual([]);
  });

  it("rejects production startup without an explicit whitelist", () => {
    process.env = { ...ORIGINAL_ENV, ...STRONG_PRODUCTION_ENV };
    expect(() => loadConfig()).toThrow(/CORS_ALLOWED_ORIGINS/);
  });

  it("rejects production startup with localhost origins in the whitelist", () => {
    process.env = {
      ...ORIGINAL_ENV,
      ...STRONG_PRODUCTION_ENV,
      CORS_ALLOWED_ORIGINS: "https://admin.example.com,http://localhost:5176",
    };
    expect(() => loadConfig()).toThrow(/CORS_ALLOWED_ORIGINS/);
  });

  it("accepts a valid explicit production whitelist", () => {
    process.env = {
      ...ORIGINAL_ENV,
      ...STRONG_PRODUCTION_ENV,
      CORS_ALLOWED_ORIGINS: "https://admin.example.com",
    };
    expect(loadConfig().cors.allowedOrigins).toEqual([
      "https://admin.example.com",
    ]);
  });
});
