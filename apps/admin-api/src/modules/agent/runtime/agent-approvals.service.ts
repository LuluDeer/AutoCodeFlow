import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash } from "node:crypto";
import { LessThan, MoreThan, Repository } from "typeorm";
import { AppError } from "../../../common/errors/app-error";
import {
  AgentApproval,
  type AgentApprovalStatus,
} from "../entities/agent-approval.entity";

/**
 * A1 审批闭环（实施轮 #12 → 执行侧闭环 #14）：审批单的落库、状态翻转与领取。
 *
 * 状态迁移：pending → granted / pending → denied（人工处置，条件写）；
 * granted → consumed（执行体在副作用之前**原子领取**，一张单只能用一次）。
 * 写路径统一走**条件 UPDATE**（ADR-026 规则 4）：两个管理员同时点批准、或批准
 * 与拒绝撞在同一张单上时，命中 0 行的一方拿到 APPROVAL_ALREADY_DECIDED——
 * 审批单的结论只能有一个，先到者赢。
 */
/**
 * 待审批单的有效期（7 天）。
 *
 * 超过即由维护扫描标 `expired` 并收敛对应会话——否则没人点的审批会让会话
 * 永久 waiting_input（既不执行也不失败），运营看板上永远挂着一条待办。
 * 7 天足够覆盖「周五提交、下周一处理」的真实节奏。
 */
export const AGENT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * **N3（R8 缩窄版）：进入「策略指纹」的策略项**。
 *
 * 只收「决定这次调用要不要人点头、以及点头是否仍然成立」的四项：
 *   · `writeRequiresApproval` / `dangerousRequiresApproval` —— 哪类 needs 人批
 *   · `allowDangerous` —— 危险类是否**允许**（更严：它连审批机会都不给，
 *     闸门 ⑥ 里已批准的单也不能覆盖它）
 *   · `executableSourceGate` —— C1 那道闸的开关（同样不受审批单覆盖，闸门 ⑦）
 *
 * **刻意不收**（每条都是判断，不是遗漏）：
 *   · `maxCallsPerTool` / `maxConsecutiveFailures`（速率与熔断）：限制的是
 *     "还能调几次"，不是"这份授权是否仍被允许"。算进来会让「调高单工具配额」
 *     这类纯容量调整作废全部在途授权——那是误伤，不是收紧。
 *   · `blockSelfApproval`（四眼原则）：约束的是**处置人身份**（谁能点批准），
 *     在 `decide` 那一刻求值；放进指纹会让「打开四眼原则」把昨天的单全判死，
 *     而昨天的单**当时确实合规**。
 *   · 工具注册表版本 / 进程代 / leader 代：R8 逐字否决——绑 epoch 等于每次
 *     部署作废待批单，推翻 7 天窗口承诺。工具集变更对「这份授权是否仍成立」
 *     的影响走**代码即策略**：闸门七道每次执行都重跑（含 ⑦）。
 */
export const APPROVAL_POLICY_FINGERPRINT_KEYS = [
  "agent.policy.writeRequiresApproval",
  "agent.policy.dangerousRequiresApproval",
  "agent.policy.allowDangerous",
  "agent.policy.executableSourceGate",
] as const;

/** 参与指纹求值的策略项取值（供 spec 断言"覆盖项集合"与实现不漂移）。 */
export interface ApprovalPolicySnapshot {
  writeRequiresApproval: boolean;
  dangerousRequiresApproval: boolean;
  allowDangerous: boolean;
  executableSourceGate: boolean;
}

/**
 * 策略指纹的确切定义（N3）。
 *
 * ```
 * fingerprint = sha256( canonicalJson({ <4 个策略项，键名由 canonicalJson 排序> }) ).hex
 * ```
 *
 * 三条性质（缺一不可）：
 *   ① **确定性**：`canonicalJson` 递归按键名排序、数组保序、undefined 掉键，
 *      同样的策略取值必然得到同一个 64 位 hex（跨进程、跨副本、跨重启一致）。
 *   ② **与策略相关、与部署无关**：只吃上面四项的**取值**。部署新版本不改变它
 *      （R8：不绑 epoch）；改了策略配置才改变它（这正是要的语义）。
 *   ③ **不含内容**：不哈希参数、不哈希工具名——指纹回答"授权所依据的政策是否
 *      还是同一套"，不是"批的是不是同一次调用"（那是 `approvalKey` /
 *      `argsDigest` 的职责）。
 *
 * 调用方从**权威来源**取值：`AgentBoundaryService.resolveApprovalPolicy()` 与
 * `resolveExecutableSourceGate()`——与闸门真正用的求值逻辑同一份。另写一套读
 * 配置的口径会让指纹与闸门漂移（指纹说"没变"、闸门行为变了），那比没有指纹更坏。
 */
export function computeApprovalPolicyFingerprint(
  policy: ApprovalPolicySnapshot,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        "agent.policy.allowDangerous": policy.allowDangerous,
        "agent.policy.dangerousRequiresApproval":
          policy.dangerousRequiresApproval,
        "agent.policy.executableSourceGate": policy.executableSourceGate,
        "agent.policy.writeRequiresApproval": policy.writeRequiresApproval,
      }),
    )
    .digest("hex");
}

/**
 * **会话级同参免审的准入门槛**（S1-C2 / R9）：只有这 3 个「收敛操作」可进。
 *
 * 共同点：**效果收敛、可再操作收口**——
 *   · `stop_deployment`：停掉在跑部署（可重新部署回去）；
 *   · `rollback_task_version`：回滚到**已存在的版本快照**（目标是既有事实，
 *     不是新载荷）；
 *   · `upgrade_deployment`：升到**已发布的**应用版本。
 * 三者都不产生"以后会被无门执行的新产物"，也不接受自由文本载荷。
 *
 * **明确排除（不是遗漏，是判断）**：
 *   · `sop_publish` —— 发布权 = **间接指令注入权**（`tool-registry.ts` 该段原话：
 *     SOP 会成为执行器 Agent 的执行依据）。会话级放行等于"本会话内可反复改写
 *     执行器的行为依据"，与提示注入叠加后是同构物。
 *   · `update_task` —— 改任务定义（含脚本/代码源 patch），产物会被后续
 *     trigger/cron **无门执行**。
 *   · 其余 write 工具（如 `create_task_from_template`）同理不进白名单——
 *     白名单是**准入**（默认拒绝），不是"黑名单之外都放行"。
 *
 * 这份表是**代码即策略**，不随配置变化，故不进策略指纹（指纹记录的是"批这份
 * 授权时闸门依据的那套**可配**策略"）。改它 = 改代码 = 走代码评审。
 */
export const SESSION_SCOPE_ELIGIBLE_TOOLS: ReadonlySet<string> = new Set([
  "rollback_task_version",
  "stop_deployment",
  "upgrade_deployment",
]);

/**
 * 显式排除清单（与白名单**互斥**）。
 *
 * 保留它是为了让"排除"可被机械断言，而不是只靠"没写进白名单"这一隐式事实
 * ——隐式排除在评审里看不见，而这两条恰恰是最需要写清理由的。
 */
export const SESSION_SCOPE_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  "sop_publish",
  "update_task",
]);

/**
 * 会话级免审**派生授权行**的键（与 `buildKey` 的键空间不相交）。
 *
 * `aprs-<sessionId>-<sha256("session"|toolName|argsDigest)[:16]>`
 *   · 前缀 `aprs-` ≠ `apr-` ⇒ 既有 `approvalKey` 公式**一个字节都没动**
 *     （R9 硬约束：它同时是 `agent_tool_calls.approvalId` 的逻辑外键 + 唯一
 *     约束，改公式会让在途 pending 单算不出旧键、失联到 TTL 过期）；
 *   · 同一 `(会话, 工具, 参数)` 确定性同键 ⇒ 重复授予命中同一行、不堆行。
 */
export function buildSessionGrantKey(
  sessionId: string,
  toolName: string,
  argsDigest: string,
): string {
  const digest = createHash("sha256")
    .update(`session|${toolName}|${argsDigest}`)
    .digest("hex")
    .slice(0, 16);
  return `aprs-${sessionId}-${digest}`;
}

/** 该工具是否可进会话级免审（白名单 ∧ 不在排除清单）。 */
export function isSessionScopeEligible(toolName: string): boolean {
  return (
    SESSION_SCOPE_ELIGIBLE_TOOLS.has(toolName) &&
    !SESSION_SCOPE_EXCLUDED_TOOLS.has(toolName)
  );
}

@Injectable()
export class AgentApprovalsService {
  private readonly logger = new Logger(AgentApprovalsService.name);

  constructor(
    @InjectRepository(AgentApproval)
    private readonly approvals: Repository<AgentApproval>,
  ) {}

  /**
   * 申请键的**确定性**构造（实施轮 #14）。
   *
   * 键 = `apr-<sessionId>-<sha256(toolName|规范化参数) 前 16 位>`。同一会话里
   * 「同一工具 + 同一参数」的重试必须命中同一行（幂等），否则：
   *   · 模型每重试一次就多一张 pending 单（运营看板只增不减）；
   *   · 管理员批准的那张与模型正在等的调用不是同一行，「批准后重放即执行」
   *     这条链根本接不上。
   *
   * 参数规范化：对象按键名排序递归序列化，数组保持顺序（顺序是语义），
   * undefined 掉键（JSON 语义一致）。同一逻辑参数的不同书写（键序不同）
   * 得到同一键。
   *
   * S1-C3 起，同一份规范化也产出审批单上的 `argsDigest`（见
   * `computeApprovalArgsDigest`）——**不要**在这里以外的任何地方再写一份。
   */
  buildKey(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown> | null,
  ): string {
    const digest = createHash("sha256")
      .update(`${toolName}|${canonicalJson(args)}`)
      .digest("hex")
      .slice(0, 16);
    return `apr-${sessionId}-${digest}`;
  }

  /** 申请落库。approvalKey 唯一约束保证重试不产生第二张单（幂等）。 */
  async request(input: {
    approvalKey: string;
    sessionId: string;
    toolName: string;
    reason: string;
    /**
     * 被批对象的参数摘要（S1-C3）。**必填**：新行的 NULL 只允许表示「本列上线前
     * 创建」这一件事，若这里可空，`argsDigest IS NULL` 就再也分不清「旧单」与
     * 「忘了采集」——而后者正是要防的静默降级。
     */
    argsDigest: string;
    /**
     * 脱敏 + 截断后的人类可读预览（S1-C3）。由调用方（tool-executor，持有既有
     * `sanitizeArgs`）构造后传入：**脱敏规则只允许有一份实现**，本服务不做第二遍。
     * null = 本次调用无参数。
     */
    preview: string | null;
    /**
     * 申请时的策略指纹（N3，迁移 1790000000087）。**必填**，理由同 `argsDigest`：
     * 新行的 NULL 只允许表示「本列上线前创建」这一件事；若这里可空，
     * `policyFingerprint IS NULL` 就再也分不清「旧单」与「忘了采集」。
     *
     * 由调用方（tool-executor，持有 `AgentBoundaryService`）从**闸门真正用的
     * 那份策略求值**里取值后算好传入——本服务不读 `ConfigService`，避免出现
     * 第二套读配置的口径（那会让指纹与闸门漂移）。
     */
    policyFingerprint: string;
  }): Promise<AgentApproval> {
    const row = this.approvals.create({
      approvalKey: input.approvalKey,
      sessionId: input.sessionId,
      toolName: input.toolName,
      reason: input.reason,
      argsDigest: input.argsDigest,
      preview: input.preview,
      policyFingerprint: input.policyFingerprint,
      // 新申请一律是 one-shot：会话级授权只能由**已批的那张单**派生
      // （见 deriveSessionGrant），不能由申请方自选。
      scope: "once",
      status: "pending",
    });
    try {
      return await this.approvals.save(row);
    } catch (err: unknown) {
      // 唯一约束冲突 = 同一 approvalKey 已申请过（重试/重放）：返回既有单，
      // 让幂等语义对调用方透明。
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "23505"
      ) {
        const existing = await this.approvals.findOne({
          where: { approvalKey: input.approvalKey },
        });
        if (!existing) throw err;
        // A2（P2）：TTL 过期单必须可以复活，否则 approvalKey 被**永久钉死**。
        //
        // 死锁链：审批超时 → 维护扫描标 expired + 会话 failed（提示「重新
        // 发起」）→ 管理员 resume → 模型重提同一工具同参（buildKey 确定性）
        // → 这里命中同一行 expired 单 → 会话又 waiting_input；而 decide 只
        // 允许从 pending 出发，grant/deny 永远 409。这张单再也处置不了，
        // 每次 resume 都是白烧一轮 LLM。
        //
        // 因此 expired 视为「没人处理、需要新窗口」：条件写复位为 pending，
        // createdAt 刷新（TTL 从新窗口算），清掉上一轮的处置痕迹。
        //
        // 只复活 expired——denied/consumed/granted 仍是终点：复活它们等于给
        // 已被拒绝、或已经用过的副作用发第二张通行证（consume 的原子性正是
        // 为了「一次批准只放行一次」）。pending 无需任何动作，原样返回。
        if (existing.status === "expired") {
          const revived = await this.approvals.update(
            { id: existing.id, status: "expired" },
            {
              status: "pending",
              createdAt: new Date(),
              decidedBy: null,
              decidedAt: null,
              // 复活时**一并刷新**摘要与预览：本列上线前过期的旧单（两列 NULL）
              // 复活后会重新进入审批人的视野，此时必须带上这次的参数事实，
              // 否则「旧单」的空预览会一直跟着这张单。刷新不改变任何审批语义
              // （key 相同 ⇒ 规范化参数相同），只是把本次调用的事实写全。
              argsDigest: input.argsDigest,
              preview: input.preview,
              // N3：复活是**新一轮**授权窗口 ⇒ 指纹也按本次申请时点的策略重记。
              // 不刷新的话，一张过期单复活后仍带着旧策略的指纹，会被 consume 的
              // 比对判成"策略已变"——而它其实是刚刚重新申请的。
              policyFingerprint: input.policyFingerprint,
            },
          );
          if (revived.affected) {
            this.logger.warn(
              `Agent approval revived after TTL expiry: key=${input.approvalKey} ` +
                `session=${input.sessionId} tool=${input.toolName} ` +
                `previous=${existing.decidedBy ?? "unknown"} — 新一轮审批窗口已开启`,
            );
          }
          // 无论条件写是否命中都**重新读取**返回最新行：命中 0 说明并发方
          // （另一次 request 的复位、或人工处置）刚改过它，此时返回最新状态
          // 才是事实；抛错会让模型这一轮无谓失败。
          const latest = await this.findByKey(input.approvalKey);
          return latest ?? existing;
        }
        return existing;
      }
      throw err;
    }
  }

  async findByKey(approvalKey: string): Promise<AgentApproval | null> {
    return this.approvals.findOne({ where: { approvalKey } });
  }

  async listForSession(sessionId: string): Promise<AgentApproval[]> {
    // **只列人工处置过的单**（scope='once'）。会话级授权行（scope='session'）是
    // 派生出来的**内部实现细节**——它不是「谁点了批准」，把它列出来会让运营
    // 在审批列表里看到一条并**没有人批过**的「已批准」记录（前端按统一形状渲染，
    // 分不清「人工批的」与「系统派生的」）。派生行的存在只对判定有意义
    // （findActiveSessionGrant），不需要出现在人的视野里。
    return this.approvals.find({
      where: { sessionId, scope: "once" },
      order: { createdAt: "ASC" },
    });
  }

  /**
   * 处置（批准/拒绝）。条件写钉住 status='pending'——终态竞争由数据库行锁
   * 仲裁，撞上的调用方收 APPROVAL_ALREADY_DECIDED（409）。
   * 返回 null = 单不存在；返回行 = 本次调用完成了处置。
   *
   * 谓词必须是 `status = 'pending'`（而不是「非 granted/denied」）：新增
   * `consumed` 后，否定式谓词会把**已执行过**的单重新翻回 granted，等于给
   * 一次副作用发第二张通行证。
   */
  async decide(
    approvalKey: string,
    decision: Extract<AgentApprovalStatus, "granted" | "denied">,
    decidedBy: string,
  ): Promise<AgentApproval | null> {
    const updated = await this.approvals.update(
      { approvalKey, status: "pending" },
      { status: decision, decidedBy, decidedAt: new Date() },
    );
    if (!updated.affected) {
      const row = await this.findByKey(approvalKey);
      if (!row) return null;
      throw new AppError("AGENT_APPROVAL_ALREADY_DECIDED", {
        approvalKey,
        status: row.status,
      });
    }
    const row = await this.findByKey(approvalKey);
    if (!row) return null;
    // S1-C2：批准一张收敛操作的单时，**派生**一条会话级授权行。
    //
    // 为什么要"派生"而不是"把这行改成 scope=session"：源单必须照旧被 consume
    // 一次（一次点头 = 一次执行），会话级授权是**另一个**授权事实（本会话内
    // 同参免审），它有自己的行、自己的有效期、自己的一生。
    if (decision === "granted") {
      await this.deriveSessionGrant(row);
    }
    return row;
  }

  /**
   * 由一张**已批准**的一次性单派生会话级授权行（S1-C2 / R9）。
   *
   * 前置（任一不满足即**不派生**，fail-closed：宁可不免审，不可错免审）：
   *   ① 工具在 `SESSION_SCOPE_ELIGIBLE_TOOLS` 且不在排除清单（`sop_publish` /
   *      `update_task` 永久一次性）；
   *   ② 源单是 `scope='once'`（会话级行不派生会话级行）；
   *   ③ 源单有 `argsDigest`（否则无法表达"同参"，免审就成了"同工具免审"）；
   *   ④ 源单有 `policyFingerprint`（否则派生行永远过不了指纹比对，等于白建）；
   *   ⑤ 源单 `decidedBy` 非空（免审必须**有署名**——"谁批的"是这条授权的
   *      全部合法性来源）。
   *
   * 派生行携带：作用域=本会话（`scope='session'` + `sessionId`）、有效期
   * （`expiresAt` = now + `AGENT_APPROVAL_TTL_MS`）、谁批的（`decidedBy` 同源单）、
   * 策略指纹（**同源单**——不是"现在"的策略：这份授权的依据就是源单被批准时
   * 的那套策略；若策略已变，指纹在命中时自然对不上，授权立即失效）。
   *
   * 幂等：键是确定性的（`buildSessionGrantKey`），重复授予命中同一行并刷新
   * 有效期/署名（源单过期复活后再批，会话级授权必须跟着续期）。
   */
  private async deriveSessionGrant(row: AgentApproval): Promise<void> {
    if (!isSessionScopeEligible(row.toolName)) return;
    if (row.scope !== "once") return;
    if (!row.argsDigest) return;
    if (!row.policyFingerprint) return;
    if (!row.decidedBy) return;

    const approvalKey = buildSessionGrantKey(
      row.sessionId,
      row.toolName,
      row.argsDigest,
    );
    const decidedAt = row.decidedAt ?? new Date();
    const expiresAt = new Date(decidedAt.getTime() + AGENT_APPROVAL_TTL_MS);
    const reason =
      `会话级授权（派生自审批单 ${row.approvalKey}）：本会话内 ` +
      `${row.toolName} 同参免审，至 ${expiresAt.toISOString()} 或策略变更时失效`;

    try {
      await this.approvals.insert({
        approvalKey,
        sessionId: row.sessionId,
        toolName: row.toolName,
        reason,
        argsDigest: row.argsDigest,
        preview: row.preview,
        status: "granted",
        scope: "session",
        decidedBy: row.decidedBy,
        decidedAt,
        policyFingerprint: row.policyFingerprint,
        expiresAt,
      });
      this.logger.log(
        `Agent session grant derived: session=${row.sessionId} tool=${row.toolName} ` +
          `from=${row.approvalKey} grant=${approvalKey}`,
      );
    } catch (err: unknown) {
      // 23505 = 这张会话级授权已存在（源单过期复活后又批了一次）：条件写续期，
      // 而不是当成失败——**已存在的授权行**是事实，过期了才需要续。
      const isUnique =
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "23505";
      if (!isUnique) {
        // 派生失败**不能**让人的批准失败：源单已经 granted（这是主事实），
        // 会话级授权只是"下一次同参免审"的优化。降级是安全的（下次仍要人批）。
        this.logger.warn(
          `Agent session grant derivation failed (approval kept): session=${row.sessionId} ` +
            `tool=${row.toolName} — ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      await this.approvals.update(
        { approvalKey, scope: "session" },
        {
          status: "granted",
          decidedBy: row.decidedBy,
          decidedAt,
          expiresAt,
          policyFingerprint: row.policyFingerprint,
        },
      );
    }
  }

  /**
   * 找一条**当前有效**的会话级授权（S1-C2 的三项校验）。
   *
   *   ① **目标一致**：`(sessionId, toolName, argsDigest)` 全等 —— 「同会话、同工具、
   *      同参数」。作用域=本会话由此天然成立（换会话查不到 ⇒ 跨会话不生效）。
   *   ② **策略指纹一致**：与**当前**策略指纹相等。策略一收紧，旧会话级授权
   *      立即失效（这是 N3 与 S1-C2 的耦合点）。
   *   ③ **未过期**：`expiresAt > now`。
   *
   * 三道都是**查询谓词**而不是"取回来再判断"：过期/失效的行根本不该离开数据库，
   * 否则调用方很容易漏判其中一条。`policyFingerprint` 为 null（读不到当前策略）
   * 时直接返回 null —— fail-closed：证不了策略没变，就不免审。
   *
   * 另外再按白名单过滤一次（`isSessionScopeEligible`）：即便库里有人手工塞了一行
   * `sop_publish` 的会话级授权（或历史数据/别处的 bug 造出来的），执行体也
   * **不会**因此免审——白名单是准入，不是"插入即生效"。
   */
  async findActiveSessionGrant(input: {
    sessionId: string;
    toolName: string;
    argsDigest: string;
    policyFingerprint: string | null;
    now?: Date;
  }): Promise<AgentApproval | null> {
    if (!isSessionScopeEligible(input.toolName)) return null;
    if (!input.policyFingerprint) return null;
    if (!input.argsDigest) return null;
    const now = input.now ?? new Date();
    const row = await this.approvals.findOne({
      where: {
        sessionId: input.sessionId,
        toolName: input.toolName,
        argsDigest: input.argsDigest,
        scope: "session",
        status: "granted",
        policyFingerprint: input.policyFingerprint,
        expiresAt: MoreThan(now),
      },
      order: { expiresAt: "DESC" },
    });
    return row ?? null;
  }

  /**
   * 把超过 TTL 的 pending 单标成 `expired`（维护扫描调用）。
   *
   * 条件写钉住 `status='pending'`：与人工批准/拒绝并发时先到者赢，没抢到的
   * 那张不会把 granted/denied 覆盖成 expired。返回受影响的会话 id 去重集合，
   * 供调用方收敛仍挂在 waiting_input 的会话。
   */
  async expireStalePending(
    cutoff: Date,
    now: Date = new Date(),
  ): Promise<{ expired: number; sessionIds: string[] }> {
    const stale = await this.approvals.find({
      where: { status: "pending", createdAt: LessThan(cutoff) },
      select: { id: true, sessionId: true },
    });
    const sessionIds = new Set<string>();
    let expired = 0;
    for (const row of stale) {
      const res = await this.approvals.update(
        { id: row.id, status: "pending" },
        {
          status: "expired",
          decidedBy: "system:approval-ttl",
          decidedAt: now,
        },
      );
      if (res.affected) {
        expired += 1;
        sessionIds.add(row.sessionId);
      }
    }
    return { expired, sessionIds: [...sessionIds] };
  }

  /** 会话还有没有未处置的审批单（resume 前置校验用）。 */
  async hasPendingForSession(sessionId: string): Promise<boolean> {
    const pending = await this.approvals.find({
      where: { sessionId, status: "pending" },
      take: 1,
    });
    return pending.length > 0;
  }

  /**
   * **领取**一张已批准的审批单（granted → consumed，条件写）。
   *
   * 为什么必须先领取再执行：批准是「放行一次」，不是「长期开闸」。若只看
   * `status === 'granted'` 就放行，同一会话后续任何同参调用（甚至模型刷循环）
   * 都会无限复用这一次点头——审批从门退化成通知。
   *
   * 为什么在**副作用之前**领取：领取成功才允许执行；反过来（先执行再领取）
   * 并发下会出现「两次执行、一次领取」，副作用双份。领取失败 = 已被别处用掉，
   * 调用方必须按拒绝处理（fail-closed）。
   *
   * ## N3（R8）：领取前比对**策略指纹**——并且比对发生在 SQL 谓词里
   *
   * 谓词 = `approvalKey ∧ status='granted' ∧ scope='once' ∧ policyFingerprint = 当前`：
   *   · 指纹不一致 ⇒ 命中 0 行 ⇒ 领取失败 ⇒ 调用方按拒绝处理（fail-closed）。
   *     这正是"策略收紧 ⇒ 旧授权不再放行"的**执行点**；策略不变 ⇒ 相等 ⇒ 照常。
   *   · 比对放在谓词里而不是"先 SELECT 再 UPDATE"：ADR-026 规则 4 要求状态写入
   *     在 DB 层原子求值，否则"读到的指纹"与"写下去的状态"之间有一个可被
   *     策略变更穿过的窗口。
   *   · `currentPolicyFingerprint` 为 null（当前策略读不到）⇒ **直接不发 UPDATE**、
   *     返回 false。`policyFingerprint = NULL` 在 SQL 里永不相等，就算发出去
   *     也必然 0 行；显式早退只是让日志能写清理由。
   *   · `scope='once'` 进谓词：会话级授权行（S1-C2）**永不**被领取——它是可反复
   *     命中的常驻授权，被 consume 掉就等于"用一次就没了"。
   *
   * @param currentPolicyFingerprint 当前生效策略的指纹（null = 读不到 ⇒ fail-closed）
   * @returns true = 本次调用持有这张单的执行权
   */
  async consume(
    approvalKey: string,
    currentPolicyFingerprint: string | null,
  ): Promise<boolean> {
    if (!currentPolicyFingerprint) {
      // 策略指纹读不到 ⇒ fail-closed（R8 / 纪律 4）：证不了授权依据没变，
      // 就不放行。宁可让管理员重新点一次，也不放行一份"不知道依据哪套策略"
      // 的授权。
      this.logger.warn(
        `Agent approval consume refused (policy fingerprint unreadable): ` +
          `approval=${approvalKey} — fail-closed`,
      );
      return false;
    }
    const updated = await this.approvals.update(
      {
        approvalKey,
        status: "granted",
        scope: "once",
        // 指纹进 WHERE：策略变了就在这里命中 0 行（原子，无 TOCTOU 窗口）。
        // 存量行该列为 NULL ⇒ 与任何指纹都不相等 ⇒ 同样 fail-closed。
        policyFingerprint: currentPolicyFingerprint,
      },
      // consumedAt 与状态同一条 UPDATE 落：分成两次写会出现「状态已 consumed、
      // 时刻为空」的窗口，而那正是审计要区分的「批准了但没执行」。
      { status: "consumed", consumedAt: new Date() },
    );
    if ((updated.affected ?? 0) > 0) return true;

    // 命中 0 行有三种可能，必须**分开**报告（否则运维只能看到一句"已被用掉"，
    // 而真实原因是策略变了，会去查并发、查错了方向）。
    const row = await this.findByKey(approvalKey);
    if (row && row.status === "granted") {
      this.logger.warn(
        `Agent approval consume refused (policy fingerprint changed): ` +
          `approval=${approvalKey} recorded=${row.policyFingerprint ?? "NULL"} ` +
          `current=${currentPolicyFingerprint} — fail-closed`,
      );
    }
    return false;
  }

  /**
   * 领取失败的**可断言理由**（N3）：给执行体写"为什么没放行"的文案用。
   *
   * 为什么单独一个只读方法，而不是让 `consume` 返回对象：`consume` 的布尔契约
   * 是既有调用方（含既有单测）的稳定面；而"失败原因"只在**失败之后**才需要，
   * 多一次只在异常路径上发生的只读查询，比改契约便宜。
   *
   * 返回值：
   *   · `policy_changed` —— 行存在且仍 granted，但记录的指纹与当前不一致/缺失
   *   · `not_granted`    —— 行不是 granted（已被别处领取 / 被拒 / 过期）
   *   · `missing`        —— 行不存在
   */
  async explainConsumeFailure(
    approvalKey: string,
    currentPolicyFingerprint: string | null,
  ): Promise<"policy_changed" | "not_granted" | "missing"> {
    const row = await this.findByKey(approvalKey);
    if (!row) return "missing";
    if (row.status !== "granted") return "not_granted";
    if (
      !currentPolicyFingerprint ||
      !row.policyFingerprint ||
      row.policyFingerprint !== currentPolicyFingerprint
    ) {
      return "policy_changed";
    }
    return "not_granted";
  }
}

/**
 * 规范化 JSON：对象键排序（递归）、数组保序、undefined 掉键。
 *
 * 只为「同参重试命中同一审批键」服务——不做通用序列化器，因此不处理
 * Date/Buffer 等特殊类型（工具参数来自 JSON.parse，本来就只有 JSON 类型）。
 *
 * 深度钳位（防线前移）：buildKey 在**边界闸门的深度闸之前**执行——工具参数
 * 来自 LLM，`[[[…]]]` 在字符预算内可嵌数万层，无界递归会在这里先爆栈
 * （RangeError 逃出 tool-executor → 运行时循环无兜底 → 会话永久卡 running）。
 * 超深部分截断为稳定占位串：两个不同深载荷可能得到同键，但它们必然被
 * boundary 的 MAX_SCAN_DEPTH 拒绝（buildKey 之后、任何副作用之前），
 * 键碰撞不可达。合法工具参数都是两三层 schema，钳位不影响任何真实调用。
 */
const CANONICAL_MAX_DEPTH = 64;

/**
 * 被批对象的参数摘要（S1-C3）= `sha256(canonicalJson(args))` 的 64 位 hex。
 *
 * 与 `buildKey` **共用同一份 `canonicalJson`**：键是
 * `apr-<sessionId>-<sha256(toolName|规范化参数) 前 16 位>`，本摘要只去掉
 * `sessionId`/`toolName` 两个维度并保留完整 64 位——因此「同一 approvalKey
 * ⇒ 同一 argsDigest」（反之不成立，键只有 16 位前缀且混入了工具名）。
 *
 * 和 buildKey 一样不处理 Date/Buffer（工具参数来自 `JSON.parse`），并复用同一
 * 深度钳位：本函数在 `tool-executor` 里位于边界闸门的深度闸之前，无界递归同样
 * 会先爆栈。**不要**另写一份规范化——两份口径一旦漂移，「批的就是这次调用」
 * 这个对账锚点就 silently 失效。
 */
export function computeApprovalArgsDigest(
  args: Record<string, unknown> | null,
): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}

export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > CANONICAL_MAX_DEPTH) return '"[DEEP_NESTED]"';
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v, depth + 1)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v, depth + 1)}`)
    .join(",")}}`;
}
