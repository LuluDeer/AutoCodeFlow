import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
  PROTOCOL_NETWORK_POLICY,
  PROTOCOL_ERROR_STATUS_CODES,
  PROTOCOL_TASK_FIELD_ALIASES,
  PROTOCOL_TIMEOUT_PRECEDENCE,
  PROTOCOL_CALLBACK_LOG_RETENTION,
} from "./generated/protocol.schemas";

const PROTOCOL_RELATIVE = path.join(
  "packages",
  "executor-protocol",
  "protocol.json",
);

function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, PROTOCOL_RELATIVE))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`executor-protocol/protocol.json not found above ${from}`);
}

const protocol = JSON.parse(
  readFileSync(path.join(findRepoRoot(__dirname), PROTOCOL_RELATIVE), "utf-8"),
);

/**
 * R2-1/P1a：五个「只读消费段」的**契约即常量**断言。
 *
 * ## 这批用例钉住什么
 *
 * R2-1 评估轮查明：protocol.json 的段里，**只有 `schemas` 段**被运行时真正消费，
 * 其余各段全是 `guard-only`（运行时零消费 + 实现侧手抄 N 份）—— 「契约说有、
 * 但两端各抄一份」正是漂移宿主。
 *
 * P1a 把五个新段（`networkPolicy` / `errorStatusCodes` / `taskFieldAliases` /
 * `timeoutPrecedence` / `callbackLogRetention`）**以只读常量**发射到两侧，
 * 并断言：
 *   ① 生成物与 `protocol.json` **逐字段相等**（不是抽样，是全量深比较）；
 *   ② 段级元数据键（`xConsumption` / `xConsumptionNote`）**不在**常量里
 *      （它们是「这段怎么被消费」的治理元数据，不是规则本体）。
 *
 * ## 为什么 P1a 只断言「常量 == 协议」，不断言「实现 == 常量」
 *
 * 因为**两侧运行时的判定逻辑本批不动**（P1b 才改行为）。若在 P1a 就断言
 * 「实现读常量」，会逼着两侧立刻改行为 —— 那就把「协议扩段」与「行为变更」
 * 混进一个 commit，失去 P1a 可独立回滚的意义（Lead 明确要求两个 commit）。
 *
 * ⇒ 本文件是「**契约已就位**」的证明；「**两侧按它实现**」由 P1b 的用例证明。
 */
const SEGMENTS: [string, unknown][] = [
  ["networkPolicy", PROTOCOL_NETWORK_POLICY],
  ["errorStatusCodes", PROTOCOL_ERROR_STATUS_CODES],
  ["taskFieldAliases", PROTOCOL_TASK_FIELD_ALIASES],
  ["timeoutPrecedence", PROTOCOL_TIMEOUT_PRECEDENCE],
  ["callbackLogRetention", PROTOCOL_CALLBACK_LOG_RETENTION],
];

/** 剔除段级治理元数据键（与生成器的 stripMeta 同规则）。 */
function stripMeta(seg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(seg)) {
    if (k.startsWith("x") || k.startsWith("$")) continue;
    out[k] = v;
  }
  return out;
}

describe("R2-1/P1a 只读消费段（生成物 ≡ protocol.json）", () => {
  it("扫描面非空——五个段都存在且生成物已接线（防扫描器静默失效）", () => {
    expect(SEGMENTS.length).toBe(5);
    for (const [name, value] of SEGMENTS) {
      expect(value).toBeDefined();
      expect(Object.keys(value as object).length).toBeGreaterThan(0);
      expect(name).toBeTruthy();
    }
  });

  it.each(SEGMENTS)("%s 段：生成物与 protocol.json 逐字段相等", (name, generated) => {
    const raw = protocol[name] as Record<string, unknown>;
    expect(raw).toBeDefined();
    expect(generated).toEqual(stripMeta(raw));
  });

  it.each(SEGMENTS)("%s 段：生成物不含段级治理元数据（xConsumption/xConsumptionNote）", (_name, generated) => {
    const keys = Object.keys(generated as object);
    expect(keys.some((k) => k.startsWith("x"))).toBe(false);
    expect(keys.some((k) => k.startsWith("$"))).toBe(false);
  });

  // ── 各段的**关键裁定**单点断言（防止将来有人把裁定值改掉而不自知）──────

  it("networkPolicy：linkLocal 的 examples 含两个云元数据地址（IPv4 + AWS IPv6）", () => {
    const np = PROTOCOL_NETWORK_POLICY as unknown as {
      addresses: Record<string, { examples: string[] }>;
    };
    // R2-1/P1b：fd00:ec2::254（AWS IPv6 元数据）从「只在 $comment 提到」升级为
    // **可断言的 examples 条目**（Lead 要求）。
    expect(np.addresses.linkLocal.examples).toContain("169.254.169.254");
    expect(np.addresses.linkLocal.examples).toContain("fd00:ec2::254");
  });

  it("errorStatusCodes：pull 路径的等价失败形态已登记（failed 回调，非 400）", () => {
    const es = PROTOCOL_ERROR_STATUS_CODES as unknown as {
      pullPathEquivalent: {
        stage: string;
        equivalentForm: string;
        failureReason: string;
        mustNotLeaveLiveEntry: boolean;
        mustNotCreateWorkDir: boolean;
        mustReleaseReservedSlot: boolean;
      };
      vectors: { name: string; expectedCallback?: unknown; expectedHttpStatus?: unknown }[];
    };
    const pull = es.pullPathEquivalent;
    expect(pull).toBeDefined();
    expect(pull.stage).toBe("pull");
    expect(pull.equivalentForm).toBe("failed-callback");
    expect(pull.failureReason).toBe("unknown");
    // 三条不变量同样适用于 pull 路径
    expect(pull.mustNotLeaveLiveEntry).toBe(true);
    expect(pull.mustNotCreateWorkDir).toBe(true);
    // E-01 预留槽必须归还（否则预留泄漏）
    expect(pull.mustReleaseReservedSlot).toBe(true);
    // 且有一条专门向量
    const vec = es.vectors.find((v) => v.name === "pull-path-rejection-is-failed-callback");
    expect(vec).toBeDefined();
    expect(vec!.expectedHttpStatus).toBeNull();
  });

  it("networkPolicy：六类受限地址齐备，且云元数据 169.254.169.254 不可被开关放行", () => {
    const np = PROTOCOL_NETWORK_POLICY as unknown as {
      addresses: Record<string, { examples: string[]; allowedUnderPrivateNetwork: boolean }>;
      resolution: { mode: string; onResolutionFailure: string };
      enforcement: { stage: string; httpStatus: number };
      switch: { envVar: string };
    };
    // 六类（+privateIPv4 共七类）
    for (const key of [
      "loopback",
      "privateIPv4",
      "linkLocal",
      "cgnat",
      "unspecified",
      "multicast",
      "reserved",
    ]) {
      expect(np.addresses[key]).toBeDefined();
    }
    // 云元数据必须在 linkLocal 的样例里，且**不随** private-network 开关放行
    expect(np.addresses.linkLocal.examples).toContain("169.254.169.254");
    expect(np.addresses.linkLocal.allowedUnderPrivateNetwork).toBe(false);
    // loopback 同样不随开关放行（打自己回环没有合法拓扑）
    expect(np.addresses.loopback.allowedUnderPrivateNetwork).toBe(false);
    // 只有私网可被开关放行
    expect(np.addresses.privateIPv4.allowedUnderPrivateNetwork).toBe(true);
    // DNS 解析 + fail-closed
    expect(np.resolution.mode).toBe("dns-resolve");
    expect(np.resolution.onResolutionFailure).toBe("deny");
    // accept 期同步拒 + 400
    expect(np.enforcement.stage).toBe("accept");
    expect(np.enforcement.httpStatus).toBe(400);
  });

  it("errorStatusCodes：拒绝一律 400（不是框架默认的 422），且四条不变量齐备", () => {
    const es = PROTOCOL_ERROR_STATUS_CODES as unknown as {
      rejectedRequest: { httpStatus: number };
      protocolViolation: { httpStatus: number };
      policyRejection: { httpStatus: number };
      capacityRejection: { httpStatus: number; retryable: boolean };
      shuttingDownRejection: { httpStatus: number; retryable: boolean };
      invariants: string[];
    };
    expect(es.rejectedRequest.httpStatus).toBe(400);
    expect(es.protocolViolation.httpStatus).toBe(400);
    expect(es.policyRejection.httpStatus).toBe(400);
    expect(es.capacityRejection.httpStatus).toBe(429);
    expect(es.capacityRejection.retryable).toBe(true);
    expect(es.shuttingDownRejection.httpStatus).toBe(503);
    expect(es.shuttingDownRejection.retryable).toBe(true);
    // 四条不变量（accept 期可见 / 不留 live 条目 / 不落盘 / 不占容量）
    expect(es.invariants.length).toBeGreaterThanOrEqual(4);
    expect(es.invariants.join("\n")).toContain("accept");
  });

  it("taskFieldAliases：gitRepo/git_repo 已登记（此前协议未声明、node 侧不读）", () => {
    const ta = PROTOCOL_TASK_FIELD_ALIASES as unknown as {
      aliases: { canonical: string; alias: string; wireAdded: boolean }[];
      rules: string[];
    };
    const pairs = ta.aliases.map((a) => `${a.canonical}<->${a.alias}`);
    expect(pairs).toContain("gitRepo<->git_repo");
    expect(pairs).toContain("gitCommit<->git_commit");
    expect(pairs).toContain("gitBranch<->git_branch");
    // 别名**不改变线缆载荷形状** ⇒ wireAdded 全 false ⇒ 不 bump 协议版本
    expect(ta.aliases.every((a) => a.wireAdded === false)).toBe(true);
    expect(ta.rules.length).toBeGreaterThanOrEqual(4);
  });

  it("timeoutPrecedence：正名优先、旁键不校验（python 现状是逐键全检 —— 这是裁定点）", () => {
    const tp = PROTOCOL_TIMEOUT_PRECEDENCE as unknown as {
      order: string[];
      rule: string;
      ignoredAliasesAreNotValidated: boolean;
      selectedValueBounds: { min: number; max: number; zeroMeans: string };
    };
    expect(tp.order).toEqual(["timeoutSeconds", "timeout_seconds", "timeout"]);
    expect(tp.rule).toBe("canonical-first");
    expect(tp.ignoredAliasesAreNotValidated).toBe(true);
    expect(tp.selectedValueBounds.min).toBe(1);
    expect(tp.selectedValueBounds.max).toBe(86400);
    expect(tp.selectedValueBounds.zeroMeans).toBe("unlimited");
  });

  it("callbackLogRetention：头尾各 500KB（尾部诊断价值最高）+ marker 命中 admin 正则", () => {
    const cr = PROTOCOL_CALLBACK_LOG_RETENTION as unknown as {
      inMemory: { mode: string; headChars: number; tailChars: number };
      marker: { pattern: string; requiredTokens: string[] };
      finalCallbackChars: { default: number; adminCap: number; envVar: string };
    };
    expect(cr.inMemory.mode).toBe("head-tail");
    expect(cr.inMemory.headChars).toBe(500_000);
    expect(cr.inMemory.tailChars).toBe(500_000);
    // marker 必须命中 admin 的 LOG_TRUNCATION_MARKER
    expect(new RegExp(cr.marker.pattern, "i").test("[logs truncated in memory, 123 chars total]")).toBe(true);
    // 上报给 admin 的最终长度（另一层上限）
    expect(cr.finalCallbackChars.default).toBe(10_000);
    expect(cr.finalCallbackChars.adminCap).toBe(512_000);
  });
});
