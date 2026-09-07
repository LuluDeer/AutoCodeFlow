import { mapAlertmanagerPayload, normalizeAlertStatus } from "../alert-webhook.mapping";

/** Alertmanager v2 webhook 标准形态的最小样本（对齐官方文档字段）。 */
const firingAlert = {
  status: "firing",
  labels: {
    alertname: "AUTOFLOW_QUEUE_BACKLOG",
    severity: "warning",
    instance: "admin-api-1",
  },
  annotations: {
    summary: "任务队列积压",
    description: "waiting 深度 120 持续 10 分钟",
  },
  startsAt: "2026-09-07T05:00:00Z",
  endsAt: "0001-01-01T00:00:00Z",
};

describe("normalizeAlertStatus", () => {
  it("maps firing and resolved, and fails safe to firing on unknown/missing", () => {
    expect(normalizeAlertStatus("firing")).toBe("firing");
    expect(normalizeAlertStatus("resolved")).toBe("resolved");
    expect(normalizeAlertStatus("weird")).toBe("firing");
    expect(normalizeAlertStatus(undefined)).toBe("firing");
  });
});

describe("mapAlertmanagerPayload (OBS-02)", () => {
  it("returns null for missing/empty alerts array (controller 400s on this)", () => {
    expect(mapAlertmanagerPayload({} as any)).toBeNull();
    expect(mapAlertmanagerPayload({ alerts: [] })).toBeNull();
    expect(mapAlertmanagerPayload({ alerts: "nope" } as any)).toBeNull();
  });

  it("maps a firing alert: [Alert] <alertname> firing, level=error, labels/annotations/startsAt summarized", () => {
    const mapped = mapAlertmanagerPayload({
      alerts: [firingAlert],
      externalURL: "http://alertmanager:9093",
    })!;
    expect(mapped.title).toBe("[Alert] AUTOFLOW_QUEUE_BACKLOG firing");
    expect(mapped.level).toBe("error");
    expect(mapped.taskId).toBeNull();
    expect(mapped.alertCount).toBe(1);
    // labels/annotations 键序稳定（排序），startsAt 原样透出
    expect(mapped.content).toContain("### [firing] AUTOFLOW_QUEUE_BACKLOG");
    expect(mapped.content).toContain("- alertname=AUTOFLOW_QUEUE_BACKLOG");
    expect(mapped.content).toContain("- severity=warning");
    expect(mapped.content).toContain("- summary=任务队列积压");
    expect(mapped.content).toContain("Starts at: 2026-09-07T05:00:00Z");
    expect(mapped.content).toContain("Alertmanager: http://alertmanager:9093");
  });

  it("all-resolved payload maps to level=info and title says resolved", () => {
    const mapped = mapAlertmanagerPayload({
      alerts: [{ ...firingAlert, status: "resolved" }],
    })!;
    expect(mapped.title).toBe("[Alert] AUTOFLOW_QUEUE_BACKLOG resolved");
    expect(mapped.level).toBe("info");
  });

  it("mixed firing/resolved takes worst case (error) and firing title", () => {
    const mapped = mapAlertmanagerPayload({
      alerts: [
        { ...firingAlert, status: "resolved" },
        firingAlert,
      ],
    })!;
    expect(mapped.level).toBe("error");
    expect(mapped.title).toBe("[Alert] AUTOFLOW_QUEUE_BACKLOG firing");
    expect(mapped.alertCount).toBe(2);
  });

  it("annotations.runbook_url lands in the content as a Runbook: section", () => {
    const mapped = mapAlertmanagerPayload({
      alerts: [
        {
          ...firingAlert,
          annotations: {
            ...firingAlert.annotations,
            runbook_url: "https://wiki.example.com/runbooks/queue-backlog",
          },
        },
      ],
    })!;
    expect(mapped.content).toContain(
      "Runbook: https://wiki.example.com/runbooks/queue-backlog",
    );
  });

  it("labels.taskId is surfaced for the caller to resolve tasks.runbook, which is then stitched in", () => {
    const mapped = mapAlertmanagerPayload(
      {
        alerts: [
          {
            ...firingAlert,
            labels: { ...firingAlert.labels, taskId: "task-abc" },
          },
        ],
      },
      { taskRunbook: "1. 检查执行器在线数\n2. 重启 admin-api" },
    )!;
    expect(mapped.taskId).toBe("task-abc");
    expect(mapped.content).toContain(
      "Runbook: 1. 检查执行器在线数\n2. 重启 admin-api",
    );
  });

  it("annotation runbook_url wins over the injected tasks.runbook", () => {
    const mapped = mapAlertmanagerPayload(
      {
        alerts: [
          {
            ...firingAlert,
            labels: { ...firingAlert.labels, taskId: "task-abc" },
            annotations: {
              ...firingAlert.annotations,
              runbook_url: "https://wiki.example.com/rb",
            },
          },
        ],
      },
      { taskRunbook: "tasks.runbook 内容" },
    )!;
    expect(mapped.content).toContain("Runbook: https://wiki.example.com/rb");
    expect(mapped.content).not.toContain("tasks.runbook 内容");
  });

  it("alertname falls back to commonLabels then 'unknown'; missing startsAt renders without the line", () => {
    const fallback = mapAlertmanagerPayload({
      commonLabels: { alertname: "COMMON_NAME" },
      alerts: [{ status: "firing" }],
    })!;
    expect(fallback.title).toBe("[Alert] COMMON_NAME firing");
    const unknown = mapAlertmanagerPayload({
      alerts: [{ status: "firing" }],
    })!;
    expect(unknown.title).toBe("[Alert] unknown firing");
    expect(unknown.content).not.toContain("Starts at:");
  });
});
