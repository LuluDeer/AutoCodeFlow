import { FindOperator } from "typeorm";

import {
  AGENT_APPROVAL_TTL_MS,
  AgentApprovalsService,
  APPROVAL_POLICY_FINGERPRINT_KEYS,
  SESSION_SCOPE_ELIGIBLE_TOOLS,
  SESSION_SCOPE_EXCLUDED_TOOLS,
  computeApprovalPolicyFingerprint,
  isSessionScopeEligible,
} from "../runtime/agent-approvals.service";
import type { AgentApproval } from "../entities/agent-approval.entity";

/**
 * N3 + S1-C2（R8 / R9 缩窄版）的**服务层**规格。
 *
 * 这一层要钉死的是三件互不重叠的事：
 *   ① 策略指纹的**确切定义**（确定性 / 覆盖项集合 / 对每个策略项的敏感性）；
 *   ② `consume` 的 fail-closed：指纹不一致、指纹读不到、行没记录指纹 —— 三种
 *      都必须**拒绝领取**（而且拒绝发生在 SQL 谓词里，不是先读后判）；
 *   ③ 会话级授权是**派生行**：只对 3 个收敛操作派生、带有效期/署名/指纹，
 *      命中要求「同会话 + 同工具 + 同参 + 指纹一致 + 未过期」，且**永不被 consume**。
 *
 * 执行体那一层（N3 的拦截文案、S1-C2 的免审放行）在
 * `tools/__tests__/tool-executor.service.spec.ts` 里钉，不在这里重复。
 */

/**
 * 忠实模拟 TypeORM 的最小内存表。
 *
 * 为什么要它而不是 `jest.fn()`：N3 / S1-C2 的判据**住在谓词里**（`consume` 的
 * WHERE 含 `policyFingerprint` 与 `scope`；`findActiveSessionGrant` 的 WHERE 含
 * `argsDigest` / `expiresAt > now`）。用"恒返回 affected:1"的替身测不出
 * 「谓词写错了」，而那正是本轮最需要钉的地方。这里按 where 逐键求值，
 * 匹配不上就返回 affected 0 / null —— 与真库语义一致。
 */
function makeRepo(initial: Array<Partial<AgentApproval>> = []) {
  const table = initial.map((r) => ({ ...r })) as Array<
    Record<string, unknown>
  >;

  const matches = (
    row: Record<string, unknown>,
    where: Record<string, unknown>,
  ) =>
    Object.entries(where).every(([k, v]) => {
      if (v instanceof FindOperator) {
        const target = v.value as Date;
        const cell = row[k];
        if (!(cell instanceof Date)) return false;
        if (v.type === "moreThan") return cell.getTime() > target.getTime();
        throw new Error(`unsupported FindOperator ${v.type}`);
      }
      return row[k] === v;
    });

  const repo = {
    __table: table,
    create: jest.fn((x: unknown) => x),
    save: jest.fn(async (x: Record<string, unknown>) => {
      table.push({ ...x });
      return x;
    }),
    insert: jest.fn(async (x: Record<string, unknown>) => {
      if (table.some((r) => r.approvalKey === x.approvalKey)) {
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      }
      table.push({ ...x });
      return x;
    }),
    findOne: jest.fn(async (opts: { where: Record<string, unknown> }) => {
      // TypeORM 的 findOne 在有多行匹配时返回"任意一行"（这里取第一行即可：
      // 调用方依赖的是 where 的收敛性，不是顺序）。
      const hit = table.find((r) => matches(r, opts.where));
      return hit ? { ...hit } : null;
    }),
    find: jest.fn(async (opts: { where: Record<string, unknown> }) => {
      return table.filter((r) => matches(r, opts.where)).map((r) => ({ ...r }));
    }),
    update: jest.fn(
      async (
        criteria: Record<string, unknown>,
        patch: Record<string, unknown>,
      ) => {
        const hit = table.filter((r) => matches(r, criteria));
        for (const r of hit) Object.assign(r, patch);
        return { affected: hit.length };
      },
    ),
  };
  return repo;
}

/** 与 harness 的 boundary 默认策略一致（config.get 恒 undefined ⇒ 全默认）。 */
const DEFAULT_POLICY = {
  writeRequiresApproval: false,
  dangerousRequiresApproval: true,
  allowDangerous: false,
  executableSourceGate: true,
};

const FP = computeApprovalPolicyFingerprint(DEFAULT_POLICY);
/** 收紧后的策略（写类也要审批）——只改一个开关，指纹必然不同。 */
const FP_TIGHTENED = computeApprovalPolicyFingerprint({
  ...DEFAULT_POLICY,
  writeRequiresApproval: true,
});

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

/** 一张「已批准、尚未执行」的一次性单（与 request() 落库形态一致）。 */
function grantedRow(over: Partial<AgentApproval> = {}): Partial<AgentApproval> {
  return {
    id: "row-1",
    approvalKey: "apr-s-1-aaaaaaaaaaaaaaaa",
    sessionId: SESSION_ID,
    toolName: "stop_deployment",
    reason: "r",
    argsDigest: "a".repeat(64),
    preview: null,
    status: "granted",
    scope: "once",
    policyFingerprint: FP,
    decidedBy: "alice",
    decidedAt: new Date("2026-10-31T00:00:00Z"),
    expiresAt: null,
    ...over,
  };
}

describe("N3 · 策略指纹的确切定义（确定性 / 覆盖面 / 敏感性）", () => {
  it("同一份策略 ⇒ 同一个 64 位 hex；与对象构造顺序无关", () => {
    const a = computeApprovalPolicyFingerprint({ ...DEFAULT_POLICY });
    const b = computeApprovalPolicyFingerprint({
      // 同样的取值、不同的书写顺序
      executableSourceGate: DEFAULT_POLICY.executableSourceGate,
      allowDangerous: DEFAULT_POLICY.allowDangerous,
      dangerousRequiresApproval: DEFAULT_POLICY.dangerousRequiresApproval,
      writeRequiresApproval: DEFAULT_POLICY.writeRequiresApproval,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("**每一个**覆盖项单独变更都会改变指纹（漏一项就等于留一个永不作废的后门）", () => {
    const base = computeApprovalPolicyFingerprint(DEFAULT_POLICY);
    const knobs: Array<keyof typeof DEFAULT_POLICY> = [
      "writeRequiresApproval",
      "dangerousRequiresApproval",
      "allowDangerous",
      "executableSourceGate",
    ];
    for (const knob of knobs) {
      const flipped = computeApprovalPolicyFingerprint({
        ...DEFAULT_POLICY,
        [knob]: !DEFAULT_POLICY[knob],
      });
      expect(flipped).not.toBe(base);
    }
    // 覆盖项与常量表逐项对齐：常量表是给人复核的"指纹吃了哪些配置键"，
    // 它必须与 compute 函数真正读的字段一一对应（新增策略项时两处都要改，
    // 只改一处这里就红——防"常量表看起来覆盖了、代码其实没读"）。
    for (const knob of knobs) {
      expect(APPROVAL_POLICY_FINGERPRINT_KEYS).toContain(
        `agent.policy.${knob}`,
      );
    }
    expect(APPROVAL_POLICY_FINGERPRINT_KEYS).toHaveLength(knobs.length);
  });

  it("确定性：不掺进程号/时间/随机数——重复调用逐字节相等", () => {
    const seen = new Set(
      Array.from({ length: 5 }, () =>
        computeApprovalPolicyFingerprint(DEFAULT_POLICY),
      ),
    );
    expect(seen.size).toBe(1);
  });
});

describe("S1-C2 · 准入门槛：白名单与排除清单", () => {
  it("白名单恰好是 3 个收敛操作", () => {
    expect([...SESSION_SCOPE_ELIGIBLE_TOOLS].sort()).toEqual([
      "rollback_task_version",
      "stop_deployment",
      "upgrade_deployment",
    ]);
  });

  it("sop_publish / update_task **永久一次性**：既不在白名单、也在排除清单里", () => {
    for (const tool of ["sop_publish", "update_task"]) {
      expect(isSessionScopeEligible(tool)).toBe(false);
      expect(SESSION_SCOPE_EXCLUDED_TOOLS.has(tool)).toBe(true);
      expect(SESSION_SCOPE_ELIGIBLE_TOOLS.has(tool)).toBe(false);
    }
  });

  it("白名单内三个工具可进；白名单外一律不可进（准入而非黑名单）", () => {
    for (const tool of [
      "stop_deployment",
      "rollback_task_version",
      "upgrade_deployment",
    ]) {
      expect(isSessionScopeEligible(tool)).toBe(true);
    }
    for (const tool of [
      "create_task_from_template",
      "trigger_task",
      "deploy_application",
      "get_task",
    ]) {
      expect(isSessionScopeEligible(tool)).toBe(false);
    }
  });

  it("派生行的键与一次性单的键空间不相交（既有 approvalKey 公式未变）", () => {
    // buildKey 仍是既有实现（纯函数，不依赖仓储）：本用例顺带把它的**输出形态**
    // 钉死——这是「不改 approvalKey 公式」那条硬约束的可机械断言版本。
    const svc = new AgentApprovalsService({} as never);
    const onceKey = svc.buildKey(SESSION_ID, "stop_deployment", {
      deploymentId: "d-1",
    });
    // 既有公式的形态：apr-<sessionId>-<16 hex>
    expect(onceKey).toMatch(/^apr-[0-9a-f-]{36}-[0-9a-f]{16}$/);
    // 派生键前缀不同 ⇒ 永不相等（改公式会让在途 pending 单失联）
    const grantKey = `aprs-${SESSION_ID}-0123456789abcdef`;
    expect(grantKey).not.toBe(onceKey);
  });
});

describe("N3 · consume 的 fail-closed（谓词级，不是先读后判）", () => {
  it("策略不变 ⇒ 旧授权仍可 consume（一张单只放行一次）", async () => {
    const repo = makeRepo([grantedRow()]);
    const svc = new AgentApprovalsService(repo as never);
    await expect(svc.consume("apr-s-1-aaaaaaaaaaaaaaaa", FP)).resolves.toBe(
      true,
    );
    expect(repo.__table[0].status).toBe("consumed");
    // 再领一次：一张批准单只放行一次
    await expect(svc.consume("apr-s-1-aaaaaaaaaaaaaaaa", FP)).resolves.toBe(
      false,
    );
  });

  it("**策略收紧 ⇒ consume 被拒**（行仍是 granted，没被执行掉）", async () => {
    const repo = makeRepo([grantedRow()]);
    const svc = new AgentApprovalsService(repo as never);
    await expect(
      svc.consume("apr-s-1-aaaaaaaaaaaaaaaa", FP_TIGHTENED),
    ).resolves.toBe(false);
    // 关键：拒绝必须是"没领"，而不是"领了又失败"——状态与 consumedAt 都不能动
    expect(repo.__table[0].status).toBe("granted");
    expect(repo.__table[0].consumedAt ?? null).toBeNull();
    await expect(
      svc.explainConsumeFailure("apr-s-1-aaaaaaaaaaaaaaaa", FP_TIGHTENED),
    ).resolves.toBe("policy_changed");
  });

  it("当前策略指纹**读不到**（null）⇒ 直接拒绝且不发 UPDATE", async () => {
    const repo = makeRepo([grantedRow()]);
    const svc = new AgentApprovalsService(repo as never);
    await expect(svc.consume("apr-s-1-aaaaaaaaaaaaaaaa", null)).resolves.toBe(
      false,
    );
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.__table[0].status).toBe("granted");
  });

  it("行上没有记录指纹（本列上线前创建）⇒ 拒绝（fail-closed，无法证明依据未变）", async () => {
    const repo = makeRepo([grantedRow({ policyFingerprint: null })]);
    const svc = new AgentApprovalsService(repo as never);
    await expect(svc.consume("apr-s-1-aaaaaaaaaaaaaaaa", FP)).resolves.toBe(
      false,
    );
    expect(repo.__table[0].status).toBe("granted");
  });

  /**
   * **旧行（NULL 指纹）的语义钉死**：NULL ⇒ **拒绝放行**（fail-closed）。
   *
   * 为什么是这个语义（而不是"NULL 视为无指纹 ⇒ 放行"）：指纹机制的全部价值
   * 就是"能证明授权所依据的策略没变"。对一行**没有记录**该事实的单放行，等于
   * 给机制开一个永久后门——只要有一行能绕过，将来任何"策略收紧后旧授权仍放行"
   * 的回归都能用"那行是旧单"来解释。宁可让旧单失效一次（重新点个头）。
   *
   * **存量影响已实测为零**：本仓部署库 `agent_approvals` 实测 **0 行**
   * （2026-11-01，pending/granted/consumed/denied/expired 各态均为 0），
   * 所以"旧行失效"这件事在本仓**不会发生**——没有旧行可失效。该量化同时
   * 固化在迁移 1790000000087 的头注里（上线路径依据，不是事后追述）。
   *
   * 判据的机械形态：NULL 在 SQL 里**永不等于**任何指纹值 ⇒ 谓词
   * `policyFingerprint = 当前` 天然不命中 ⇒ 0 行 ⇒ 领取失败。实现里
   * `consume` 的早退分支也显式拦了 `currentPolicyFingerprint === null`。
   */
  it("旧行语义钉死：NULL 指纹 ⇒ 拒绝；且**不发 UPDATE**（不是「领了再失败」）", async () => {
    const repo = makeRepo([grantedRow({ policyFingerprint: null })]);
    const svc = new AgentApprovalsService(repo as never);
    await expect(svc.consume("apr-s-1-aaaaaaaaaaaaaaaa", FP)).resolves.toBe(
      false,
    );
    // 关键：状态与 consumedAt 都不能动（否则是"领了又失败"，单子会被吃掉）
    expect(repo.__table[0].status).toBe("granted");
    expect(repo.__table[0].consumedAt ?? null).toBeNull();
    // 且失败理由必须可归因到"指纹"，而不是含糊的"已被用掉"
    await expect(
      svc.explainConsumeFailure("apr-s-1-aaaaaaaaaaaaaaaa", FP),
    ).resolves.toBe("policy_changed");
  });

  it("会话级授权行**永不被领取**（scope 进谓词）", async () => {
    const repo = makeRepo([
      grantedRow({
        approvalKey: `aprs-${SESSION_ID}-0123456789abcdef`,
        status: "granted",
        scope: "session",
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        consumedAt: null,
      }),
    ]);
    const svc = new AgentApprovalsService(repo as never);
    await expect(
      svc.consume(`aprs-${SESSION_ID}-0123456789abcdef`, FP),
    ).resolves.toBe(false);
    expect(repo.__table[0].status).toBe("granted");
  });
});

/**
 * N3：**过期单复活时指纹必须按本次申请重记**。
 *
 * 复活（`request` 命中同一 `approvalKey` 的 expired 行）是一次**新的授权
 * 窗口**——人将看到一张新的待批单并重新点头。若复活时**不**刷新指纹，这张单
 * 会带着"过期前那套策略"的指纹：
 *   · 策略没变 ⇒ 指纹相同 ⇒ 恰好还能用（碰巧对）；
 *   · 策略变过 ⇒ 指纹不同 ⇒ 这张**刚重新申请**的单被 consume 判成"策略已变"
 *     而拒掉——症状是"人刚点了头却说策略变了"，极难排查。
 *
 * 故复活必须写入**本次申请时点**的指纹。逐条断言见
 * `__tests__/agent-approvals.spec.ts` 的复活用例（那里断言的是条件写的
 * patch 内容），本条钉的是"复活后的行确实带着新指纹、且旧指纹被替换"。
 */
describe("N3 · 过期单复活时刷新指纹（新一轮授权窗口）", () => {
  it("expired 单复活 ⇒ 指纹被替换为本次申请时的值（不沿用过期前那套策略）", async () => {
    const repo = makeRepo([
      grantedRow({
        id: "row-exp",
        approvalKey: "apr-s-1-9999999999999999",
        status: "expired",
        // 过期时那套策略的指纹（与本次申请时的 FP 不同）
        policyFingerprint: FP_TIGHTENED,
        decidedBy: "system:approval-ttl",
        decidedAt: new Date("2026-01-08T00:00:00Z"),
      }),
    ]);
    const svc = new AgentApprovalsService(repo as never);
    // 模拟 23505 冲突（同一 key 已存在）⇒ 走复活分支
    const conflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    // 替身类型是 `jest.fn(async (x) => ...)`，换成"总是抛"的实现要保持
    // 同一个签名形状（TS 的 Mock 泛型不兼容 ⇒ 显式转型）。
    repo.save = jest.fn(async () => {
      throw conflict;
    }) as unknown as typeof repo.save;

    const out = await svc.request({
      approvalKey: "apr-s-1-9999999999999999",
      sessionId: SESSION_ID,
      toolName: "stop_deployment",
      reason: "r",
      argsDigest: "a".repeat(64),
      preview: null,
      policyFingerprint: FP,
    });

    // 复活成 pending，且指纹换成本次的值
    expect(out.status).toBe("pending");
    expect(out.policyFingerprint).toBe(FP);
    expect(out.policyFingerprint).not.toBe(FP_TIGHTENED);
    // 处置痕迹清空（新一轮窗口）
    expect(out.decidedBy).toBeNull();
    // 且复活后的单**可以**被当前策略领取（指纹对得上）
    await expect(svc.consume("apr-s-1-9999999999999999", FP)).resolves.toBe(
      false,
    ); // 还没被批准（pending），领不到——但原因不是指纹
    await expect(
      svc.explainConsumeFailure("apr-s-1-9999999999999999", FP),
    ).resolves.toBe("not_granted");
  });
});

describe("S1-C2 · decide 派生会话级授权行", () => {
  it("批准 stop_deployment ⇒ 派生一条 scope=session 的行（有效期 + 署名 + 指纹）", async () => {
    const repo = makeRepo([
      grantedRow({
        id: "src-1",
        approvalKey: "apr-s-1-bbbbbbbbbbbbbbbb",
        status: "pending",
        decidedBy: null,
        decidedAt: null,
      }),
    ]);
    const svc = new AgentApprovalsService(repo as never);
    const out = await svc.decide(
      "apr-s-1-bbbbbbbbbbbbbbbb",
      "granted",
      "alice",
    );
    expect(out?.status).toBe("granted");

    const grants = repo.__table.filter((r) => r.scope === "session");
    expect(grants).toHaveLength(1);
    const g = grants[0];
    expect(g.toolName).toBe("stop_deployment");
    expect(g.sessionId).toBe(SESSION_ID);
    expect(g.status).toBe("granted");
    expect(g.decidedBy).toBe("alice"); // 谁批的
    expect(g.policyFingerprint).toBe(FP); // 策略指纹（同源单）
    expect(g.argsDigest).toBe("a".repeat(64)); // 目标一致（同参）
    expect(g.approvalKey).toMatch(
      new RegExp(`^aprs-${SESSION_ID}-[0-9a-f]{16}$`),
    );
    // 有效期 = 批准时刻 + AGENT_APPROVAL_TTL_MS（不是"永久"）
    const expiresAt = g.expiresAt as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime() - (g.decidedAt as Date).getTime()).toBe(
      AGENT_APPROVAL_TTL_MS,
    );
  });

  it.each(["sop_publish", "update_task"])(
    "批准 %s ⇒ **不派生**会话级授权（白名单外永久一次性）",
    async (toolName) => {
      const repo = makeRepo([
        grantedRow({
          id: "src-2",
          approvalKey: "apr-s-1-cccccccccccccccc",
          toolName,
          status: "pending",
          decidedBy: null,
          decidedAt: null,
        }),
      ]);
      const svc = new AgentApprovalsService(repo as never);
      await svc.decide("apr-s-1-cccccccccccccccc", "granted", "alice");
      expect(repo.__table.filter((r) => r.scope === "session")).toHaveLength(0);
    },
  );

  it("拒绝（denied）不派生会话级授权", async () => {
    const repo = makeRepo([
      grantedRow({
        id: "src-3",
        approvalKey: "apr-s-1-dddddddddddddddd",
        status: "pending",
        decidedBy: null,
        decidedAt: null,
      }),
    ]);
    const svc = new AgentApprovalsService(repo as never);
    await svc.decide("apr-s-1-dddddddddddddddd", "denied", "alice");
    expect(repo.__table.filter((r) => r.scope === "session")).toHaveLength(0);
  });

  it("源单没有策略指纹（上线前创建）⇒ 不派生（派生行永远过不了比对，等于白建）", async () => {
    const repo = makeRepo([
      grantedRow({
        id: "src-4",
        approvalKey: "apr-s-1-eeeeeeeeeeeeeeee",
        status: "pending",
        decidedBy: null,
        decidedAt: null,
        policyFingerprint: null,
      }),
    ]);
    const svc = new AgentApprovalsService(repo as never);
    await svc.decide("apr-s-1-eeeeeeeeeeeeeeee", "granted", "alice");
    expect(repo.__table.filter((r) => r.scope === "session")).toHaveLength(0);
  });

  it("源单没有 argsDigest（无法表达「同参」）⇒ 不派生", async () => {
    const repo = makeRepo([
      grantedRow({
        id: "src-5",
        approvalKey: "apr-s-1-ffffffffffffffff",
        status: "pending",
        decidedBy: null,
        decidedAt: null,
        argsDigest: null,
      }),
    ]);
    const svc = new AgentApprovalsService(repo as never);
    await svc.decide("apr-s-1-ffffffffffffffff", "granted", "alice");
    expect(repo.__table.filter((r) => r.scope === "session")).toHaveLength(0);
  });
});

describe("S1-C2 · findActiveSessionGrant 的三项校验", () => {
  const grantRow = (
    over: Partial<AgentApproval> = {},
  ): Partial<AgentApproval> =>
    grantedRow({
      approvalKey: `aprs-${SESSION_ID}-0123456789abcdef`,
      scope: "session",
      status: "granted",
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      ...over,
    });
  const query = (over: Record<string, unknown> = {}) => ({
    sessionId: SESSION_ID,
    toolName: "stop_deployment",
    argsDigest: "a".repeat(64),
    policyFingerprint: FP,
    ...over,
  });

  it("目标一致 + 指纹一致 + 未过期 ⇒ 命中", async () => {
    const svc = new AgentApprovalsService(makeRepo([grantRow()]) as never);
    await expect(svc.findActiveSessionGrant(query())).resolves.not.toBeNull();
  });

  it("跨会话不生效（作用域=本会话）", async () => {
    const svc = new AgentApprovalsService(makeRepo([grantRow()]) as never);
    await expect(
      svc.findActiveSessionGrant(
        query({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      ),
    ).resolves.toBeNull();
  });

  it("**策略指纹变化 ⇒ 会话级授权立即失效**（N3 与 S1-C2 的耦合点）", async () => {
    const svc = new AgentApprovalsService(makeRepo([grantRow()]) as never);
    await expect(
      svc.findActiveSessionGrant(query({ policyFingerprint: FP_TIGHTENED })),
    ).resolves.toBeNull();
    // 读不到当前策略 ⇒ 同样不命中（fail-closed）
    await expect(
      svc.findActiveSessionGrant(query({ policyFingerprint: null })),
    ).resolves.toBeNull();
  });

  it("过期不命中（不需要清理任务：过期行只是永远不再被命中）", async () => {
    const svc = new AgentApprovalsService(
      makeRepo([
        grantRow({ expiresAt: new Date(Date.now() - 1_000) }),
      ]) as never,
    );
    await expect(svc.findActiveSessionGrant(query())).resolves.toBeNull();
  });

  it("同工具但**不同参数**不命中（「同参」不是「同工具」）", async () => {
    const svc = new AgentApprovalsService(makeRepo([grantRow()]) as never);
    await expect(
      svc.findActiveSessionGrant(query({ argsDigest: "b".repeat(64) })),
    ).resolves.toBeNull();
  });

  it("白名单外即便库里有一行会话级授权也**不命中**（sop_publish/update_task 专测）", async () => {
    for (const toolName of ["sop_publish", "update_task"]) {
      const svc = new AgentApprovalsService(
        makeRepo([grantRow({ toolName })]) as never,
      );
      await expect(
        svc.findActiveSessionGrant(query({ toolName })),
      ).resolves.toBeNull();
    }
  });
});

/**
 * 主会话复核补记（2026-11-01）：**派生行不出现在人的视野**。
 *
 * 实施方自陈的「最可能误伤」第 ③ 条：会话级授权行（`scope='session'`）是派生出来的
 * **内部实现细节**——它不是「谁点了批准」。`listForSession` 若把它也列出来，运营在
 * 审批列表里会看到一条**并没有人批过**的「已批准」记录（前端按统一形状渲染，
 * 分不清「人工批的」与「系统派生的」）。
 *
 * 判据：列表只返回 `scope='once'` 的行；派生行仍然存在（判定要用）但**不可见**。
 */
describe("主会话复核 · 派生行不进人工审批列表", () => {
  it("listForSession 只返回 scope='once'，派生的 scope='session' 行不出现", async () => {
    const repo = makeRepo([
      {
        approvalKey: "apr-1",
        sessionId: "s1",
        scope: "once",
        status: "granted",
      },
      {
        approvalKey: "aprs-s1-abc",
        sessionId: "s1",
        scope: "session",
        status: "granted",
      },
    ]);
    const svc = new AgentApprovalsService(repo as never);
    const rows = await svc.listForSession("s1");
    expect(rows.map((r) => r.approvalKey)).toEqual(["apr-1"]);
    // 派生行**仍然存在**（判定要用它）——只是不列给人看
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sessionId: "s1", scope: "once" }),
      }),
    );
  });
});
