/**
 * R199：「卡住」（stalled）的阈值常量。
 *
 * ## 为什么单独成文件（不是放在 service 里）
 *
 * ① **导出数棘轮**：`agent-session.service.ts` 已在 `check:size-caps` 的**逐文件只减不增**
 *    基线上（`exports` 上限 21）⇒ 新增两个导出就会破顶 ⇒ 常量单独成文件，
 *    service 只 `import`（不 `export`）⇒ **零新增导出**。
 * ② **判据的「参数」与判据的「实现」分居两处**：阈值是**判据的一部分**
 *    （文档：`docs/observability/agent-stalled-criterion.md` §3），
 *    单独成文件 ⇒ 谁改阈值时**必然**看到它与判据文档的对应关系。
 *
 * ## 取值理由
 *
 * · **默认 15 分钟**：Agent 的一步是「一次模型调用 + 若干工具调用」，
 *   大多数步骤在**秒级到分钟级**完成 ⇒ 15 分钟既不会把「正常的长步骤」误判成卡住，
 *   也不会让真卡住的会话**长时间无人察觉**（运营巡检的心跳间隔是分钟级）。
 * · **下限 1 分钟**：`agent-session.service.ts` 的钳制保证 ≥ 1；
 *   理由见判据文档 §2.2（一个 `running` 却**从未产生任何 step** 的会话算卡住
 *   ——这是「启动即挂」的形态；但阈值必须 ≥ 1 分钟，否则**刚创建**的会话会被瞬间判卡住）。
 * · **上限 1440 分钟（1 天）**：超过一天的 `running` 会话**几乎必然**是卡住/崩溃残留；
 *   上限保证这个过滤器**永远能判定**（不会因为传了超大阈值就变成「永不判定」）。
 */
export const STALLED_DEFAULT_MINUTES = 15;
export const STALLED_MAX_MINUTES = 1440;

/**
 * R199：构造「卡住」判据的 SQL 片段与参数。
 *
 * ## 判据（推导见 `docs/observability/agent-stalled-criterion.md`）
 *
 * > stalled = `running` **且**「最近一步 `AgentStep` 的 `createdAt`」距今超过 N 分钟。
 *
 * ## 为什么用 **EXISTS 子查询**而不是 JOIN
 *
 * `JOIN agent_steps` 会把一行会话**放大成 N 行**（一个会话几十步）⇒
 * `getManyAndCount` 的 `COUNT` 会**重复计数**、`skip/take` 分页也会**错位**。
 * `EXISTS` 只做**存在性判断**、**不改变行数** ⇒ COUNT 与分页都正确。
 * 子查询走 `idx_agent_steps_sessionId_seq`（`(sessionId, seq)`）。
 *
 * ## 为什么看 `agent_steps` 而**不是** `agent_sessions.updatedAt`
 *
 * `updatedAt` 是 `@UpdateDateColumn`，但仓里**有多处裸 `update(AgentSession)`**
 * （`autoResumeCount` 递增、`contextFoldStreak` 清零…）**绕过**它 ⇒
 * `updatedAt` **不只**反映业务进展 ⇒ 用它判会**误报**。
 * `AgentStep` 是**纯追加**的 ⇒ 「最近一步的时间」与「业务进展」**严格同向**。
 */
export function buildStalledPredicate(
  stalledMinutes?: number,
): [string, { runningStatus: string; stalledSince: Date }] {
  const minutes = Math.min(
    STALLED_MAX_MINUTES,
    Math.max(
      1,
      Number.isFinite(stalledMinutes)
        ? Number(stalledMinutes)
        : STALLED_DEFAULT_MINUTES,
    ),
  );
  return [
    `s.status = :runningStatus
         AND NOT EXISTS (
           SELECT 1 FROM agent_steps st
           WHERE st."sessionId" = s.id
             AND st."createdAt" > :stalledSince
         )`,
    {
      runningStatus: "running",
      stalledSince: new Date(Date.now() - minutes * 60_000),
    },
  ];
}
