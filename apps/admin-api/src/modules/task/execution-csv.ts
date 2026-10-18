import { toCsvRow } from "../../common/utils/csv-export.util";
import { TaskExecution } from "./entities/task-execution.entity";

/**
 * `GET /tasks/executions/export` 的 CSV **列定义**（表头 + 行渲染）。
 *
 * ## 为什么这里的列不能与前端导出口径"对齐"
 *
 * 前端 `ExecutionsPage.tsx` 的 `buildExecutionsCsv` 导出的是**人读**视图：
 * 状态渲染成中文标签、时间用 `formatDateTime`、耗时用 `formatDuration`
 * （"1分23秒"）。那套格式服务于「打印出来看一眼」，不服务于「归档、复盘、
 * 入库对账」——本端点存在的理由恰恰是后者（`docs/operations.md` 说明
 * `task_executions` 会在 90 天后硬删除且无归档表，需留存的历史必须自行导出）。
 *
 * 故本端点导出的是**机器可读**口径：
 *   · `status` 落原始枚举值（`success`/`failed`/…），不是本地化标签——中文
 *     标签一旦被用于 `GROUP BY` 或对账脚本，就绑死了 UI 文案；
 *   · 时间落 ISO 8601 UTC（`…T08:00:00.000Z`），不是本地格式化串——后者
 *     丢时区、不可排序、不同浏览器导出结果还不一致；
 *   · 耗时落**整数毫秒**，不是"1分23秒"。
 *
 * 前端那次纯客户端导出仍是有效的"看当前页"能力，两者不冲突、也不应当被
 * 统一——一个是视图，一个是账本。
 *
 * ## 列集合的取舍
 *
 * 收录：定位（id/taskId/taskName）、状态机（status/triggerType/retryCount）、
 * 时间（createdAt/startTime/endTime/duration）、归属（executorId/
 * executorAddress）、**失败溯源**（errorMessage/failureReason/exitCode）——
 * 最后这一组是导出最核心的价值：90 天后原始行被删，只剩这张 CSV 能回答
 * "那晚为什么失败"。
 *
 * 排除：`logs` / `aiAnalysis`（单条上限 512_000 字符的 text 列，塞进 CSV 会把
 * 行上限直接变成"几十条就截断"，且这两列本就有各自的专项导出/查看通道）、
 * `params` / `result` / `artifacts`（jsonb 自由列，序列化后含逗号/换行/引号
 * 极密，且无 schema——写进 CSV 只会得到一坨不可分析的东西；需要它们请走
 * `GET /tasks/:id/executions/:execId` 的 JSON 面）。
 */
export const EXECUTION_CSV_HEADER = [
  "id",
  "taskId",
  "taskName",
  "status",
  "triggerType",
  "executorId",
  "executorAddress",
  "createdAt",
  "startTime",
  "endTime",
  "durationMs",
  "retryCount",
  "exitCode",
  "failureReason",
  "errorMessage",
] as const;

/** 行形状：CSV 只需要这些列，故接受投影而非整实体（与 streaming 分页配合）。 */
export type ExecutionCsvRow = Pick<
  TaskExecution,
  | "id"
  | "taskId"
  | "taskName"
  | "status"
  | "triggerType"
  | "executorId"
  | "executorAddress"
  | "createdAt"
  | "startTime"
  | "endTime"
  | "duration"
  | "retryCount"
  | "exitCode"
  | "failureReason"
  | "errorMessage"
>;

/** 时间列渲染：ISO 8601 UTC；null/非法值 → 空串（不写 `Invalid Date`）。 */
function isoOrEmpty(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/**
 * 一行 → CSV 文本（不含换行符）。
 *
 * **每个单元格都经 `escapeCsvCell`**（公式注入防护 + RFC 4180 包裹）：这里
 * 是安全边界，任何"这个列肯定是安全的"式的短路（例如只对 errorMessage 转义）
 * 都会在下一个字段上破功——`taskName` / `executorAddress` 同样是用户可控的。
 */
export function executionToCsvRow(row: ExecutionCsvRow): string {
  return toCsvRow([
    row.id,
    row.taskId,
    row.taskName,
    row.status,
    row.triggerType,
    row.executorId,
    row.executorAddress,
    isoOrEmpty(row.createdAt),
    isoOrEmpty(row.startTime),
    isoOrEmpty(row.endTime),
    row.duration,
    row.retryCount,
    row.exitCode,
    row.failureReason,
    row.errorMessage,
  ]);
}

/** 表头行（同样走转义——表头目前全是 ASCII 标识符，但口径统一不特殊化）。 */
export function executionCsvHeaderRow(): string {
  return toCsvRow(EXECUTION_CSV_HEADER);
}
