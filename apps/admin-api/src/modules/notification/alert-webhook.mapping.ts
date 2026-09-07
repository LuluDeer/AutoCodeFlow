/**
 * OBS-02: Alertmanager v2 webhook payload → NotificationPayload 映射纯函数。
 *
 * 输入为 Alertmanager `POST /api/v2/alerts` 的 JSON body（alerts[] 数组，
 * 每项含 status / labels / annotations / startsAt 等字段）。本模块刻意保持
 * 纯函数（无 Nest/DB 依赖），与 timeout-policy.util / execution-timeline.util
 * 同一模式：控制器持有 HMAC 校验与外发编排，本文件只做确定性映射，测试
 * 向量直接钉死行为。
 *
 * 映射规则（对齐计划书 §4 主题 B 验收点）：
 * - title = `[Alert] <alertname> <status>`（alertname 缺省 "unknown"）
 * - content = labels / annotations 摘要 + startsAt（ISO 字符串原样透出）
 * - annotations.runbook_url 命中时追加 `Runbook: <url>` 段
 * - labels.taskId 命中时由调用方（controller）查 tasks.runbook 追加
 *   `Runbook:` 段——DB 查询不进纯函数，通过注入 runbookUrl 参数拼接
 * - level：firing → error，resolved → info（severity label 不改变量级，
 *   避免告警方与通知渠道两套 severity 语义漂移——外发语义只认两态）
 */

/** Alertmanager v2 单条告警结构（仅声明本映射消费的字段，其余透传不解析）。 */
export interface AlertmanagerAlert {
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
  fingerprint?: string;
}

/** Alertmanager v2 webhook body 顶层结构。 */
export interface AlertmanagerWebhookPayload {
  version?: string;
  groupKey?: string;
  truncatedAlerts?: number;
  status?: string;
  receiver?: string;
  groupLabels?: Record<string, string>;
  commonLabels?: Record<string, string>;
  commonAnnotations?: Record<string, string>;
  externalURL?: string;
  alerts?: AlertmanagerAlert[];
}

export interface MappedAlertNotification {
  title: string;
  content: string;
  level: "info" | "warning" | "error" | "critical";
  /** 第一个 firing 告警的 labels.taskId（无则 null），供调用方查 tasks.runbook。 */
  taskId: string | null;
  /** 告警条数（多告警合并为一条通知）。 */
  alertCount: number;
}

/** 归一化告警状态：仅认 firing / resolved，未知状态 fail-safe 归 firing。 */
export function normalizeAlertStatus(status: string | undefined): "firing" | "resolved" {
  return status === "resolved" ? "resolved" : "firing";
}

/** labels/annotations 键值对 → `k=v` 行（按 key 排序，稳定输出可测）。 */
function formatKvLines(kv: Record<string, string> | undefined): string[] {
  if (!kv) return [];
  return Object.keys(kv)
    .sort()
    .map((k) => `${k}=${kv[k]}`);
}

/**
 * 把一条 Alertmanager 告警渲染为 content 段。
 * runbookUrl 参数由调用方解析（annotations.runbook_url 或 tasks.runbook 注入）
 * 后传入——本函数不做 DB 查询。
 */
function renderAlertSection(alert: AlertmanagerAlert, runbookUrl: string | null): string {
  const lines: string[] = [];
  const status = normalizeAlertStatus(alert.status);
  const alertname = alert.labels?.alertname ?? "unknown";
  lines.push(`### [${status}] ${alertname}`);
  const labels = formatKvLines(alert.labels);
  if (labels.length > 0) {
    lines.push("Labels:");
    lines.push(...labels.map((l) => `- ${l}`));
  }
  const annotations = formatKvLines(alert.annotations);
  if (annotations.length > 0) {
    lines.push("Annotations:");
    lines.push(...annotations.map((l) => `- ${l}`));
  }
  if (alert.startsAt) {
    lines.push(`Starts at: ${alert.startsAt}`);
  }
  if (runbookUrl) {
    lines.push(`Runbook: ${runbookUrl}`);
  }
  return lines.join("\n");
}

/**
 * 解析一条告警的 runbook 链接：annotations.runbook_url 优先（Alertmanager
 * 规则 annotations 惯例），退化 null。
 */
export function extractRunbookUrl(alert: AlertmanagerAlert): string | null {
  const raw = alert.annotations?.runbook_url;
  if (typeof raw === "string" && raw.trim() !== "") {
    return raw.trim();
  }
  return null;
}

/**
 * 主映射：Alertmanager v2 payload → 单条通知 payload。
 *
 * - alerts 为空 / 非数组：返回 null（控制器据此 400，不发空通知）。
 * - 多条告警合并为一条通知（Alertmanager 本就以 group 维度推送）。
 * - level 取"最坏态"：任一 firing → error，否则（全部 resolved）→ info。
 * - taskId 取第一条 firing 告警的 labels.taskId（runbook 拼接只需一次查询）。
 */
export function mapAlertmanagerPayload(
  payload: AlertmanagerWebhookPayload,
  options?: { /** 调用方查库得到的 tasks.runbook 内容/链接（taskId 命中时传入）。 */
    taskRunbook?: string | null;
    /** 注入时间源，缺省 Date.now——测试钉死"时间戳过期"行为用。 */
    nowMs?: number;
  },
): MappedAlertNotification | null {
  const alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
  if (alerts.length === 0) return null;

  const firingCount = alerts.filter(
    (a) => normalizeAlertStatus(a.status) === "firing",
  ).length;
  const headStatus = firingCount > 0 ? "firing" : "resolved";
  const firstFiring =
    alerts.find((a) => normalizeAlertStatus(a.status) === "firing") ?? alerts[0];
  const alertname =
    firstFiring.labels?.alertname ?? payload.commonLabels?.alertname ?? "unknown";

  // runbook 解析顺序：第一条 firing 告警的 annotations.runbook_url >
  // 调用方查库注入的 tasks.runbook（labels.taskId 命中）。
  const annotationRunbook = extractRunbookUrl(firstFiring);
  const runbookUrl = annotationRunbook ?? (options?.taskRunbook || null);

  const sections = alerts.map((a) => renderAlertSection(a, runbookUrl));
  const contentParts = sections.slice();
  if (payload.externalURL) {
    contentParts.push(`Alertmanager: ${payload.externalURL}`);
  }
  const content = contentParts.join("\n\n");

  return {
    title: `[Alert] ${alertname} ${headStatus}`,
    content,
    // firing → error（走既有失败告警同级语义）；全 resolved → info。
    level: firingCount > 0 ? "error" : "info",
    taskId:
      typeof firstFiring.labels?.taskId === "string" &&
      firstFiring.labels.taskId.trim() !== ""
        ? firstFiring.labels.taskId.trim()
        : null,
    alertCount: alerts.length,
  };
}
