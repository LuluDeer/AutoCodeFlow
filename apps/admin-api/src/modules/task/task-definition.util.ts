import { BadRequestException, ConflictException } from "@nestjs/common";
import { CreateTaskDto } from "./dto/create-task.dto";
import { Task } from "./entities/task.entity";

/**
 * E-1（任务定义导入/导出）：导出物装配与导入映射的**纯函数**层。
 *
 * 与 service 的分工：本文件不触任何仓储/DI——导出快照键的白名单装配、
 * 导入物 → CreateTaskDto 的映射、导入重名的后缀推导，全部可独立单测
 * （对齐 block-strategy-gate / maintenance-window.util 等既有纯函数先例）。
 *
 * ## 导出物形状（schemaVersion "1"）
 *
 *   { schemaVersion: "1", exportedAt: <ISO>, task: { ...快照键 } }
 *
 * `task` 键集合 = `TaskService.saveVersion` 配置快照键集合**去掉 id**（id 是
 * 身份不是定义——导入必须产生新任务），即 name/description/runtime/
 * runtimeVersion(glue/interpreter)/glueSource/params/timeout/retry/依赖/
 * 部署约束/维护窗口/触发配置/git 三键/currentVersion/applicationId/projectId
 * 等全部用户可编辑定义键。刻意**不**含：secrets（SEC-02 红线，见下）、
 * webhookSecret、status/lastTriggerTime/ownerUserId/时间戳等运行态与审计列。
 *
 * ## SEC-02 红线：secrets 绝不出现在导出物中
 *
 * 双层防线：
 *   ① 白名单装配（显式键集合，secrets/webhookSecret 根本不在集合内——
 *      整键剔除，值与键名 alike）；
 *   ② `assertNoSecretMaterial` 运行时不变量：装配完成后递归扫描所有键名，
 *      命中 /secret/i 即抛错（宁可炸导出请求，也不让密文/明文凭据出网）。
 * 服务侧取数再走 maskForResponse 脱敏读路径（findOne）——第三层兜底。
 */

/** 导出物 schema 版本。导入端点只接受本版本（@IsIn 校验）。 */
export const TASK_EXPORT_SCHEMA_VERSION = "1";

/**
 * 导入重名冲突的重试上限：base → `base (imported)` → `base (imported) 2`
 * → … → `base (imported) 20`，全部撞唯一索引才放弃（409）。防呆上限，
 * 正常场景 1-2 次内必收敛。
 */
export const TASK_IMPORT_MAX_NAME_CONFLICTS = 20;

/** 导入响应 warnings 的常驻提示（secrets 红线对称语义）。 */
export const TASK_IMPORT_SECRETS_WARNING =
  "Task secrets are never part of the export/import payload (SEC-02 red " +
  "line) — the imported task has NO secrets configured; reconfigure them " +
  "via PATCH /tasks/:id before running it.";

/** 导入物携带了 secrets 键时的追加提示（该键被整体忽略）。 */
export const TASK_IMPORT_SECRETS_IGNORED_WARNING =
  'The import payload carried a "secrets" field, which was ignored — ' +
  "secrets cannot be transferred by definition import (SEC-02 red line).";

/**
 * 导出键白名单 = saveVersion 配置快照键 − id。**唯一事实源注释**：与
 * task.service saveVersion 的 snapshot 字面量键集合保持同步（新增任务定义
 * 键时两处一起加；两边不一致会由 spec 的对账断言钉住）。
 */
export const TASK_DEFINITION_EXPORT_KEYS: readonly (keyof Task)[] = [
  "name",
  "description",
  "triggerType",
  "cronExpression",
  "timezone",
  "fixedRate",
  "runtime",
  "runtimeVersion",
  "requirements",
  "dependencies",
  "entrypoint",
  "gitRepo",
  "gitBranch",
  "gitCommit",
  "currentVersion",
  "timeout",
  "timeoutAction",
  "timeoutWarnRatio",
  "estimatedDurationSec",
  "maxRetry",
  "retryDelay",
  "retryableErrors",
  "priority",
  "executeMode",
  "blockStrategy",
  "misfireStrategy",
  "alarmEmail",
  "alarmChannels",
  "params",
  "deploymentPolicy",
  "executorId",
  "executorAppName",
  "executorGroup",
  "executorTags",
  "executorAffinityTags",
  "executorAntiAffinityTags",
  "glueSource",
  "glueLanguage",
  "applicationId",
  "codeSource",
  "maintenanceWindows",
  "runbook",
  "projectId",
];

/** GET /tasks/:id/export 的响应体形状（= POST /tasks/import 的请求体）。 */
export interface TaskExportPayload {
  schemaVersion: string;
  exportedAt: string;
  task: Record<string, unknown>;
}

/** exportDefinition 的返回：payload + 下载文件名。 */
export interface TaskExportResult {
  filename: string;
  payload: TaskExportPayload;
}

/** importDefinition 的返回（TaskImportResultDto 的运行时形状）。 */
export interface TaskImportResult {
  taskId: string;
  name: string;
  warnings: string[];
}

/**
 * 递归断言：对象树中任何层级的键名命中 /secret/i 即抛错。
 * 这是导出物的**运行时不变量**——白名单装配是第一道防线，本断言保证
 * 即使未来有人把 secret 类键加进白名单/实体新增 secret 形态列，导出也会
 * fail-closed，而不是静默把凭据带出系统。
 */
export function assertNoSecretMaterial(node: unknown, path = "payload"): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => assertNoSecretMaterial(item, `${path}[${i}]`));
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (/secret/i.test(key)) {
        throw new ConflictException(
          `Task definition export invariant violated: "${path}.${key}" matches the secrets red line (/secret/i) — secrets must never appear in an export payload (SEC-02)`,
        );
      }
      assertNoSecretMaterial(value, `${path}.${key}`);
    }
  }
}

/**
 * 装配导出物。显式白名单复制（secrets/webhookSecret/id/status/ownerUserId/
 * 审计列不在集合内，整键剔除），随后跑 secrets 红线不变量。
 */
export function buildTaskExportPayload(task: Task): TaskExportPayload {
  const definition: Record<string, unknown> = {};
  for (const key of TASK_DEFINITION_EXPORT_KEYS) {
    definition[key] = task[key];
  }
  const payload: TaskExportPayload = {
    schemaVersion: TASK_EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    task: definition,
  };
  assertNoSecretMaterial(payload);
  return payload;
}

/** 导出文件名：任务名 slug 化（非法字符折叠为 "-"），限制长度防 Response 头问题。 */
export function buildExportFilename(name: string): string {
  const slug =
    name
      .normalize("NFKD")
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "task";
  return `task-${slug}.json`;
}

/** exportDefinition 的一步式入口（service 侧仅 findOne + 本函数）。 */
export function buildTaskExportResult(task: Task): TaskExportResult {
  return {
    filename: buildExportFilename(task.name),
    payload: buildTaskExportPayload(task),
  };
}

/**
 * 导入重名后缀推导：ordinal 0 = 原名；1 = 首次冲突 → ` (imported)`；
 * n ≥ 2 = 仍冲突 → ` (imported) n`。纯函数（后缀策略单测钉住）。
 */
export function importNameCandidate(base: string, ordinal: number): string {
  if (ordinal <= 0) return base;
  if (ordinal === 1) return `${base} (imported)`;
  return `${base} (imported) ${ordinal}`;
}

/**
 * 导入物 → CreateTaskDto 形状映射（纯函数）。
 *
 * 入参用结构化最小形状 `{ schemaVersion?/exportedAt?/task? }`：同时接受
 * TaskExportPayload（导出物）与 ImportTaskDto（导入请求体，task 为嵌套
 * CreateTaskDto 实例），避免 util ↔ dto 循环导入。任务对象按白名单复制。
 *
 * - 同一份白名单（TASK_DEFINITION_EXPORT_KEYS）对称复制——id/status/
 *   secrets/webhookSecret/审计列**不可能**被带进 create 链路（整键丢弃，
 *   即使导入物里带了也无效）；
 * - warnings 常驻 secrets 重配提示；导入物显式携带 secrets 时追加"已忽略"
 *   提示（该键绝不落库）；
 * - name 缺失/空白在此 fail-closed 400（HTTP 面 ValidationPipe 已拦，本守卫
 *   覆盖编程式调用方）。
 */
export function mapExportToCreateDto(payload: {
  task?: unknown;
  schemaVersion?: unknown;
  exportedAt?: unknown;
}): {
  dto: CreateTaskDto;
  warnings: string[];
} {
  const source = (payload?.task ?? {}) as Record<string, unknown>;
  const name = source["name"];
  if (typeof name !== "string" || name.trim() === "") {
    throw new BadRequestException(
      'Invalid import payload: "task.name" is required and must be a non-empty string',
    );
  }
  const dto: Record<string, unknown> = {};
  for (const key of TASK_DEFINITION_EXPORT_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      dto[key] = value;
    }
  }
  dto["name"] = name;
  const warnings: string[] = [TASK_IMPORT_SECRETS_WARNING];
  if (source["secrets"] !== undefined) {
    warnings.push(TASK_IMPORT_SECRETS_IGNORED_WARNING);
  }
  return { dto: dto as unknown as CreateTaskDto, warnings };
}
