import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A2：给取证事件加**因果边** —— `agent_events."causedBySeq"`。
 *
 * ## 缺陷：事件流此前是「扁平日志」，不是「因果图」
 *
 * 迁移 0089 只落了 `(sessionId, seq, kind, payload, createdAt)`。要回答
 *
 * > 「这条 `tool_call_status_changed` 是被**哪条**事件引起的？」
 *
 * 今天只能打开 `payload` 去**猜**：`tool_callId` 相同就认为同一条调用、
 * `approvalKey` 相同就认为是那张审批单。那是**推断**，不是**事实**，而且它
 * 有三个具体的失效面（都不是假想）：
 *
 *   ① **一对多时无法定向**：一次调用会有多条 `tool_call_status_changed`
 *      （`in_flight` → `ok`/`error`，deny 路径还会被 settle 成 `denied`）。
 *      按 `toolCallId` 只能得出「它们属于同一条调用」，得不出「第 3 条是第 2 条
 *      引起的，还是被审批决定引起的」。Temporal 的做法是让**每个结果事件携带
 *      `ScheduledEventId`**（`mutable_state_impl.go:4777-4783`）——精确配对是**写在
 *      数据里的指针**，不是读侧的模式匹配。
 *   ② **payload 可以缺字段**：`tool_call_recorded` 在迁移 069 之前的存量行没有
 *      `toolCallId`；`approval_decided` 若某天少写 `approvalKey`，配对就整段失效。
 *      列存在时，指针是**结构**的一部分，不依赖正文写全。
 *   ③ **推断无法被证伪**：启发式配对永远能给出一个「看起来对」的答案，所以
 *      「配错了」在数据层不可见。有了 `causedBySeq`，读侧可以断言
 *      「因果必须先于结果、且必须落在本会话内」——**能被违反**的断言才是证据。
 *
 * 所以本项把因果**落列**：`causedBySeq integer NULL`，指向**同一会话内**那条
 * 引起本事件的事件（`(sessionId, causedBySeq)` 是「指向本会话另一行」的坐标）。
 * 从「每次靠 payload 猜」变成「一次写入、永久可查」。
 *
 * ## 为什么可空、且**不回填**
 *
 * 本列上线**之前**写入的事件没有因果信息——那时确实没记。按本仓反复的纪律
 * （0086 的 `contextFoldLedger`、0090 的 `retryKind`、0083 的 `stateChangedAt`
 * 同一个口径）：**不假装知道**。用启发式结果回填 `causedBySeq` 会把「推断」
 * 固化成「事实」，而一旦写进去就再也分不清哪条是真指针、哪条是猜出来的——
 * 这比留空坏得多。NULL 的语义因此只有一个：**当初没有记录**。
 *
 * 读侧据此分档（`agent-event-projection.ts`）：有值 ⇒ 按因果配对并标
 * `resolvedBy: "causation"`；NULL ⇒ 回落既有启发式并标 `resolvedBy: "heuristic"`。
 * 存量会话每一行都是 NULL ⇒ 走**完全同一条**回落路径 ⇒ 输出逐字节不变。
 *
 * ## 为什么**不加** FK（以及为什么不加唯一约束）—— 三个各自独立的否决理由
 *
 * ① **与批量插入的原子性冲突**：`appendEvents` 是**一条** SQL（`INSERT ... SELECT
 *    ... FROM base CROSS JOIN jsonb_array_elements($2) WITH ORDINALITY`）写整批。
 *    自引用 FK 会要求「被引用行在检查时刻已可见」，把「一批事件互相引用」的成立
 *    条件从「同一条语句」变成「语句结束前的可见性细节」。这条路径的原子性是
 *    `(sessionId, seq)` 唯一约束 + 连续性断言的**全部基础**，不能为了一条校验去
 *    赌 PG 的 RI 触发器时序。**约束会与批量插入的语义纠缠，就不加。**
 * ② **FK 会杀死保留期清理**：`cleanupExpiredEvents` 按 `createdAt < cutoff` 批量
 *    删除。因果边总是从「结果」指向「更早的起因」⇒ 起因先过期、结果可能还在
 *    （cutoff 两侧各一行）。`ON DELETE NO ACTION` 会让清理 cron 报错（超期事件
 *    永远删不掉，表无界增长）；`ON DELETE SET NULL` 会在保留期到期时**改写历史**
 *    （把「有因果」改成「不知道」）——两者都不可接受。
 * ③ **不是 1:1 关系**：一条起因可以有多条结果（一个 `step_appended` 引起 N 条
 *    `tool_call_recorded`），所以唯一约束在语义上就是错的。真正需要的不是
 *    「唯一」，而是「同会话 + seq 更小」——那是**逐行**判据，静态 DDL 表达不出来
 *    （PG 的 CHECK 不能跨行查询）。
 *
 * ⇒ 本迁移**只加列**。那条「同会话 + 更早」的判据改由**运行期断言**兜住：
 * `agent-event-projection.ts` 遇到 `causedBySeq >= seq` 或「指向本会话不存在的前驱」
 * 一律记成缺口（`causation_invalid` / `causation_missing`），**不静默接受**；
 * `scripts/check-agent-event-causation.mjs` 再从写入侧静态拦住「规则要求有因果却
 * 没传」的调用点。守卫代替约束，比一条会拖垮清理与批量插入的 FK 诚实。
 *
 * ## 为什么是 metadata-only（不 CONCURRENTLY、不分批、不回填）
 *
 * `ADD COLUMN`（可空、无默认值）在 PG 里只改系统目录，**不重写表**、不长时间持锁，
 * 存量行读出来就是 NULL（正是我们要的语义）。故无需分批、无需 `statement_timeout`
 * 豁免，也不需要回填脚本。幂等：`IF NOT EXISTS` / `IF EXISTS`，重复执行与 revert
 * 重放均无副作用。
 *
 * ## 回滚的代价（必须知道）
 *
 * down 只删这一列：**已经写进去的因果边全部丢失**，事件流退回「扁平日志」，
 * 「这条状态变化是被谁引起的」重新变成只能靠 payload 猜。事件本身、会话、steps、
 * tool_calls 全不受影响——取证仍能回答「发生了什么」，只是回答不了「为什么发生」。
 * 这是「加列」的回滚代价下限（不是数据损坏），也正是列可空的意义：删掉它不会让
 * 任何既有行变得不可读。
 */
export class AddAgentEventCausation1790000000093 implements MigrationInterface {
  name = "AddAgentEventCausation1790000000093";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 可空 + 无默认值 = metadata-only（不重写表）：存量行一律 NULL，
    // 语义是「本列上线前写入，当初没有记录因果」——不补、不猜、不伪造。
    // 无 FK、无唯一约束（三条否决理由见类头注）：那条「同会话 + 更早」的判据
    // 改由投影的运行期断言 + scripts/check-agent-event-causation.mjs 兜住。
    await queryRunner.query(`
      ALTER TABLE "agent_events"
      ADD COLUMN IF NOT EXISTS "causedBySeq" integer NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "agent_events" DROP COLUMN IF EXISTS "causedBySeq"
    `);
  }
}
