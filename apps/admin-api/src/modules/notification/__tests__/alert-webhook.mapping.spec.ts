import {
  DEFAULT_RUNBOOK_BASE_URL,
  extractRunbookUrl,
  mapAlertmanagerPayload,
  normalizeAlertStatus,
} from "../alert-webhook.mapping";

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
      alerts: [{ ...firingAlert, status: "resolved" }, firingAlert],
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

/**
 * OBS3-06：runbook 通道的兼容面。
 *
 * 接线版（config/monitoring/alerts.yml）现在写 `annotations.runbook_url`
 * （绝对 URL）；阅读版与历史配置写的是**相对路径**的 `runbook:`。两个都要认，
 * 且相对路径必须补成绝对 URL——否则通知正文里的链接点不开，等于没有 runbook。
 */
describe("extractRunbookUrl (OBS3-06 兼容面)", () => {
  it("runbook_url 命中时原样返回（首选）", () => {
    expect(
      extractRunbookUrl({
        annotations: { runbook_url: " https://example.com/rb#x " },
      }),
    ).toBe("https://example.com/rb#x");
  });

  it("旧字段 runbook 的绝对 URL 直接返回", () => {
    expect(
      extractRunbookUrl({ annotations: { runbook: "https://example.com/rb" } }),
    ).toBe("https://example.com/rb");
  });

  it("旧字段 runbook 的相对路径按仓库文档地址补成绝对 URL", () => {
    expect(
      extractRunbookUrl({
        annotations: { runbook: "docs/observability/README.md#http-red" },
      }),
    ).toBe(`${DEFAULT_RUNBOOK_BASE_URL}docs/observability/README.md#http-red`);
  });

  it("baseUrl 可注入（部署到别的文档站时不必改代码）", () => {
    expect(
      extractRunbookUrl(
        { annotations: { runbook: "/runbooks/pg.md" } },
        { baseUrl: "https://docs.example.com/" },
      ),
    ).toBe("https://docs.example.com/runbooks/pg.md");
  });

  it("runbook_url 优先于旧 runbook（两者都在时）", () => {
    expect(
      extractRunbookUrl({
        annotations: {
          runbook_url: "https://example.com/new",
          runbook: "docs/old.md",
        },
      }),
    ).toBe("https://example.com/new");
  });

  it("两个字段都缺/为空白时返回 null（正文不留空 Runbook 段）", () => {
    expect(extractRunbookUrl({})).toBeNull();
    expect(extractRunbookUrl({ annotations: { runbook: "   " } })).toBeNull();
    expect(extractRunbookUrl({ annotations: { runbook_url: "" } })).toBeNull();
  });

  it("端到端：只有相对 runbook 的告警，通知正文里是可点击的绝对 URL", () => {
    const mapped = mapAlertmanagerPayload({
      alerts: [
        {
          ...firingAlert,
          annotations: {
            ...firingAlert.annotations,
            runbook: "docs/observability/README.md#autoflow_queue_backlog",
          },
        },
      ],
    })!;
    expect(mapped.content).toContain(
      `Runbook: ${DEFAULT_RUNBOOK_BASE_URL}docs/observability/README.md#autoflow_queue_backlog`,
    );
  });
});
