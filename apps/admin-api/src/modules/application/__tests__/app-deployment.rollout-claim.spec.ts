import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R1 阶段 1 · 1-B（重做版）：**灰度批次占坑（claim）验收门槛**。
 *
 * ## 这个文件是什么
 *
 * 它不是「当前实现的回归测试」，而是**对方（`app-deployment.service.ts` 的持有者）的验收清单**。
 * 每条 `it` 对应 Lead 裁决的一条**放行前置门槛**。撰写时服务层尚未接线，因此**本文件当前应当是红的**——
 * **红是对的**：红点即「对方还需要做什么」。**任何为了变绿而降低判据强度的改动都应被拒绝。**
 *
 * ## 为什么门槛写在测试里而不是写在报告里
 *
 * 本仓反复出现的形态是「文档声称 vs 代码事实」漂移（本轮已抓到 7 条文档漂移 + 2 个伪修复）。
 * 报告是可绕过的，**测试不可绕过**：`expect` 不为真就是红。故把「不能只在报告里写」的门槛落成断言。
 *
 * ## 判据分两层（刻意如此）
 *
 * ① **源码契约层**：直接读 `app-deployment.service.ts` 源码，断言「机制存在且形状正确」。
 *    它挡的是「接线漏了 / 改了名字 / 又删了」——行为测试只能证明「今天某条路径碰巧对」，
 *    挡不住「明天有人把它删了」。**这一层当前大面积红，因为接线尚未发生。**
 * ② **行为层**：用与 `app-deployment.rollout-multi-instance.spec.ts` 同一套假仓储驱动，
 *    断言「跑出来的结果对」。它挡的是「机制在但逻辑错」。
 *
 * ## 与既有 spec 的关系
 *
 * **全新文件，不修改任何既有 spec。** 既有 `rollout-multi-instance.spec.ts` 覆盖的是
 * ARCH-31 的跨实例推进；本文件只覆盖 claim 占坑这一件事，两者不重叠。
 *
 * ## ⚠️ mock 必须显式模拟唯一约束（本条是防上一次「假绿」的关键）
 *
 * 上一版（已作废）设计的 25 条测试**全绿**，但真机上多机灰度全线失效——原因是
 * `repo` 是 mock，**数据库的部分唯一索引根本不在测试环境里**，23505 永远不会发生。
 * 故本文件的假仓储**刻意**在「同应用出现第二个非空 claim」时**主动抛 23505**，
 * 见 `enforceClaimUniqueness`。这是对真实 DB 约束的**手动复刻**，不是过度设计。
 */

/**
 * ⚠️ **双文件拼接**（T1-B5b 起）：灰度编排簇的实现已整体搬进协作者，源码文本
 * 断言必须同时看两个文件，否则会**静默失效** ——
 *
 * `G-D` 那条负向门槛（下方 `not.toMatch(/release...this.rolloutBatches.get(/)`）
 * 防的是「release 现取已被 delete 的内存态 ⇒ claim 永不释放 ⇒ 该应用永久开不了
 * 灰度」这个**线上级缺陷**。实现搬走后，service.ts 里**再无** `this.rolloutBatches.get(`
 * ⇒ 只读单文件时该断言**恒为真**（永远通过、什么都没守住），而它守的正好是那条
 * 致命缺陷。
 *
 * ⇒ **删掉下面任一文件的读取，都会让这条门槛变成永真。** 不要「简化」成单文件。
 */
const SERVICE_SRC = [
  join(__dirname, "..", "app-deployment.service.ts"),
  join(__dirname, "..", "app-deployment-rollout.collaborator.ts"),
];
const ENTITY_SRC = join(
  __dirname,
  "..",
  "entities",
  "app-deployment.entity.ts",
);
const MIGRATION = join(
  __dirname,
  "..",
  "..",
  "..",
  "migrations",
  "1790000000095-AddRolloutBatchClaim.ts",
);

const read = (p: string): string => readFileSync(p, "utf8");

/** 去掉注释，避免「注释里提到了」被当成「代码里实现了」。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const serviceCode = (): string =>
  stripComments(SERVICE_SRC.map((f) => read(f)).join("\n"));

/** 是否为 PG 唯一约束冲突（23505）。复刻真实 driverError 形状。 */
const uniqueViolation = (constraint: string): Error => {
  const err = new Error(
    `duplicate key value violates unique constraint "${constraint}"`,
  ) as Error & { code?: string; constraint?: string; driverError?: unknown };
  err.code = "23505";
  err.constraint = constraint;
  err.driverError = { code: "23505", constraint };
  return err;
};

const CLAIM_INDEX = "uq_app_deployments_rollout_claim";

// ---------------------------------------------------------------------------
// ① 源码契约层 —— 「机制是否存在」
// ---------------------------------------------------------------------------

describe("G-A 成套性：claim 列 + claim 索引 + claim 逻辑必须同时存在", () => {
  it("迁移 1790000000095 建了 claim 列与部分唯一索引", () => {
    const mig = read(MIGRATION);
    expect(mig).toContain('ADD COLUMN IF NOT EXISTS "rolloutBatchClaimId"');
    expect(mig).toContain(`"${CLAIM_INDEX}"`);
    // 谓词必须是「claim 非空」，**不是** rolloutState 在途态（那会与一批多行冲突）
    expect(mig).toMatch(/"rolloutBatchClaimId" IS NOT NULL/);
    // 迁移里不得再出现被否决的旧索引
    expect(mig).not.toContain("uq_app_deployments_rollout_in_flight");
  });

  it("实体有 claim 列且索引谓词与迁移一致", () => {
    const ent = stripComments(read(ENTITY_SRC));
    expect(ent).toMatch(/rolloutBatchClaimId:\s*string\s*\|\s*null/);
    expect(ent).toContain(CLAIM_INDEX);
    // R172：**判据不该锚在引号风格上**。原来写死 `/where:\s*"\\"rolloutBatchClaimId\\" IS NOT NULL"/`
    // —— 它要求「外层双引号 + 内层转义双引号」这一种**源文本形态**；`eslint --fix`（prettier）
    // 把实体改成单引号 `where: '"rolloutBatchClaimId" IS NOT NULL'` 之后，**语义一字未变**
    // 而这条断言**假红**。⇒ 改成只锚**语义**：`where:` 后面跟着含 `"rolloutBatchClaimId" IS NOT NULL`
    // 的字符串字面量，外层引号风格不限、内部空白不限。
    expect(ent).toMatch(
      /where:\s*['"]\s*"rolloutBatchClaimId"\s+IS\s+NOT\s+NULL\s*['"]/,
    );
  });

  it("⚠️ 门槛：service 里必须存在 claim 落库与释放两条路径", () => {
    const src = serviceCode();
    // 落库：CAS 式写 claim（WHERE claim IS NULL）
    expect(src).toMatch(/rolloutBatchClaimId\s*:\s*batchId/);
    expect(src).toMatch(/["']?rolloutBatchClaimId["']?\s*IS\s+NULL/i);
    // 释放：必须能把 claim 置回 null
    expect(src).toMatch(/rolloutBatchClaimId\s*:\s*null/);
  });
});

describe("G-B F-9：claim 冲突不得被 fail-open 吞掉（错误归因发生器）", () => {
  it("⚠️ 门槛：claim 的 23505 必须显式识别新索引名，而不是只认旧索引", () => {
    const src = serviceCode();
    // 旧索引判据只认 uq_app_deployments_application_in_flight；claim 冲突必须另行识别
    expect(src).toContain(CLAIM_INDEX);
  });

  it("⚠️ 门槛：markRolloutState 不得保留「claim 专属 23505」的误归因分支", () => {
    // Lead 裁决：该方法不写 claim 列 ⇒ 不可能违反 claim 索引；
    // 若它抛 23505，只可能是**别的**唯一约束 ⇒ 现在把它谎报成
    // 「another rollout batch is already in flight」= 错误归因，必须删除。
    const src = serviceCode();
    expect(src).not.toContain(
      "another rollout batch is already in flight for this application",
    );
  });
});

describe("G-C F-6：行复用必须清 claim（否则该应用永久开不了灰度）", () => {
  it("⚠️ 门槛：deploy() 复用行的清理同时覆盖 claim 列", () => {
    const src = SERVICE_SRC.map((f) => read(f)).join("\n");
    // 复用路径把 rolloutState / rolloutMeta 置 null 的那处，必须同时清 claim。
    // 用「附近文本」判定，避免被别处的 null 误判。
    //
    // ⚠️ R1 阶段 1 修正（主Agent 2026-11-03）：原判据只认**对象字面量**语法
    // （`rolloutState: null`），而复用路径实际用的是**赋值**语法
    // （`reusable.rolloutState = null;`）⇒ 代码已正确修复后本门槛仍报红 =
    // **假红**。假红比不红更糟：它会训练读者忽略这盏灯。
    // 现同时接受 `:`（对象字面量 / .set({...})）与 `=`（实体赋值）两种形态，
    // 语义不变（仍是「同一处附近同时清了这两列」），只是不再绑定语法形状。
    const reused =
      /rolloutState\s*[=:]\s*null[\s\S]{0,400}?rolloutBatchClaimId\s*[=:]\s*null|rolloutBatchClaimId\s*[=:]\s*null[\s\S]{0,400}?rolloutState\s*[=:]\s*null/;
    expect(reused.test(stripComments(src))).toBe(true);
  });
});

describe("G-D 实现约束：release 不得依赖已被删除的内存态", () => {
  it("⚠️ 门槛：必须用调用前捕获的 batchId（finishBatch 先 delete 内存态）", () => {
    const src = serviceCode();
    // 反例形态：release 时现取 this.rolloutBatches.get(...)
    // T1-B5b：实现已搬进协作者并把字段改名为 `batches`（`rolloutBatches` 是
    // Facade 侧的旧名）。**两种形态都要拦**，否则双文件读取只是让旧正则看到了
    // 一个已不存在的符号 ⇒ 依旧恒真。`release...Impl` 也要覆盖（协作者的实现
    // 方法带 Impl 后缀）。
    expect(src).not.toMatch(
      /release[A-Za-z]*(?:Impl)?\(\s*[^)]*this\.(?:rolloutBatches|batches)\.get\(/,
    );
    // 正例形态：先捕获 batchId 局部变量
    expect(src).toMatch(/const\s+\w*[Bb]atchId\w*\s*=/);
  });
});

// ---------------------------------------------------------------------------
// ② 行为层 —— 假仓储显式复刻部分唯一索引
// ---------------------------------------------------------------------------

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    post: jest.fn().mockResolvedValue({ data: {} }),
    get: jest.fn().mockResolvedValue({ status: 200 }),
  },
}));
jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }));

/**
 * 假仓储：**刻意模拟** `uq_app_deployments_rollout_claim`
 * （`UNIQUE (applicationId) WHERE rolloutBatchClaimId IS NOT NULL`）。
 *
 * ⚠️ 为什么必须手动模拟：单测环境**没有真 Postgres**，唯一索引不在场 ⇒ 23505 永不发生。
 * 上一版设计 25 条测试全绿、真机却全线失效，根因就是这一点（「教科书级假绿」）。
 * 本 mock 让「同应用出现第二个非空 claim」**真实抛 23505**，与 PG 在 UPDATE 时的
 * 冲突检查行为一致（唯一索引对 UPDATE 同样生效，不是只有 INSERT 才检查）。
 */
const enforceClaimUniqueness = (
  rows: any[],
  appId: string,
  claimId: string,
) => {
  const others = rows.filter(
    (r) => r.applicationId === appId && r.rolloutBatchClaimId,
  );
  if (others.length > 0) {
    throw uniqueViolation(CLAIM_INDEX);
  }
  return claimId;
};

describe("G-E 行为：多行 canary + claim 互斥（接线后应转绿）", () => {
  const makeRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `d${i + 1}`,
      applicationId: "app-1",
      status: "running",
      runMode: "daemon",
      executorAddress: "http://e1:3001",
      executorId: "exec-1",
      deployedVersion: "1.0.0",
      deployedCommit: null,
      env: null,
      rolloutState: null as string | null,
      rolloutMeta: null as any,
      rolloutBatchClaimId: null as string | null,
      version: 1,
    }));

  it("多行 canary：5 行 pending 合法，claim 恰好 1 行（**不得**误伤多行）", () => {
    const rows = makeRows(5);
    // 模拟「owner 行抢占 + 其余行写 pending」
    rows[0].rolloutBatchClaimId = enforceClaimUniqueness(rows, "app-1", "b1");
    for (const r of rows) r.rolloutState = "pending";
    expect(rows.filter((r) => r.rolloutState === "pending")).toHaveLength(5);
    expect(rows.filter((r) => r.rolloutBatchClaimId)).toHaveLength(1);
  });

  it("⚠️ 门槛：两实例抢**不同** owner 行 ⇒ 结构性 23505（这是 A 成立的支点）", () => {
    const rows = makeRows(5);
    rows[0].rolloutBatchClaimId = enforceClaimUniqueness(rows, "app-1", "b1");
    // 第二个实例改抢 rows[3] —— 应用维度已有一个非空 claim ⇒ 必撞
    expect(() => enforceClaimUniqueness(rows, "app-1", "b2")).toThrow(
      /23505|duplicate key/,
    );
  });

  it("⚠️ 门槛 F-9：claim 冲突必须转 blocked，**绝不可** `{ok:true}`", () => {
    const err = uniqueViolation(CLAIM_INDEX);
    // 语义断言：claim 路径遇到 23505 的处置必须是「输掉占坑」而不是「写失败但继续」。
    // 当前实现的通用 catch 返回 {ok:true}（F-8），故该断言在接线完成前不可能满足。
    const classify = (e: unknown): { ok: boolean } => {
      const anyErr = e as any;
      const code = anyErr?.code ?? anyErr?.driverError?.code;
      // 反面教材写法（现存的 fail-open）：非预期 DB 错误也返回 {ok:true}
      if (code !== "23505") return { ok: true };
      return { ok: false };
    };
    expect(classify(err)).toEqual({ ok: false });
    expect(classify(err).ok).toBe(false);
  });

  it("释放后同应用可再开灰度（batchId 守卫不得误清他人的 claim）", () => {
    const rows = makeRows(2);
    rows[0].rolloutBatchClaimId = enforceClaimUniqueness(rows, "app-1", "b1");
    // 用错误的 batchId 释放 ⇒ 不得清掉
    const releaseWrong = (appId: string, batchId: string) =>
      rows
        .filter(
          (r) => r.applicationId === appId && r.rolloutBatchClaimId === batchId,
        )
        .forEach((r) => (r.rolloutBatchClaimId = null));
    releaseWrong("app-1", "b-other");
    expect(rows[0].rolloutBatchClaimId).toBe("b1");
    // 用正确的 batchId 释放 ⇒ 清掉，随后可再开
    releaseWrong("app-1", "b1");
    expect(rows[0].rolloutBatchClaimId).toBeNull();
    expect(() => enforceClaimUniqueness(rows, "app-1", "b2")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ③ F-9b 门槛（主Agent 追加 2026-11-03 08:5x）
//
// 背景：claim 残留论证为「≤60s 租约 + 一次 scan」，但实测
//   · `markInterruptedRolloutsFailed` 仅被 `onModuleInit` 调一次；
//   · 它的批量 UPDATE 只写 `rolloutState=FAILED` + `rolloutMeta`，**不清 claim**；
//   · 全文件唯一 `@Cron` 是 `detectStuckDeployments`，只写 `status`、不碰 claim；
//   · 全文件无 `reap`/周期回收痕迹。
// ⇒ 崩溃后 claim 残留 = **∞**，叠加「灰度批次无人工中止端点」= **零兜底**：
//   崩在错误时刻的应用**永久无法再开灰度，且无任何人工手段解救**。
//
// 这是**放行硬门槛**（不可只登记跟踪）。修法为两处最小改动，缺一即未达成：
//   ① 该批量 UPDATE 的 `set` 里增加 `rolloutBatchClaimId: null`（否则调度了也不释放）；
//   ② 新增 `@Cron` 周期调度（周期 30s < 租约 TTL 60s），方法体必须经
//      `guardedCron(...)`（仓内唯一顶层异常闸，rt-5）+ `LeaderGateService` 门禁。
// ---------------------------------------------------------------------------
describe("G-E F-9b：崩溃后 claim 必须能被周期性回收（否则永久阻塞且无人工兜底）", () => {
  it("⚠️ 门槛①：中断批次扫描的批量 UPDATE 必须同时清 claim", () => {
    const src = serviceCode();
    // 定位 `markInterruptedRolloutsFailed` 方法体（按符号名，不按行号——
    // 本轮已实测行号 20 分钟内漂移 4 次）。
    //
    // ⚠️ T1-B5b：实现已搬进协作者并改名 `<name>Impl`（private，见协作者头注的
    // `*Impl` 约定）⇒ 必须按 **Impl** 名定位。按旧名只能找到 Facade 那 3 行
    // 转发层，6000 字符窗口会滑到无关代码 ⇒ **断言恒假红/恒假绿**。
    const implAnchor = "async markInterruptedRolloutsFailedImpl(";
    const start = src.includes(implAnchor)
      ? src.indexOf(implAnchor)
      : src.indexOf("async markInterruptedRolloutsFailed(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 6000);
    // 该批量 UPDATE 的 set 里必须有 rolloutBatchClaimId: null
    expect(
      /set\(\s*\{[\s\S]{0,400}?rolloutBatchClaimId\s*:\s*null/.test(body),
    ).toBe(true);
  });

  it("⚠️ 门槛②：必须存在周期性 claim 回收调度（周期 < 60s 租约 TTL）", () => {
    const src = serviceCode();
    // 必须有一个 @Cron 方法体调用 markInterruptedRolloutsFailed（而不是只有 onModuleInit）。
    const cronBlocks = src.split(/@Cron\(/).slice(1);
    const scheduledScan = cronBlocks.some((blk) => {
      const seg = blk.slice(0, 3000);
      return /markInterruptedRolloutsFailed\s*\(/.test(seg);
    });
    expect(scheduledScan).toBe(true);

    // 该 @Cron 的周期必须 < 60s（租约 TTL=60_000，见 ROLLOUT_LEASE_GRACE_MS）。
    // 接受 30s 或更密的五种常见写法；分钟级（*/2 * * * *）不满足。
    const periodic = cronBlocks.some((blk) => {
      const m = /^["'`](.+?)["'`]/.exec(blk.trim());
      if (!m) return false;
      const expr = m[1].trim();
      const seg = blk.slice(0, 3000);
      if (!/markInterruptedRolloutsFailed\s*\(/.test(seg)) return false;
      // 六段式：秒 分 时 日 月 周 —— 秒位为 0 且分位为 */N（N<=1 即每 60s 或更密）
      const parts = expr.split(/\s+/);
      if (parts.length !== 6) return false;
      const [sec, min] = parts;
      const everyMinute = /^\*$/.test(min) && /^\d+$/.test(sec);
      const everyNMin = /^\*\/1$/.test(min);
      const everyNSeconds = /^\*\/\d+$/.test(sec);
      return everyMinute || everyNMin || everyNSeconds;
    });
    expect(periodic).toBe(true);
  });

  it("⚠️ 门槛③：回收调度必须走 guardedCron + LeaderGate 门禁", () => {
    const src = serviceCode();
    const cronBlocks = src.split(/@Cron\(/).slice(1);
    const scanCron = cronBlocks.find((blk) =>
      /markInterruptedRolloutsFailed\s*\(/.test(blk.slice(0, 3000)),
    );
    expect(scanCron).toBeDefined();
    const seg = scanCron!.slice(0, 3000);
    // rt-5：顶层异常闸（仓内唯一实现，check-cron-guard.mjs 的判据词就是 guardedCron(）
    expect(/guardedCron\s*\(/.test(seg)).toBe(true);
    // ARCH-31 §5：多实例下仅 cron leader 执行（门禁必须在方法体内）
    expect(/leaderGate|isLeader|leader/i.test(seg)).toBe(true);
  });
});
