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
});
