/**
 * 回调日志的**截断标记**（T2-B4 收尾收敛：唯一事实源）。
 *
 * ## 形态
 *
 * 执行器侧日志超过 payload 上限时的占位文本：
 *   · Node:   `"... [logs truncated, original length N chars] ..."`
 *   · Python: `"...[truncated, total N chars]..."`
 *
 * ## 为什么收成一份
 *
 * 收尾前本仓有**两份**逐字相同的实现（`execution-log.collaborator.ts` 与
 * `execution-callback.collaborator.ts`）。副本的风险不是「重复」而是**各自漂移**：
 * 哪天有人只改其中一份，「截断日志不覆盖实时流行」这条判据在两条路径上就不一致
 * 了——而且**测试不一定红**（两边各自都"对"）。
 *
 * ## 语义（用在哪儿）
 *
 * 命中截断标记 ⇒ 回调里的 logs 是**残缺**的（执行器内存只留了头尾）⇒
 * ① 拉取全量失败时**不能**用它整体覆盖已落库的实时流行（否则用户看到的终态
 * 日志比执行过程中更少）；② 该走「拉全量 / 保留流式行」的分支。
 */
export const LOG_TRUNCATION_MARKER = /\[\s*(?:logs\s+)?truncated\b/i;
