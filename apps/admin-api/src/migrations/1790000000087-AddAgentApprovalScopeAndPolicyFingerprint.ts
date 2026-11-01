import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * OSS 对照调研 **N3 + S1-C2**（R8/R9 缩窄版）：`agent_approvals` 补
 * 「授权范围」与「批这份授权时的策略指纹」。
 *
 * ## 三列各解决一个**已核实**的缺陷
 *
 * ### ① `policyFingerprint`（N3）
 *
 * 审批单此前只记「谁批的」（`decidedBy/decidedAt`），**不记「批的时候依据的是哪
 * 一套策略」**。而闸门的策略项（`agent.policy.writeRequiresApproval` /
 * `dangerousRequiresApproval` / `allowDangerous` / `executableSourceGate`）全部
 * 从 `ConfigService` 实时读取（`agent-boundary.service.ts` 的 `resolveApprovalPolicy`
 * / `resolveExecutableSourceGate`），**可以在运行中改**。于是：昨天在宽松策略下
 * 批准的一张单，今天策略收紧后 `consume()` 仍会照旧放行——授权的**依据**已经
 * 不成立了，单据却是"有效"的。
 *
 * 本列在**申请时**写入当时的策略指纹（`sha256`，64 位 hex，定义见
 * `agent-approvals.service.ts` 的 `computeApprovalPolicyFingerprint`），
 * `consume()` 时比对；不一致 ⇒ fail-closed。
 *
 * **为什么是「指纹」而不是「epoch / leader 代」**（R8 明确否决后者）：绑 epoch
 * 等于**每次部署都作废全部待批单**，推翻 `agent-approvals.service.ts:23-29`
 * 写死的 7 天窗口承诺（"7 天足够覆盖周五提交、下周一处理"）。指纹是
 * **策略内容**的确定性摘要——**部署本身不改变它，只有策略真的变了才改变**。
 * 这正是 R8 要的语义：作废的依据是"授权所依据的政策变了"，不是"进程换代了"。
 *
 * ### ② `scope`（S1-C2）
 *
 * 审批只有 **once** 语义：`granted → consumed` 的条件写保证"一张单只放行一次"。
 * 对运维的**收敛性操作**（停部署 / 回滚任务版本 / 升级部署）来说，同一会话里
 * 对同一目标反复点头是纯负担——审批疲劳本身就是安全降级（人开始无脑点批准）。
 *
 * `scope = 'session'` 表示这是一条**派生的会话级授权行**：作用域=本会话、
 * 有 `expiresAt`、有 `decidedBy`（谁批的）、有与源单同值的 `policyFingerprint`。
 * 它**不是**把一次性单改成多次用（那会污染 `consumedAt` 的语义、也会让
 * "批准了但从未执行" 这条运营查询失真），而是**另一行**：源单照旧被 consume
 * 一次，会话级授权行**从不被 consume**，只按「指纹一致 + 未过期 + 目标一致」
 * 三项校验被**命中**。
 *
 * **为什么用派生行而不是改 `approvalKey` 公式**：`approvalKey` 是
 * `agent_tool_calls.approvalId` 的**逻辑外键**（`agent-approval.entity.ts:57,69`
 * 的唯一约束），拼进指纹或 scope 会让在途 pending 单按新公式算不出旧键 ⇒
 * 失联到 TTL 过期（R9 明令禁止）。派生行用独立前缀（`aprs-`），与
 * `buildKey()` 的 `apr-<sessionId>-<16hex>` 键空间不相交，**既有键的形态与含义
 * 一个字节都没动**。
 *
 * ### ③ `expiresAt`（S1-C2）
 *
 * 会话级授权的有效期（复用 `AGENT_APPROVAL_TTL_MS`=7 天；会话进终态后本就没有
 * 新消费者）。一次性单此列为 NULL（其生命周期由 `status` + 待批单的 TTL 扫描
 * 管，语义不重叠）。
 *
 * ## 为什么不回填
 *
 * 存量审批单**当时没有采集**这两个事实（策略指纹 / 授权范围）。任何回填都是
 * **伪造审批证据**——`policyFingerprint` 尤其不能猜：猜一个"大概当时是这样"
 * 的指纹，等于替当时的人作证。故：
 *   · `policyFingerprint` NULL = 「不知道」⇒ 消费时按**指纹不可证**处理，
 *     fail-closed 拒绝（`consume` 的谓词要求与当前指纹**相等**，NULL 天然不命中）；
 *   · `scope` 走 `NOT NULL DEFAULT 'once'`——这不是回填：存量行**本来就是**
 *     one-shot 语义（该维度此前不存在第二种值），DEFAULT 只表达这个既成事实，
 *     且 PG 11+ 的 `ADD COLUMN ... DEFAULT <常量>` 是**元数据级**操作，不重写表。
 *
 * ## 存量影响（实测，2026-11-01）
 *
 * 上线前实测本仓部署库（`acf-postgres-1` / `autoflow`）：
 * `SELECT count(*) FROM agent_approvals` → **0 行**（pending / granted /
 * consumed / denied / expired 各态均为 0）。因此：
 *   · **不存在**「已批准但未执行的存量单」——NULL 指纹 fail-closed 的**存量
 *     影响面为零**，不会作废任何在途授权；
 *   · `scope` 的 DEFAULT 对存量行**无实际效果**（没有存量行可影响）。
 *
 * 这条量化是**本特性的上线路径依据**，不是事后追述：若某个部署的
 * `agent_approvals` 里真有存量 granted 单，那么 NULL ⇒ 拒绝的语义会让它们
 * 一次性失效，需要人工重新批准（代价：一次点头）。那种部署应在上线前
 * 先跑一次 `SELECT count(*) FROM agent_approvals WHERE status='granted'`，
 * 非零则知会运维。本仓部署库实测为 0，故无须知会。
 *
 * ## metadata-only
 *
 * 三列都不需要 CONCURRENTLY / 分批 / 回填脚本（`ADD COLUMN` 只改系统目录）；
 * 不建索引：授权行按 `(sessionId, toolName, argsDigest)` 查，而
 * `idx_agent_approvals_sessionId` 已把扫描面收敛到单会话（审批单是**低频**
 * 人工单据，一个会话通常个位数行），加部分索引的收益不抵"多一个要对齐
 * `check-index-drift` 的 DDL 对象"的成本。
 *
 * down：逆序 DROP COLUMN（新增列，回收无数据损失）。
 */
export class AddAgentApprovalScopeAndPolicyFingerprint1790000000087
  implements MigrationInterface
{
  name = "AddAgentApprovalScopeAndPolicyFingerprint1790000000087";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 一列一条 ALTER TABLE：对称性守卫的 RE_ADD_COLUMN / RE_DROP_COLUMN 只建模
    // 「ALTER TABLE t ADD|DROP COLUMN c」单列形态（逗号串里的第二列扫不到，
    // 会以「up 加了列、down 没删」的假红出现 —— 与 1790000000085 同款教训）。
    await queryRunner.query(
      `ALTER TABLE "agent_approvals" ADD COLUMN IF NOT EXISTS "scope" varchar(16) NOT NULL DEFAULT 'once'`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_approvals" ADD COLUMN IF NOT EXISTS "policyFingerprint" varchar(64) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_approvals" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMPTZ NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_approvals" DROP COLUMN IF EXISTS "expiresAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_approvals" DROP COLUMN IF EXISTS "policyFingerprint"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_approvals" DROP COLUMN IF EXISTS "scope"`,
    );
  }
}
