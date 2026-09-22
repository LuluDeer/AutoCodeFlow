import { parseAllowedOrigins } from "../common/utils/cors-origin.util";

/**
 * 配置读取规约（ARCH-27 配置中心收口）
 *
 * 1. 新增配置必须先在 app.module.ts 的 ConfigModule validationSchema（Joi）
 *    注册，再在本文件映射为配置对象；运行时消费方一律注入 ConfigService 并
 *    以 `configService.get("section.key")` 读取。
 * 2. 禁止在业务代码中直读 process.env —— .eslintrc.js 的
 *    no-restricted-properties 规则已封禁，违规会导致 lint 失败。
 * 3. 直读豁免清单（维护位置：.eslintrc.js overrides，每处带理由注释）：
 *    - 本文件（configuration.ts）：唯一合法的 env → 配置映射层（ConfigModule load）；
 *    - src/config/env.ts（getEnvVar）：模块求值期/无 DI 场景的唯一收口 util，
 *      背景是 W-22 前科 —— 装饰器参数求值早于 ConfigModule 生命周期，
 *      main.ts 已在 import app.module 前预载 .env（见 main.ts 头部注释）；
 *    - src/main.ts：bootstrap 预载段（W-22 修复现场，先于 DI 存在）；
 *    - 测试/spec 文件（spec 与 test 目录）：fixture 需直接操纵 env。
 * 4. Joi 未注册但本文件读取的 env 属于审计缺口，发现即补注册
 *    （ARCH-27 已补：LOGIN_THROTTLE_LIMIT、REQUEST_TIMEOUT_MS、
 *    INITIAL_ADMIN_PASSWORD/EMAIL、LOG_RETENTION_DAYS、API_BASE_URL、
 *    APP_PROTOCOL、DB_POOL_SIZE、EXECUTOR_HEARTBEAT_*、LOG_STORAGE_*、
 *    R-12: ADMIN_API_URL→app.adminApiUrl、NPM_REGISTRY_URL→registry.npm.url、
 *    METRICS_STREAM_*、EXECUTIONS_STREAM_IDLE_PING_MS）。
 */
export default () => ({
  app: {
    port: parseInt(process.env.PORT, 10) || 3105,
    nodeEnv: process.env.NODE_ENV || "development",
    protocol: process.env.APP_PROTOCOL || "http",
    // F-13（本轮审计）: 日志级别映射（Joi 已注册 LOG_LEVEL，此处补 ARCH-27
    // 收口）——main.ts 的 JSON logger 按此节构造 logLevels；缺省 info。
    logLevel: process.env.LOG_LEVEL || "info",
    // ARCH-27: 全局请求超时（REQUEST_TIMEOUT_MS）—— 此前由
    // timeout.interceptor 在模块求值期直读 process.env（W-22 风险模式），
    // 现注册后由拦截器经 ConfigService 读取，默认 30s。
    requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || "30000", 10),
    // ARCH-27: 对外可达的基础 URL —— application.controller 生成 executor
    // 可拉取的 packageUrl 时 fail-fast 校验所需，此前未注册（审计缺口）。
    apiBaseUrl: process.env.API_BASE_URL || "",
    // R-12（DEEP_REVIEW 0ef3bbe）: 执行器可回连的 Admin API 对外基址。此前由
    // executor.service.getInstallCmd / executor-package.service.push 经
    // configService.get("ADMIN_API_URL") 裸读——既未在本文件映射也未在 Joi
    // 注册，靠 ConfigService 的 process.env 回退兜住；env 名 typo 时静默取空，
    // install-cmd / package-push 运行时才 503。现收编到 app 节：空 = 未配置，
    // 运行时在相关端点 fail-fast 503（行为不变）；Joi 注册后配置值若非法
    // （非 http(s) URL）启动即拒绝。
    adminApiUrl: process.env.ADMIN_API_URL || "",
    // ARCH-27: TRUST_PROXY 在此登记注册（Joi 已有 schema）。main.ts 仍在
    // bootstrap 期直读（豁免，见 main.ts 头部），注册用于文档化与后续收口。
    trustProxy: process.env.TRUST_PROXY === "true",
    // ARCH-27: OS/容器注入的进程标识（非部署配置，无需 Joi 注册；
    // metrics.instance.hostname 展示用，此前 metrics.service 直读 process.env）。
    hostname: process.env.HOSTNAME ?? "",
  },
  database: {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    username: process.env.DB_USERNAME || "postgres",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_DATABASE || "autocodeflow",
    poolSize: parseInt(process.env.DB_POOL_SIZE || "20", 10),
    // ARCH-006: synchronize 不再依赖 NODE_ENV 推断，改为显式 DB_SYNCHRONIZE 开关
    // （Joi 默认 "false"）；生产环境强制 false 并 warn，见文件尾的 fail-fast 校验块。
    synchronize:
      process.env.DB_SYNCHRONIZE === "true" &&
      process.env.NODE_ENV !== "production",
    // ARCH-24: 可选只读副本连接串（postgres://...）。空/未配置 = 读写分离
    // 关闭（默认，行为与旧版完全一致——单一连接形态）；配置后 TypeORM 以
    // replication 形态建立 master + slaves 连接池，SELECT 类读面
    // （find* / query builder getMany 等）按驱动内建路由走 slaves。
    // 迁移（migrationsRun / MigrationExecutor）恒走 master，不受影响。
    readReplicaUrl: process.env.DB_READ_REPLICA_URL || "",
  },
  // ARCH-004: 全局限流默认收紧为 60 次/分钟（原 100），可用环境变量覆盖
  throttle: {
    ttl: parseInt(process.env.THROTTLE_TTL || "60000", 10),
    limit: parseInt(process.env.THROTTLE_LIMIT || "60", 10),
    // N16 / ARCH-27: 登录路由限流（@Throttle 装饰器求值期约束见
    // auth.controller.ts 头部注释与 W-22 记录）。默认 20。
    loginLimit: parseInt(process.env.LOGIN_THROTTLE_LIMIT || "20", 10),
    // SEC-09: 全局限流总开关（false = ThrottlerModule 顶层 skipIf 全域旁路，
    // 灰度/排障逃生门；默认 true 保持限流生效）。运行期经 ConfigService 在
    // ThrottlerModule.forRootAsync 工厂内消费。
    enabled: process.env.THROTTLE_ENABLED !== "false",
    // SEC-09: 分域档位（装饰器求值期消费点在 src/config/throttle-profiles.ts，
    // W-22 豁免；此处双轨注册供运行时一致性检查与文档化，默认值须与
    // throttle-profiles.ts 的回退一致）。
    authLimit: parseInt(process.env.THROTTLE_AUTH_LIMIT || "10", 10),
    authTtl: parseInt(process.env.THROTTLE_AUTH_TTL || "60000", 10),
    opsLimit: parseInt(process.env.THROTTLE_OPS_LIMIT || "30", 10),
    opsTtl: parseInt(process.env.THROTTLE_OPS_TTL || "60000", 10),
  },
  // SSE 日志流并发上限（进程内计数）：单 execution / 全局。
  // task.service.ts 读取本配置节；此前 sse 节从未注册，env 覆盖是死代码，现补齐。
  sse: {
    maxStreamsPerExecution: parseInt(
      process.env.SSE_MAX_STREAMS_PER_EXECUTION || "4",
      10,
    ),
    maxStreamsGlobal: parseInt(process.env.SSE_MAX_STREAMS_GLOBAL || "64", 10),
  },
  // UI-14 第一阶段：Dashboard 汇总流（GET /metrics/stream）——独立于日志流的
  // 并发上限与推送节奏。快照查询复用 /metrics/* 既有读面，interval 越小
  // DB 压力越大，默认 3s 仅够 Dashboard 级别客户端数（浏览器 Tab）。
  metricsStream: {
    maxStreamsGlobal: parseInt(
      process.env.METRICS_STREAM_MAX_GLOBAL || "32",
      10,
    ),
    intervalMs: parseInt(process.env.METRICS_STREAM_INTERVAL_MS || "3000", 10),
    idlePingMs: parseInt(
      process.env.METRICS_STREAM_IDLE_PING_MS || "15000",
      10,
    ),
  },
  // FEAT-16：执行列表终态推送流（GET /executions/stream）——事件驱动无固定
  // 数据帧节奏，静默期可能远超反代 proxy_read_timeout；idlePing 即注释帧
  // 周期（默认 30s，与 metrics/stream 的 15s 快照节奏相比事件流更安静）。
  executionsStream: {
    idlePingMs: parseInt(
      process.env.EXECUTIONS_STREAM_IDLE_PING_MS || "30000",
      10,
    ),
  },
  jwt: {
    // S4: fail-fast on weak/missing secrets — throw at startup rather than silently using defaults
    secret: (() => {
      const s = process.env.JWT_SECRET;
      if (!s || s === "default-secret-change-in-production" || s.length < 32) {
        if (process.env.NODE_ENV === "production") {
          throw new Error(
            "JWT_SECRET must be set to a strong value (>=32 chars) in production",
          );
        }
        return s || "default-secret-change-in-production";
      }
      return s;
    })(),
    refreshSecret: (() => {
      const s = process.env.JWT_REFRESH_SECRET;
      if (!s || s.length < 32) {
        if (process.env.NODE_ENV === "production") {
          throw new Error(
            "JWT_REFRESH_SECRET must be set to a strong value (>=32 chars) in production",
          );
        }
        return s || "default-refresh-secret-change-in-production";
      }
      return s;
    })(),
    expiresIn: process.env.JWT_EXPIRES_IN || "15m",
  },
  // AUTH-04: OIDC SSO（授权码模式，confidential client）。默认 disabled——
  // 不配置任何 OIDC_* env 的存量部署行为逐字节不变。
  oidc: {
    enabled: process.env.OIDC_ENABLED === "true",
    issuer: process.env.OIDC_ISSUER || "",
    clientId: process.env.OIDC_CLIENT_ID || "",
    clientSecret: process.env.OIDC_CLIENT_SECRET || "",
    // callback 全 URL：{API_BASE}/auth/oidc/callback，须与 IdP 注册一致
    redirectUri: process.env.OIDC_REDIRECT_URI || "",
    scopes: process.env.OIDC_SCOPES || "openid profile email",
    // 身份显示名来源声明；sub 恒为绑定主键
    usernameClaim: process.env.OIDC_USERNAME_CLAIM || "preferred_username",
    // R20（ADR-014 修订）: 组→角色映射，**仅在 JIT 自动建号时生效**——
    // 已绑定/存量账号的角色由平台管理员管理，IdP 侧组变化不会反向改写
    // （防提权打架）。空（默认）= 一律 USER，行为与 R16 一致。
    groupsClaim: process.env.OIDC_GROUPS_CLAIM || "groups",
    adminGroups: process.env.OIDC_ADMIN_GROUPS || "",
    // JIT 自动建号（默认关）：开启后未知用户首登自动建 USER 账号；
    // 关闭时仅允许「管理员预建同名账号 → 首登绑定」显式链路
    autoProvision: process.env.OIDC_AUTO_PROVISION === "true",
    // 颁发令牌后浏览器落地的完整 URL（#fragment 携带 token，不进服务器日志）
    webRedirectUrl:
      process.env.OIDC_WEB_REDIRECT_URL ||
      "http://localhost:5173/auth/sso/complete",
    // 同机/内网 IdP（如本机 Keycloak）需显式放行（云元数据仍恒拒）
    allowPrivateNetwork: process.env.OIDC_ALLOW_PRIVATE_NETWORK === "true",
  },
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    // REDIS_DB: 逻辑库编号 0~15，默认 0；多应用共享同一 Redis 实例时隔离 keyspace
    db: parseInt(process.env.REDIS_DB || "0", 10) || 0,
    // ARCH-005: REDIS_TLS=true 时 ioredis/BullMQ 走 TLS 传输加密；
    // REDIS_TLS_REJECT_UNAUTHORIZED=false 仅建议在自签证书调试时使用（默认校验证书）。
    tls: process.env.REDIS_TLS === "true",
    tlsRejectUnauthorized:
      process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== "false",
  },
  // ARCH-001: CORS 显式白名单 —— 优先 CORS_ALLOWED_ORIGINS，兼容旧的 CORS_ORIGINS。
  // 为空时仅开发环境默认放行 http://localhost:* / http://127.0.0.1:*（见 main.ts）；
  // 私有/LAN 网段不再被自动放行，内网部署需显式配置。
  cors: {
    allowedOrigins: parseAllowedOrigins(
      process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGINS,
    ),
  },
  ai: {
    provider: process.env.AI_PROVIDER || "disabled", // disabled | openai | ollama
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
    ollamaHost: process.env.OLLAMA_HOST || "http://localhost:11434",
    ollamaModel: process.env.OLLAMA_MODEL || "llama3",
    // ARCH-31（2026-09-13）: AI 出站私网豁免（语义见 app.module Joi 段注记）。
    // 默认 false 零行为变化——本地 Ollama（默认 localhost:11434）需显式开启。
    allowPrivateNetwork: process.env.AI_ALLOW_PRIVATE_NETWORK === "true",
  },
  // ARCH-31（2026-09-13）: 事件订阅 webhook 出站私网豁免（订阅创建/更新校验
  // 与 outbox 派发前复核共用此开关）。默认 false 零行为变化。
  eventWebhook: {
    allowPrivateNetwork:
      process.env.EVENT_WEBHOOK_ALLOW_PRIVATE_NETWORK === "true",
  },
  executor: {
    heartbeatInterval:
      parseInt(process.env.EXECUTOR_HEARTBEAT_INTERVAL, 10) || 30000,
    heartbeatTimeoutMultiplier:
      parseInt(process.env.EXECUTOR_HEARTBEAT_TIMEOUT_MULTIPLIER, 10) || 3,
    /**
     * NETOPT-G P1-7（判死迟滞）：连续多少轮扫描命中超时才真正判 OFFLINE。
     *
     * 默认 2；置 1 可恢复修复前的"单次墙钟即判死"行为（回滚开关）。跨境链路
     * 单次心跳失败率约 4.5%，单轮判定会把链路抖动误判为执行器掉线——生产当天
     * 10 次判死里 9 次属此类误判。详见 executor.service 的
     * resolveStaleConfirmations()。
     */
    staleOfflineConfirmations:
      parseInt(process.env.EXECUTOR_STALE_OFFLINE_CONFIRMATIONS, 10) || 2,
    // EXE-VER-1: 执行器最低版本门禁 —— 空（默认）= 关闭，零行为变化。
    // 开启后 register 的 version 低于下限则 403；heartbeat 响应回显
    // minVersion/versionCompliant 供执行器侧漂移告警。比较语义见
    // modules/executor/version-compare.util.ts（畸形版本号放行不锁死）。
    minVersion: process.env.EXECUTOR_MIN_VERSION || "",
    // ARCH-32（ADR-015）：pull 派发长轮询参数。wait = /executors/pull 服务端
    // 等待窗口（须 < 反代 60s 读超时）；ttl = 队列载荷过期丢弃阈值（执行器
    // 长期不拉取时由既有 stale sweep 收敛执行行，队列只负责卫生丢弃）。
    pullWaitMs: parseInt(process.env.EXECUTOR_PULL_WAIT_MS || "25000", 10),
    pullTtlMs: parseInt(process.env.EXECUTOR_PULL_TTL_MS || "900000", 10),
    // ARCH-33（ADR-016）：控制面命令队列的载荷过期阈值。默认 30min，**刻意
    // 长于任务载荷**（15min）：丢任务的后果是执行行卡住、由既有 stale sweep
    // 收敛；丢控制命令没有任何兜底——部署指令消失后 app_deployments 行会停在
    // DEPLOYING 直到 2 分钟的 cron sweep 才判失败，stop/uninstall 这类
    // best-effort 命令丢了连痕迹都没有。
    cmdTtlMs: parseInt(process.env.EXECUTOR_CMD_TTL_MS || "1800000", 10),
    // F-07（本轮审计）: 调度候选执行器池上限（selectLeastLoaded / dispatch 的
    // take 截断）。默认 500 与既有硬编码一致——超过上限的第 501+ 台执行器
    // 永远不进候选集；边缘计算数千台舰队可调大。service 层对非法值回退 500。
    candidatePoolSize: parseInt(
      process.env.EXECUTOR_CANDIDATE_POOL_SIZE || "500",
      10,
    ),
    // ARCH-27: SSRF 豁免开关在此统一注册 —— 运行时消费方
    // （safe-http.util.assertSafeExecutorUrl）经 ConfigService 读取，
    // 不再直读 process.env。
    allowPrivateNetwork: process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK === "true",
    // S-04: shared token executors must present; empty only allowed in dev (with warning)
    sharedToken: (() => {
      // SEC-04: read EXECUTOR_SECRET (matches docker-compose.yml injection key)
      const t =
        process.env.EXECUTOR_SECRET || process.env.EXECUTOR_SHARED_TOKEN || "";
      if (!t) {
        if (process.env.NODE_ENV === "production") {
          throw new Error(
            "[AutoFlow] EXECUTOR_SECRET must be set in production",
          );
        }
        // eslint-disable-next-line no-console
        console.warn(
          "[AutoFlow] WARNING: EXECUTOR_SECRET is empty — executor auth is disabled (dev only)",
        );
      }
      return t;
    })(),
  },
  // P2: stale sweep 重试预算兑现开关。true（默认）时，sweep 赢得 RUNNING→
  // FAILED 条件 UPDATE 后，对重试预算未耗尽的执行创建新 PENDING execution
  // 并入队（re-enqueue 前 best-effort kill 原执行器进程）；false 恢复旧的
  // "只置 FAILED 不重试"行为。见 scheduler.service.recoverStaleExecutions。
  scheduler: {
    staleRecoveryRetryEnabled:
      process.env.STALE_RECOVERY_RETRY_ENABLED !== "false",
  },
  // FEAT-19: 出站 webhook 跨进程 outbox 开关（eventOutbox.enabled 节）。
  // true（默认）时 OutboundEventDispatcher 派发入口同步落 event_outbox 行，
  // OutboxDispatcher 启动 + 每 5s 扫描补投（跨进程重启不丢待投事件，
  // at-least-once）；false 回退纯进程内派发（FEAT-07 原行为）。
  eventOutbox: {
    enabled: process.env.EVENT_OUTBOX_ENABLED !== "false",
  },
  // TASK-SCOPE-01（本轮审计）：执行类写面（trigger/pause/resume）的归属口径开关。
  //
  // 背景：这三个端点是**唯一不做归属校验的写面**——`update`/`delete` 早就要求
  // 属主或 ADMIN，而「执行你的任务」此前对任何已登录用户开放（ADR-013 明确登记
  // 为「既有宽松语义，需产品拍板后才收紧」）。后果：能 list 到任务的人就能触发
  // 别人的生产任务（备份/部署/清理），也能 pause/resume 掉别人的定时任务。
  //
  // 取值（审计 E-P1-S1：默认从 `any` 翻为 `owner`，安全缺省）：
  //   - `owner`（**默认**）：未设置 TASK_OPERATE_SCOPE 时即收紧——仅 ADMIN、任务
  //     属主、或该项目内具备 editor 及以上角色者可 trigger/pause/resume；非成员
  //     按 403。此前默认 `any` 会让任何登录用户操作任意项目任务（E-P1-S1）。
  //   - `any`：运维显式设置 TASK_OPERATE_SCOPE=any 才回退旧宽松语义——任何已登录
  //     用户可操作任意任务（仍保留 AUTH-02 的 viewer 拒绝）。仅确有「全员可跑」
  //     需求的团队显式 opt-out。
  taskScope: {
    operate: process.env.TASK_OPERATE_SCOPE === "any" ? "any" : "owner",
  },
  // N23: dedicated secret for per-execution callback tokens (HMAC key
  // material). Optional: falls back to the executor shared token when
  // unset — executor-node derives the same key from its own env, so both
  // sides must agree on whichever source is active.
  executionCallback: {
    secret: process.env.EXECUTION_CALLBACK_SECRET || "",
  },
  logStorage: {
    // 'db' keeps log lines in execution_log_lines (default);
    // 's3' stores one gzip object per execution (MinIO/S3) and only the
    // object reference in the DB — see optimization-notes 2.6.
    driver: process.env.LOG_STORAGE_DRIVER || "db",
    bucket: process.env.LOG_STORAGE_BUCKET || "autoflow-logs",
    endpoint: process.env.LOG_STORAGE_ENDPOINT || "",
    accessKey: process.env.LOG_STORAGE_ACCESS_KEY || "",
    secretKey: process.env.LOG_STORAGE_SECRET_KEY || "",
    useSSL: process.env.LOG_STORAGE_USE_SSL === "true",
    region: process.env.LOG_STORAGE_REGION || "",
  },
  // R7: Prometheus 抓取端点（GET /api/metrics）开关。
  // enabled=false → 端点 404（多实例下避免重复抓取或安全收紧场景）；
  // defaultMetricsEnabled 控制是否挂载进程默认指标（CPU/内存/GC）。
  metrics: {
    prometheus: {
      enabled: process.env.METRICS_PROMETHEUS_ENABLED !== "false",
      defaultMetricsEnabled:
        process.env.METRICS_PROMETHEUS_DEFAULT_METRICS_ENABLED !== "false",
    },
  },
  // S5: optional Verdaccio service account used by the registry proxy
  // (modules/registry) when listing npm packages. registry-npm requires
  // authentication for every package pattern (`access: $authenticated`),
  // so without these credentials the admin npm package list stays empty
  // (anonymous 401 → []). A pre-issued token (NPM_REGISTRY_TOKEN) wins over
  // user/password login. All three are optional: unset keeps the previous
  // anonymous behavior.
  registry: {
    npm: {
      // R-12（DEEP_REVIEW 0ef3bbe）: Verdaccio registry 基址。此前
      // registry.controller 经 config.get("NPM_REGISTRY_URL") 裸读（其注释
      // 失实声称"registered as optional ... in the Joi schema"，实际仅注册了
      // TOKEN/USER/PASS 三个键）。现收编到 registry.npm.url；默认
      // http://localhost:4873 与旧 controller 回退逐字节一致。
      url: process.env.NPM_REGISTRY_URL || "http://localhost:4873",
      token: process.env.NPM_REGISTRY_TOKEN || "",
      user: process.env.NPM_REGISTRY_USER || "",
      pass: process.env.NPM_REGISTRY_PASS || "",
    },
  },
  notification: {
    // ARCH-31/R17（2026-09-13）: 通知出站私网豁免——企业内网自建网关（内网
    // Alertmanager/IM 机器人代理）场景。默认 false 零行为变化；云元数据恒拒。
    // 五个 webhook 类渠道（wecom/dingtalk/slack/feishu/webhook）共用此开关；
    // email 通道走 SMTP 不经 HTTP SSRF 闸，不受影响。
    allowPrivateNetwork: process.env.NOTIF_ALLOW_PRIVATE_NETWORK === "true",
    wecomWebhook: process.env.WECOM_WEBHOOK || "",
    dingtalkWebhook: process.env.DINGTALK_WEBHOOK || "",
    slackWebhook: process.env.SLACK_WEBHOOK || "",
    // NF-05: 飞书自定义机器人 env 回退（URL + 可选加签 secret）。
    feishuWebhook: process.env.FEISHU_WEBHOOK || "",
    feishuSecret: process.env.FEISHU_SECRET || "",
    email: {
      host: process.env.EMAIL_HOST || "",
      port: parseInt(process.env.EMAIL_PORT, 10) || 465,
      secure: process.env.EMAIL_SECURE !== "false",
      user: process.env.EMAIL_USER || "",
      pass: process.env.EMAIL_PASS || "",
      from: process.env.EMAIL_FROM || "autocodeflow@noreply.com",
      to: process.env.EMAIL_TO || "",
    },
    // ARCH-31: 跨实例共享状态的读穿刷新周期（ms）——渠道配置与通知静默
    // 此前是纯进程内 Map，多实例下「只在接收写请求的那个实例生效」。写穿
    // DB 后各实例按周期读穿，一个周期内跨实例收敛（无需 Redis  pub/sub，
    // 静默/渠道配置都是低频人写、高频热读，TTL 收敛是收益/成本最优解）。
    channelConfigRefreshMs: parseInt(
      process.env.CHANNEL_CONFIG_REFRESH_MS || "15000",
      10,
    ),
    silenceRefreshMs: parseInt(process.env.SILENCE_REFRESH_MS || "15000", 10),
  },
  // ARCH-27: 初次部署 admin 种子账号（users.service onModuleInit）。
  // 此前 users.service 直读 process.env（未注册，审计缺口）；现注册后经
  // ConfigService 读取。INITIAL_ADMIN_PASSWORD 生产弱值/短口令 fail-fast
  // （E-03，此前仅 console.warn，见文件尾）。
  initialAdmin: {
    password: process.env.INITIAL_ADMIN_PASSWORD || "",
    email: process.env.INITIAL_ADMIN_EMAIL || "admin@autoflow.local",
  },
  // ARCH-27: 执行日志保留天数（log-retention-cleanup.service，每日 cron
  // 分批清理 execution_log_lines）。此前该服务直读 process.env 且未注册
  // （审计缺口）；非法值回退逻辑保留在服务内（Joi 注册允许任意字符串）。
  logRetention: {
    days: parseInt(process.env.LOG_RETENTION_DAYS || "30", 10),
  },
  // ARCH-22: execution_log_lines 按日分区的清理路径开关。默认 true——
  // 库已分区化（迁移 1789900000002）时清理走 DETACH PARTITION + 每日
  // 预建未来分区；false 回退 legacy 分批 DELETE 路径（schema 不回滚，
  // 重新开启无需迁移）。
  logPartition: {
    enabled: process.env.LOG_PARTITION_ENABLED !== "false",
  },
  // SEC-02: 任务级 secrets 落库加密的 key（KMS 语义：32 字节 hex/base64，
  // 短口令会被 sha-256 拉伸——建议 openssl rand -hex 32）。未配置时降级
  // 明文存储并 warn 一次（零破坏升级路径），见
  // common/utils/secret-crypto.util.service.ts。
  secrets: {
    key: process.env.SEC_SECRETS_KEY || "",
  },
  // OBS-02: Alertmanager webhook 入站鉴权 secret（POST /api/alerts/webhook
  // 的 HMAC-SHA256 over `${timestamp}.${rawBody}`）。未配置时端点 503 拒绝
  // （安全缺省——绝不退化为无鉴权接收，防告警伪造）。Alertmanager 侧配置
  // 样例见 docs/observability/README.md 的 OBS-02 段。
  alert: {
    webhookSecret: process.env.ALERT_WEBHOOK_SECRET || "",
  },
  // SEC-05: 上传面 zip bomb 防护阈值（common/utils/zip-guard.util.ts，在
  // application / executor-package 上传路径消费）。四项上限均可 env 调整，
  // 缺省即安全值；非法值由 Joi 拒绝（fail-fast）。
  zipGuard: {
    // 解压比上限：CD 声明的 uncompressed 总量 / compressed 总量 ≤ 100。
    maxRatio: parseInt(process.env.ZIP_MAX_RATIO || "100", 10),
    // 条目数上限。
    maxEntries: parseInt(process.env.ZIP_MAX_ENTRIES || "10000", 10),
    // 单文件解压后大小上限（1 GiB）。
    maxFileBytes: parseInt(
      process.env.ZIP_MAX_FILE_BYTES || String(1024 * 1024 * 1024),
      10,
    ),
    // 全包声明解压总量上限（2 GiB）——比率上限无法约束绝对膨胀。
    maxTotalUncompressedBytes: parseInt(
      process.env.ZIP_MAX_TOTAL_BYTES || String(2 * 1024 * 1024 * 1024),
      10,
    ),
    // 嵌套 zip 积极探测层数（默认 1 层；更深层按其声明大小计入外层比率）。
    maxNestingDepth: parseInt(process.env.ZIP_MAX_NESTING_DEPTH || "1", 10),
  },
  // SEC-05: 可选 clamd（ClamAV 守护进程）病毒扫描钩子。默认关闭——零影响；
  // 开启后上传包流式 INSTREAM 送扫，**fail-closed**（扫描不可达/超时/异常
  // 一律拒绝包，安全缺省，见 clamd-scan.util.ts 头注）。
  clamd: {
    enabled: process.env.CLAMD_ENABLED === "true",
    host: process.env.CLAMD_HOST || "127.0.0.1",
    port: parseInt(process.env.CLAMD_PORT || "3310", 10),
    timeoutMs: parseInt(process.env.CLAMD_TIMEOUT_MS || "10000", 10),
  },
  // OBS-01: OpenTelemetry 分布式追踪开关。默认 false——零开销零行为变化
  // （TracingService 全方法短路：不产 span、不生成 traceparent、不加请求头）。
  // true 时进程内 span 树 + traceId 贯穿落库（@opentelemetry/api-only 方案，
  // 不引 sdk-*/exporter——升级路径见 docs/deployment.md OTEL 段）。
  tracing: {
    enabled: process.env.OTEL_ENABLED === "true",
  },
  // WIKI-OPT-1: 健康检查判定阈值与全量响应缓存（health.service 经
  // ConfigService 读取）。队列积压三项阈值与执行器在线比例下限此前
  // 硬编码于 checkQueue/checkExecutors，默认值与原硬编码一致（行为不变）；
  // cacheTtlMs 为 getFullHealth 短 TTL 缓存窗口，默认 0 = 关闭（与未缓存
  // 行为完全一致，live/ready 探针不受影响）。
  health: {
    queueFailedMax: parseInt(process.env.HEALTH_QUEUE_FAILED_MAX || "100", 10),
    queueDelayedMax: parseInt(
      process.env.HEALTH_QUEUE_DELAYED_MAX || "500",
      10,
    ),
    queueWaitingMax: parseInt(
      process.env.HEALTH_QUEUE_WAITING_MAX || "1000",
      10,
    ),
    executorOnlineRatioMin: parseFloat(
      process.env.HEALTH_EXECUTOR_ONLINE_RATIO_MIN || "0.5",
    ),
    cacheTtlMs: parseInt(process.env.HEALTH_CACHE_TTL_MS || "0", 10),
    // NETOPT-5④: 公开健康端点（未鉴权 GET /health）的独立短 TTL 缓存窗口，
    // 默认 5s；0 = 关闭。只缓存 {status, timestamp} 投影，不改变 getFullHealth
    // 缓存默认关闭的语义，详见 health.service 的 publicHealthCache 注释。
    publicCacheTtlMs: parseInt(
      process.env.HEALTH_PUBLIC_CACHE_TTL_MS || "5000",
      10,
    ),
  },
});

/**
 * ARCH-24: TypeORM DataSource 配置构造（纯函数，供 app.module 的
 * TypeOrmModule.forRootAsync 工厂与单测共用）。
 *
 * 读写分离形态（二选一，TypeORM 同一配置对象里 replication 与
 * url/host+port 拆字段互斥）：
 *  - db.readReplicaUrl 为空（默认）→ 沿用既有 host/port/username/...
 *    单连接拆字段形态，产物无 replication 字段，行为与旧版逐字节一致；
 *  - db.readReplicaUrl 非空 → replication 形态 { master: {...}, slaves:
 *    [replicaUrl] }。master 沿用拆字段凭据，slave 用 `url` 单字段——
 *    PostgresDriver.createPool 对两种凭据形态等价支持（credentials.url →
 *    pg connectionString）。仅 replica 的 ssl/额外参数经由 URL query 传递，
 *    master 侧 extra（连接池）两端共享（createPool 把 options.extra 合入
 *    每个连接池）。
 *
 * 路由语义（TypeORM 0.3 内建，无需业务代码参与）：
 *  - SELECT 读面（SelectQueryBuilder.obtainQueryRunner →
 *    DataSource.defaultReplicationModeForReads → "slave"）走 slaves；
 *  - 写面（save/update/delete、QueryBuilder.execute 非查询、事务、
 *    entityManager/repo 默认 "master" 模式）走 master；
 *  - 迁移（migrationsRun → MigrationExecutor → createQueryRunner()
 *    默认 master）恒走 master。
 */
export const buildTypeOrmDataSourceOptions = (config: {
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    poolSize: number;
    readReplicaUrl?: string;
  };
  app: { nodeEnv: string };
}): Record<string, unknown> => {
  const common = {
    entities: [__dirname + "/../**/*.entity{.ts,.js}"],
    migrations: [__dirname + "/../migrations/*{.ts,.js}"],
    migrationsRun: config.app.nodeEnv !== "development",
    synchronize: false,
    logging: config.app.nodeEnv === "development",
    extra: {
      max: config.database.poolSize,
      // F-10（本轮审计）: 保底空闲连接（poolSize/4，至少 1）。此前只配 max，
      // 低负载时全部连接 idle 超时（30s）关闭，突发流量首批发请求需重新建连
      // （PG ~50-100ms）造成延迟抖动；min 让池内常驻保底连接，冷启动毛刺消失。
      // 读写分离形态下 master/slaves 池共享同一 extra（PostgresDriver.createPool
      // 把 options.extra 合入每个连接池），两端同时受益。
      min: Math.max(1, Math.floor(config.database.poolSize / 4)),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      // L-4: per-statement hard timeout (30s) via pg connection option — fails
      // slow/blocked queries instead of pinning a pooled connection forever.
      statement_timeout: 30000,
    },
  };

  // 读写分离关闭（默认）：与旧版一致的单 url 拆字段形态。
  if (!config.database.readReplicaUrl) {
    return {
      type: "postgres",
      host: config.database.host,
      port: config.database.port,
      username: config.database.username,
      password: config.database.password,
      database: config.database.database,
      ...common,
    };
  }

  // 读写分离开启：master 保留拆字段凭据，slaves 用连接串。
  return {
    type: "postgres",
    replication: {
      master: {
        host: config.database.host,
        port: config.database.port,
        username: config.database.username,
        password: config.database.password,
        database: config.database.database,
      },
      // TypeORM 类型面 slaves 声明为凭据对象数组，但 PostgresDriver 等价
      // 支持字符串形式的 { url }（createPool: connectionString: url）——
      // 运行时合法，此处收窄断言；单测钉住产物形态。
      slaves: [config.database.readReplicaUrl],
    },
    ...common,
  } as Record<string, unknown>;
};

// M3: fail-fast in production for critical secrets that have known weak defaults
if (process.env.NODE_ENV === "production") {
  // B-3（SEC-NEW）: registry 出站强制 https —— NPM_REGISTRY_URL /
  // PYPI_REGISTRY_URL 若配 http，其 Basic Auth/token 会明文上网。仅 loopback
  // （localhost / 127.0.0.1 / ::1）允许 http（本地 Verdaccio 默认 4873、
  // registry-pypi 默认 8003 即 http 回环）。URL 内嵌凭据同样拒绝——凭据应
  // 走 NPM_REGISTRY_TOKEN / NPM_REGISTRY_USER / NPM_REGISTRY_PASS / REGISTRY_PASS
  // 独立键，避免经日志/错误回显泄漏。
  const registryUrls: ReadonlyArray<readonly [string, string]> = [
    ["NPM_REGISTRY_URL", process.env.NPM_REGISTRY_URL ?? ""],
    ["PYPI_REGISTRY_URL", process.env.PYPI_REGISTRY_URL ?? ""],
  ];
  for (const [name, raw] of registryUrls) {
    if (!raw) continue;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`[AutoFlow] ${name} is not a valid URL: ${raw}`);
    }
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const isLoopback =
      host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback)) {
      throw new Error(
        `[AutoFlow] ${name} must use https:// in production (http allowed only for localhost/127.0.0.1); got '${u.protocol}//${host}'`,
      );
    }
    if (u.username || u.password) {
      throw new Error(
        `[AutoFlow] ${name} must not embed credentials in the URL — use NPM_REGISTRY_USER/NPM_REGISTRY_PASS or REGISTRY_PASS instead`,
      );
    }
  }

  const weakValues = new Set([
    "autocodeflow123",
    "change-this-secret-in-production",
    "change-me-in-production",
    "postgres",
    "",
    "admin123",
    "password",
    "secret",
    "changeme",
    "change-me-at-least-32-chars-in-production",
    "change-me-refresh-secret-at-least-32-chars",
    "change-me-executor-shared-secret",
    "change-me-pypi-password",
    "change-me-pypi-api-key",
    "change_me_to_a_random_secret_32chars",
    "change_me_to_another_random_secret_32chars",
    "change_me_to_a_random_token_16chars",
    "change_me_immediately",
  ]);

  // Validate database password
  const dbPassword = process.env.DB_PASSWORD ?? "";
  if (weakValues.has(dbPassword) || dbPassword.length < 16) {
    throw new Error(
      "[AutoFlow] DB_PASSWORD must be set to a strong value (>=16 chars, not a weak default) in production",
    );
  }

  // Validate JWT secrets
  const jwtSecret = process.env.JWT_SECRET ?? "";
  if (weakValues.has(jwtSecret) || jwtSecret.length < 32) {
    throw new Error(
      "[AutoFlow] JWT_SECRET must be set to a strong value (>=32 chars, not a weak default) in production",
    );
  }

  const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET ?? "";
  if (weakValues.has(jwtRefreshSecret) || jwtRefreshSecret.length < 32) {
    throw new Error(
      "[AutoFlow] JWT_REFRESH_SECRET must be set to a strong value (>=32 chars, not a weak default) in production",
    );
  }

  // Validate executor secret
  const executorSecret =
    process.env.EXECUTOR_SECRET || process.env.EXECUTOR_SHARED_TOKEN || "";
  if (weakValues.has(executorSecret) || executorSecret.length < 16) {
    throw new Error(
      "[AutoFlow] EXECUTOR_SECRET must be set to a strong value (>=16 chars, not a weak default) in production",
    );
  }

  // ARCH-001: production 必须配置显式 CORS 白名单。优先 CORS_ALLOWED_ORIGINS；
  // 未设置新变量时回退校验旧的 CORS_ORIGINS（保持向后兼容）。
  const corsAllowed = parseAllowedOrigins(
    process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGINS,
  );
  if (corsAllowed.length === 0) {
    throw new Error(
      "[AutoFlow] CORS_ALLOWED_ORIGINS must be set to explicit production origins in production",
    );
  }
  if (
    corsAllowed.some((o) => o.includes("localhost") || o.includes("127.0.0.1"))
  ) {
    throw new Error(
      "[AutoFlow] CORS_ALLOWED_ORIGINS must not contain localhost/127.0.0.1 in production",
    );
  }

  // SEC-02 / ARCH-27 收编: production 下每个 CORS origin 必须是合法的
  // http(s) URL —— 此前该校验在 main.ts bootstrap 内直读 env 重复实现，
  // 现收编到配置层（fail-fast 时点从 NestFactory.create 前移至 ConfigModule
  // 初始化，仍在监听端口之前），main.ts 保留复核注释。
  for (const origin of corsAllowed) {
    if (!origin.startsWith("https://") && !origin.startsWith("http://")) {
      throw new Error(
        `CORS_ALLOWED_ORIGINS origin "${origin}" must start with http:// or https://`,
      );
    }
    try {
      new URL(origin);
    } catch {
      throw new Error(
        `CORS_ALLOWED_ORIGINS origin "${origin}" is not a valid URL`,
      );
    }
  }

  // ARCH-006: production 显式请求 DB_SYNCHRONIZE=true 时 fail-fast，
  // 防止不受控的 schema 修改；synchronize 一律走 migrations。
  if (process.env.DB_SYNCHRONIZE === "true") {
    throw new Error(
      "[AutoFlow] DB_SYNCHRONIZE=true is forbidden in production — use migrations instead",
    );
  }

  // E-03: INITIAL_ADMIN_PASSWORD 弱值 fail-fast —— 仅在该值存在时校验。
  // 未设置（空串）放行，与 users.service「未设置即跳过初始管理员种子」的
  // 既有行为兼容（此时不创建 admin 账号）；一旦设置了弱口令（含 compose
  // 曾内置的缺省 Admin@123456 与 .env.example 旧占位 change_me_immediately）
  // 或短口令（<8 字符）则拒绝启动，防止新部署以可预测口令暴露在可路由网络。
  const initialAdminPassword = process.env.INITIAL_ADMIN_PASSWORD ?? "";
  if (initialAdminPassword.length > 0) {
    const weakAdminPasswords = new Set([
      ...weakValues,
      "Admin@123456", // docker-compose.yml 旧缺省口令
      "12345678",
    ]);
    if (
      weakAdminPasswords.has(initialAdminPassword) ||
      initialAdminPassword.length < 8
    ) {
      throw new Error(
        "[AutoFlow] INITIAL_ADMIN_PASSWORD must be a strong value (>=8 chars, not a weak/known default) in production — leave it unset to skip initial admin seeding",
      );
    }
  }
}
