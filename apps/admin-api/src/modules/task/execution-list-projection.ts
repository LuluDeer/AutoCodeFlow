/**
 * PERF-03（本轮体验审查）：执行列表端点的**读投影**。
 *
 * 背景：`task_executions.logs` 是 text 列，回调 DTO 允许单条 512_000 字符
 * （execution-callback.dto.ts 的 `@MaxLength(512_000)`）。而两个列表端点
 * （`getExecutions` / `getAllExecutions`）此前用 `findAndCount` / `getManyAndCount`
 * **取整行**——一页 20 行满载时仅 logs 就接近 10 MB，全部经 SQL 读取、JSON
 * 序列化、网络传输，再被前端原样丢弃：
 *   · TaskDetailPage 执行历史表只渲染 status / executorAddress / startTime /
 *     duration / errorMessage，从不读 logs；
 *   · 执行详情页的日志走独立端点 `GET .../logs`（按行分页）与 SSE 流；
 *   · aiAnalysis（同为 text）只在详情页与报告端点展示。
 *
 * 危害不止"慢"：列表首屏与翻页要等这几 MB 传完，弱网下表现为页面长时间空表；
 * 同时 admin-api 的堆与出网带宽被无谓占用。
 *
 * **为什么用「排除表」而不是「包含表」**：包含表（白名单）在实体新增列时会把
 * 新列**静默丢掉**——读面少一个字段不会报错，只会显示空白，正是本轮反复在修的
 * 那类"静默损坏"。排除表的方向相反：新列默认被选中，只有明确列入本表的重型
 * 文本列才会被排除，且排除项有测试钉住。
 */

/**
 * 列表端点**排除**的重型文本列。
 *
 * - `logs`：单条上限 512_000 字符的任务输出，列表不消费。
 * - `aiAnalysis`：AI 故障分析全文（同为 text），仅详情页/报告端点消费。
 *
 * 新增排除项必须同时满足：① 是 text/长文本列；② 全部列表消费方都不读它。
 */
export const EXECUTION_LIST_EXCLUDED_COLUMNS: readonly string[] = [
  "logs",
  "aiAnalysis",
];

/**
 * 由实体的属性名全集算出列表投影列（= 全集 − 排除表）。
 *
 * 纯函数，便于单测直接喂属性名断言方向性（新列必须默认入选）。
 */
export function projectExecutionListColumns(
  allPropertyNames: readonly string[],
): string[] {
  const excluded = new Set(EXECUTION_LIST_EXCLUDED_COLUMNS);
  return allPropertyNames.filter((name) => !excluded.has(name));
}

/** TypeORM 仓储的最小形状（只取元数据，避免 import 具体类型造成循环依赖）。 */
interface MetadataCarrier {
  metadata: { columns: ReadonlyArray<{ propertyName: string }> };
}

/**
 * 运行时从 TypeORM 元数据算出投影列（**裸属性名**，供 `find`/`findAndCount`
 * 的 `select` 选项使用）。
 *
 * 用 `repo.metadata.columns` 而非手写清单：实体加列时投影**自动跟上**，
 * 不会出现「新增列在列表里恒为 undefined」的静默缺失。
 *
 * 关系型属性（`task`）不在 `metadata.columns` 里，故天然不会被选中——这也正是
 * 我们想要的：列表不需要 JOIN 出整个 Task 实体。
 */
export function executionListSelectColumns(repo: MetadataCarrier): string[] {
  return projectExecutionListColumns(
    repo.metadata.columns.map((c) => c.propertyName),
  );
}

/**
 * 同上，但加 `e.` 别名前缀——QueryBuilder（`getManyAndCount`）的 `select`
 * 需要 `"e.columnName"` 形态，而 `find` 的 `select` 只认裸属性名。两者不可混用，
 * 故显式分成两个函数，避免调用方拿错。
 */
export function executionListSelectColumnsAliased(
  repo: MetadataCarrier,
  alias = "e",
): string[] {
  return executionListSelectColumns(repo).map((name) => `${alias}.${name}`);
}
