/**
 * CORE-03：官方预置任务模板。
 *
 * ⚠️ 与 packages/mcp-server/src/tools.ts 的 `TASK_TEMPLATES`（ECO-03）保持
 * **同一口径**：五个 key（scheduled_backup/health_check/data_sync/log_cleanup/
 * webhook_ping）、定位、以及 config 字段集合逐项对齐——避免 admin 与 MCP 两套
 * 模板语义漂移。config 字段名/默认值以 CreateTaskDto 白名单为准（落库前经
 * `assertValidTaskTemplateConfig` 校验），此处省略 `name`（实例化任务时提供）。
 *
 * 本常量是迁移 seed 与单测共用的**单一事实源**：迁移 SQL 由 `officialSeedSql()`
 * 派生，避免两处硬编码不一致。
 */

export interface OfficialTaskTemplateSeed {
  key: string;
  name: string;
  description: string;
  category: string;
  config: Record<string, unknown>;
}

export const OFFICIAL_TASK_TEMPLATES: OfficialTaskTemplateSeed[] = [
  {
    key: "scheduled_backup",
    name: "定时备份",
    description:
      "周期性备份任务：Cron 定时触发（默认每天 02:00），失败按重试预算退避重试，冲突丢弃。",
    category: "备份",
    config: {
      triggerType: "cron",
      cronExpression: "0 2 * * *",
      runtime: "shell",
      entrypoint: "backup.sh",
      timeoutSeconds: 3600,
      maxRetry: 3,
      retryDelay: 60,
      blockStrategy: "discard",
    },
  },
  {
    key: "health_check",
    name: "健康巡检",
    description:
      "端点/服务健康探针：固定间隔轮询（默认 60s），低超时、不重试——快速失败暴露问题。",
    category: "巡检",
    config: {
      triggerType: "fixed_rate",
      fixedRate: 60,
      runtime: "shell",
      entrypoint: "check.sh",
      timeoutSeconds: 30,
      maxRetry: 0,
    },
  },
  {
    key: "data_sync",
    name: "数据同步",
    description:
      "数据同步流水线：较长超时、串行不重叠、失败退避重试（默认每 30 分钟一次）。",
    category: "同步",
    config: {
      triggerType: "fixed_rate",
      fixedRate: 1800,
      runtime: "python",
      entrypoint: "sync.py",
      timeoutSeconds: 7200,
      maxRetry: 2,
      retryDelay: 300,
      blockStrategy: "discard",
    },
  },
  {
    key: "log_cleanup",
    name: "日志清理",
    description:
      "每日清理：在执行器主机上剪除过期文件/日志（默认每天 03:30），失败轻试一次。",
    category: "清理",
    config: {
      triggerType: "cron",
      cronExpression: "30 3 * * *",
      runtime: "shell",
      entrypoint: "cleanup.sh",
      timeoutSeconds: 600,
      maxRetry: 1,
    },
  },
  {
    key: "webhook_ping",
    name: "Webhook 通知",
    description:
      "手动/API 触发的出站 Webhook 通知器，通常作为下游依赖串联，不排程。",
    category: "通知",
    config: {
      triggerType: "manual",
      runtime: "node",
      entrypoint: "ping.js",
      timeoutSeconds: 60,
      maxRetry: 1,
    },
  },
];

/** 官方模板 key 集合（列表排序 / 删除保护判定用）。 */
export const OFFICIAL_TEMPLATE_KEYS = OFFICIAL_TASK_TEMPLATES.map((t) => t.key);

/**
 * 派生迁移内幂等 seed 的 INSERT 语句（`ON CONFLICT (key) DO NOTHING`）。
 * 对 JSON 与字符串做单引号转义——官方模板数据虽为常量，转义保证 SQL 结构安全
 * 且可读回；`isOfficial` 恒 true。config 以参数化 jsonb 文本插入。
 */
export function officialSeedSql(): string {
  const esc = (s: string) => s.replace(/'/g, "''");
  const values = OFFICIAL_TASK_TEMPLATES.map((t) => {
    const configJson = esc(JSON.stringify(t.config));
    return `('${esc(t.key)}', '${esc(t.name)}', '${esc(t.description)}', '${esc(
      t.category,
    )}', '${configJson}'::jsonb, true)`;
  }).join(",\n        ");
  return `
      INSERT INTO "task_templates" ("key", "name", "description", "category", "config", "isOfficial")
      VALUES
        ${values}
      ON CONFLICT ("key") DO NOTHING
  `;
}
