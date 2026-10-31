import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * S1-C3（OSS 对照调研 · 审批信息完整性）：`agent_approvals` 补「被批对象」的
 * 摘要与人类可读预览。
 *
 * ## 为什么需要（这是四眼原则的信息面）
 *
 * 审批单此前只有 `toolName` + 固定 `reason`——审批人看得到「批的是哪个工具」，
 * 看不到「这次调用到底要动什么」。审批的全部价值是「人替系统看一眼这次要做什么」，
 * 而信息面上是空的：批 `update_task` 看不见 patch，批 `sop_publish` 看不见正文。
 * 盲批不是「人点了头」，只是「人点了一下」。
 *
 * 两列各管一件事，不能互相替代：
 *   · `argsDigest` = `sha256(canonicalJson(args))`（与审批键 `buildKey` **同源的
 *     规范化口径**）：机器可校验的「批的就是这次调用」对账锚点——批准后模型重放的
 *     调用必须命中同一 `approvalKey`，而 `approvalKey` 用的是同一份规范化参数；
 *     事后追责时可以拿它验证「当时批准的那组参数」有没有被替换。
 *   · `preview` = 过既有 `sanitizeArgs` 脱敏 + 截断 2KB（带截断标记）的人类可读
 *     预览：给审批人看的决策依据。**不落可执行脚本全文**——长字符串只留字段名 +
 *     长度 + 摘要，避免 `agent_approvals` 变成脚本文本仓库。
 *
 * ## 为什么可空且不回填
 *
 * 存量审批单没有这个事实（申请时就没有采集），任何回填都是**伪造审批证据**——
 * 审计列宁可 NULL 也不能编。NULL 的语义是「不知道（本列上线前创建）」，因此
 * 读面（admin-web 审批卡片）必须显示降级文案，不能显示成「没有参数」。
 * 钩子侧从本批起写值：`requestApproval` 传值 → `AgentApprovalsService.request`
 * 落库，新行 `argsDigest` 必非空（`canonicalJson(null)` 也是确定性值）。
 *
 * ## 为什么 metadata-only
 *
 * 加可空列在 PG 只改系统目录（不重写表、不长时间持 ACCESS EXCLUSIVE），因此
 * 不用 CONCURRENTLY、不用分批、也不需要回填脚本。down 对称删列。
 */
export class AddAgentApprovalArgsPreview1790000000085
  implements MigrationInterface
{
  name = "AddAgentApprovalArgsPreview1790000000085";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 一列一条 ALTER TABLE（而不是 `ADD COLUMN a, ADD COLUMN b` 逗号串）：
    // 对称性守卫 `scripts/check-migration-symmetry.mjs` 的 RE_ADD_COLUMN /
    // RE_DROP_COLUMN 只建模「ALTER TABLE t ADD|DROP COLUMN c」单列形态，逗号串里
    // 的第二列**扫不到** ⇒ 会以「up 加了列、down 没删」的假红出现（实测，
    // 且它比真红更坏：让人以为守卫在管这件事而其实漏看）。列数不多时逐条写，
    // 守卫与人在 diff 里都能一眼对上。PG 语义与合并写法等价（同一次事务）。
    await queryRunner.query(
      `ALTER TABLE "agent_approvals" ADD COLUMN IF NOT EXISTS "argsDigest" varchar(64) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_approvals" ADD COLUMN IF NOT EXISTS "preview" text NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_approvals" DROP COLUMN IF EXISTS "preview"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_approvals" DROP COLUMN IF EXISTS "argsDigest"`,
    );
  }
}
