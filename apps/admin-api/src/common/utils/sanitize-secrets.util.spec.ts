/**
 * 共享脱敏实现的单测（N8：通知面的脱敏器比 tool-executor 弱一档）。
 *
 * 三个**运行时入口**逐个跑同一组断言——它们必须给出**同一个字符串**：
 *   · `sanitizeSecrets`（`common/utils`，规则本体）
 *   · `sanitizeNotificationText`（通知出站，薄转发）
 *   · `sanitizeString`（agent 面，薄转发 + 4000 上限）
 * ai / sop 两个服务面入口是 private 方法（Nest 装饰器让 Node 类型擦除跑不动），
 * 由 `scripts/check-sanitize-parity.mjs` 的**结构判据**守（必须 import 共享实现、
 * 方法体内不得再内联规则），本文件只在各自的 spec 里补行为断言。
 */
import { sanitizeSecrets } from "./sanitize-secrets.util";
import { sanitizeNotificationText } from "../../modules/notification/sanitize-notification-text.util";
import { sanitizeString } from "../../modules/agent/tools/agent-sanitize.util";

const ENTRIES: Array<[string, (s: string) => string]> = [
  ["shared", (s) => sanitizeSecrets(s)],
  ["notification", (s) => sanitizeNotificationText(s)],
  ["agent", (s) => sanitizeString(s)],
];

describe("共享脱敏实现（三个入口逐字一致）", () => {
  // ── ① 缺陷本体：小写/混写凭据必须被打码 ──────────────────────────
  it.each(ENTRIES)(
    "%s 入口：小写凭据赋值被打码（N8 回归，此前通知面明文外发）",
    (_name, fn) => {
      expect(fn("apiKey=sk-live-abc123")).toBe("apiKey=[REDACTED]");
      expect(fn("token=abcdef123456")).toBe("token=[REDACTED]");
      // 键名后的引号会被当成「值的可选引号」吃掉（既有行为，未改）：
      // 输出不是合法 JSON，但凭据一定被替换——预览侧由 JSON.stringify 重新加引号。
      expect(fn('{"api_key": "json-plaintext-key"}')).toBe(
        '{"api_key": [REDACTED]}',
      );
      expect(fn("password: hunter2")).toBe("password: [REDACTED]");
    },
  );

  it.each(ENTRIES)(
    "%s 入口：全大写 env 赋值被打码（既有规则不回退）",
    (_n, fn) => {
      expect(fn("AUTOFLOW_TOKEN=abc123")).toBe("AUTOFLOW_TOKEN=[REDACTED]");
    },
  );

  it.each(ENTRIES)(
    "%s 入口：Bearer 先于凭据赋值匹配（顺序不可换）",
    (_n, fn) => {
      // 若凭据赋值规则先吃掉 `Bearer` 这个词，JWT 就会裸露——用断言钉住顺序。
      const out = fn("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig");
      expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(out).toContain("[REDACTED]");
    },
  );

  it.each(ENTRIES)("%s 入口：32+ hex / 40+ base64 打码", (_n, fn) => {
    expect(fn("key=deadbeefcafebabe0123456789abcdef")).toContain(
      "[REDACTED_HEX]",
    );
    expect(
      fn(
        "blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHU=",
      ),
    ).toContain("[REDACTED_B64]");
  });

  it.each(ENTRIES)("%s 入口：已知前缀密钥（sk- / ghp_）打码", (_n, fn) => {
    expect(fn("leaked sk-abcdefghijklmnop end")).toBe("leaked [REDACTED] end");
    expect(fn("leaked ghp_abcdefghijklmnopqrst end")).toBe(
      "leaked [REDACTED] end",
    );
  });

  // ── ② 防空转：正常文案逐字保留（脱敏不是「全打码」）──────────────
  it.each(ENTRIES)("%s 入口：正常文案不被误伤（防空转断言）", (_n, fn) => {
    for (const plain of [
      "script_error: Traceback\ndivide by zero",
      "请确认部署窗口是否在 2026-10-01 之后",
      "retries=3 timeout=30 path=/srv/app",
      "Task failed: nightly-etl",
    ]) {
      expect(fn(plain)).toBe(plain);
    }
  });

  it.each(ENTRIES)("%s 入口：空串原样返回", (_n, fn) => {
    expect(fn("")).toBe("");
  });

  /**
   * R42（承接 R41 遗留①）：**规则 ⑥ 连接串内嵌凭据**必须有**正向**单测。
   *
   * R41 只在 tool-executor 的失败路径里**间接**覆盖了这条规则（断言"不含明文"），
   * 那种断言在规则被整体删掉时也可能因为别的原因通过。这里直接钉住**输出形态**：
   * 只掩码 userinfo 的密码，`scheme`/用户名/`host`/`path` 全部保留（日志仍能定位是哪个库）。
   */
  it("规则⑥：连接串内嵌凭据只掩密码，scheme/用户名/host/path 保留", () => {
    expect(sanitizeSecrets("postgres://u:p@h/db")).toBe(
      "postgres://u:[REDACTED]@h/db",
    );
    // 真实 DSN（端口 + 库名 + 查询串）：只动密码
    expect(
      sanitizeSecrets(
        "db=postgres://appuser:supersecret@db.internal:5432/appdb?sslmode=require",
      ),
    ).toBe(
      "db=postgres://appuser:[REDACTED]@db.internal:5432/appdb?sslmode=require",
    );
    // 其它 scheme 同样覆盖（redis/amqp）
    expect(sanitizeSecrets("redis://default:s3cret@cache:6379/0")).toBe(
      "redis://default:[REDACTED]@cache:6379/0",
    );
    // 无凭据的连接串**不得**被误伤
    expect(sanitizeSecrets("postgres://h/db")).toBe("postgres://h/db");
  });

  // ── ③ 两个「策略」参数（不是规则差异）─────────────────────────────
  it("preserveDigests：整体 digest 原值保留（对账用），且仅显式开启时生效", () => {
    const sha256 = "a".repeat(64);
    expect(sanitizeSecrets(sha256)).toBe("[REDACTED_HEX]");
    expect(sanitizeSecrets(sha256, { preserveDigests: true })).toBe(sha256);
  });

  it("maxLength：打码**之后**再截断（跨边界凭据不留半截）", () => {
    const out = sanitizeSecrets(`${"字".repeat(30)} token=abcdefghijklmnop`, {
      maxLength: 40,
    });
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).not.toContain("abcdefgh");
  });

  it("三个入口对混合文案输出逐字相同（跨面一致）", () => {
    const mixed =
      "AUTOFLOW_TOKEN=x9 apiKey=sk-live-1 token=abcdef " +
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.sig " +
      "sha=deadbeefcafebabe0123456789abcdef";
    const outputs = new Set(ENTRIES.map(([, fn]) => fn(mixed)));
    expect(outputs.size).toBe(1);
  });

  // ── ④ R289-C1：值级敏感凭据防线（PEM / 裸 JWT / 供应商前缀 / 空用户名 URL / Basic / 高熵）──
  it.each(ENTRIES)(
    "%s 入口：PEM 私钥多形态（多行闭合 + 保尾 / JSON 转义 \\n / 未闭合截断），不误伤公钥证书",
    (_n, fn) => {
      // ① 完整多行块 + 尾部正常文本保留（防贪婪吞尾）
      const multiline =
        "prefix\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----\nfor staging";
      const outMulti = fn(multiline);
      expect(outMulti).toBe("prefix\n[REDACTED_PEM]\nfor staging");

      // ② JSON 转义单行 \\n 闭合块 + 保尾
      const escapedClosed =
        "-----BEGIN EC PRIVATE KEY-----\\nMHcCAQEEI1234\\n-----END EC PRIVATE KEY-----\\nfor prod";
      expect(fn(escapedClosed)).toBe("[REDACTED_PEM]\\nfor prod");

      // ③ JSON 转义单行 \\n 未闭合块
      const escapedOpen =
        "-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXktdjE=\\nMIIEpAIB";
      const outEscapedOpen = fn(escapedOpen);
      expect(outEscapedOpen).toBe("[REDACTED_PEM]");
      expect(outEscapedOpen).not.toContain("b3BlbnNzaC1rZXktdjE=");

      // ④ ≤200 字符截断未闭合多行块 + 空行后保尾
      const truncated =
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQE\n\nfor staging";
      const outTrunc = fn(truncated);
      expect(outTrunc).toBe("[REDACTED_PEM]\n\nfor staging");
      expect(outTrunc).not.toContain("MIIEvQIBADAN");

      // ⑤ 公钥证书不误打
      const pubCert =
        "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkq\n-----END CERTIFICATE-----";
      expect(fn(pubCert)).toBe(pubCert);
    },
  );

  it.each(ENTRIES)(
    "%s 入口：裸 JWT（含 eyJ 与非 eyJ 起始 JSON）均被打码",
    (_n, fn) => {
      const stdJwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      expect(fn(`note ${stdJwt} end`)).toBe("note [REDACTED_JWT] end");

      // JSON 以空格/数字键起始时 base64url 为 eyA / eyI
      const altJwt = "eyAiYWxnIjoiSFMyNTYifQ.eyIzIjoiMSJ9.abcdef123456_XYZ";
      expect(fn(altJwt)).toBe("[REDACTED_JWT]");
    },
  );

  it.each(ENTRIES)(
    "%s 入口：主流供应商密钥前缀（github_pat_/AKIA/ASIA/xoxb-/xoxp-/glpat-/rk_live_/whsec_/AIza/npm_/hf_）打码",
    (_n, fn) => {
      const secrets = [
        "github_pat_11ABCDEFG0123456789_abcdefghijklmnop123456",
        "AKIAIOSFODNN7EXAMPLE",
        "ASIAIOSFODNN7EXAMPLE",
        "xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
        "xoxp-123456789012-1234567890123-1234567890123-abcdef1234567890",
        "glpat-AbCdEf1234567890xxxx",
        "rk_live_1234567890abcdef12345678",
        "whsec_1234567890abcdef12345678",
        "AIzaSyD1234567890abcdefGHIJKLMNOPQRSTUV",
        "npm_1234567890abcdef1234567890abcdef1234",
        "hf_1234567890abcdef1234567890abcdef",
      ];
      for (const s of secrets) {
        const out = fn(`val ${s} ok`);
        expect(out).not.toContain(s);
        expect(out).toBe("val [REDACTED] ok");
      }
    },
  );

  it.each(ENTRIES)(
    "%s 入口：URL 内嵌空用户名凭据（redis://:pass@host / http://:pass@host）打码且不误伤普通 URL",
    (_n, fn) => {
      expect(fn("redis://:myRedisPass@cache.internal:6379/0")).toBe(
        "redis://:[REDACTED]@cache.internal:6379/0",
      );
      expect(fn("http://:secretpass@internal:8080/api")).toBe(
        "http://:[REDACTED]@internal:8080/api",
      );
      expect(fn("https://user@host.internal/path")).toBe(
        "https://user@host.internal/path",
      );
      expect(fn("https://example.com:8080/user@example.com")).toBe(
        "https://example.com:8080/user@example.com",
      );
      expect(fn("git@github.com:AutoCodeFlow/AutoCodeFlow.git")).toBe(
        "git@github.com:AutoCodeFlow/AutoCodeFlow.git",
      );
    },
  );

  it.each(ENTRIES)(
    "%s 入口：Authorization: Basic 先于凭据赋值匹配（顺序不可换），不误伤 Basic 英文短语",
    (_n, fn) => {
      const out = fn("Authorization: Basic dXNlcjpzZWNyZXRwYXNz");
      expect(out).not.toContain("dXNlcjpzZWNyZXRwYXNz");
      expect(out).toContain("[REDACTED]");

      const outJson = fn('{"Authorization": "Basic dXNlcjpzZWNyZXRwYXNz"}');
      expect(outJson).not.toContain("dXNlcjpzZWNyZXRwYXNz");

      expect(fn("Basic configuration for service")).toBe(
        "Basic configuration for service",
      );
    },
  );

  it.each(ENTRIES)(
    "%s 入口：高熵词元通道 A（无斜杠 24+）与通道 B（独立含 `/` 40 位 AWS Secret）打码",
    (_n, fn) => {
      const tok24 = "9xK2mP7vL4qR8nW3zJ6cH5bT";
      const tok32 = "k8J2mP9qR4sT6vW1xY3zA5bC7dE9fG2h";
      const awsSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      expect(fn(`note ${tok24} end`)).toBe("note [REDACTED_HIGH_ENTROPY] end");
      expect(fn(`note ${tok32} end`)).toBe("note [REDACTED_HIGH_ENTROPY] end");
      expect(fn(`val ${awsSecret} end`)).toBe(
        "val [REDACTED_HIGH_ENTROPY] end",
      );
      expect(fn(`{"s":"${awsSecret}"}`)).toBe(
        '{"s":"[REDACTED_HIGH_ENTROPY]"}',
      );
      // R289 红队回归：字符类 `-` 置于末尾，避免 `=-\\` 范围吞进 `[` / `@` / `?` 导致漏网
      expect(fn(`[${awsSecret}]`)).toBe("[[REDACTED_HIGH_ENTROPY]]");
      expect(fn(`user@${awsSecret}`)).toBe("user@[REDACTED_HIGH_ENTROPY]");
      expect(fn(`q?${awsSecret}`)).toBe("q?[REDACTED_HIGH_ENTROPY]");
    },
  );

  it("preserveDigests 双向：64 位 hex 原样保留，40 位高熵混合串仍被打码", () => {
    const sha256 =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const highEntropy = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    expect(sanitizeSecrets(sha256, { preserveDigests: true })).toBe(sha256);
    expect(sanitizeSecrets(highEntropy, { preserveDigests: true })).toBe(
      "[REDACTED_HIGH_ENTROPY]",
    );
  });

  it.each(ENTRIES)(
    "%s 入口：正常标识符/路径/URL/时间/cron/预览占位符零误伤",
    (_n, fn) => {
      const benign = [
        "550e8400-e29b-41d4-a716-446655440000",
        "2026-11-20T15:34:02.123Z",
        "*/15 0-23 * * 1-5",
        "/data/project/AutoCodeFlow/apps/admin-api/src/modules/agent/tools/agent-sanitize.util.ts",
        "C:\\Users\\admin\\AutoCodeFlow\\apps\\executor-desktop\\config.json",
        "https://registry.npmjs.org/@autocodeflow/cli/-/cli-2.1.0.tgz",
        "https://api.example.com/v1/deployments/550e8400-e29b-41d4-a716-446655440000",
        "ghcr.io/autocodeflow/executor-node:v2.1.0-alpine3.20",
        "1790000000096-AddConsumedFirePointAtToTasks",
        "apr-s-1-stop_deployment-x",
        "aprs-s-1-0123456789abcdef",
        "Http2ClientRetryStrategyV3Handler",
        "请确认是否暂停 nightly-etl-prod-v2 调度任务并通知值班负责人",
        "Deployment d1 failed with ECONNREFUSED on executor-node-01:4001",
        "[omitted string len=412 sha256=a1b2c3d4e5f67890]",
        "[executable code len=480 lines=1 sha256=a1b2c3d4e5f67890]",
      ];
      for (const s of benign) {
        expect(fn(s)).toBe(s);
      }
    },
  );

  it("二次脱敏 100% 幂等（所有新增 REDACTED 标记再过一遍不发生二次改写）", () => {
    const inputs = [
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----\nfor staging",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnop123456",
      "redis://:myRedisPass@cache.internal:6379/0",
      "Authorization: Basic dXNlcjpzZWNyZXRwYXNz",
      "k8J2mP9qR4sT6vW1xY3zA5bC7dE9fG2h",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ];
    for (const raw of inputs) {
      const once = sanitizeSecrets(raw);
      const twice = sanitizeSecrets(once);
      expect(twice).toBe(once);
    }
  });
});
