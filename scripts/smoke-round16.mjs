/**
 * 第十六轮真机冒烟（VERIFY-smoke-round16）：对运行中的 admin-api 做运行时断言。
 * 覆盖：登录 → silences CRUD（FEAT-01）→ fixed_rate 触发延迟直方图（CORE-06）
 * → Prometheus 新 series → manual 触发 PENDING 行（队列健康）→ 清理。
 */
const BASE = "http://localhost:3105";
const PASSWORD = process.env.SMOKE_PASSWORD;
if (!PASSWORD) {
  console.error("SMOKE_PASSWORD required");
  process.exit(1);
}

const results = [];
const assert = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"} - ${name}${detail ? ` (${detail})` : ""}`);
};

const unwrap = (raw) =>
  raw && typeof raw === "object" && "data" in raw && ("code" in raw || "message" in raw)
    ? raw.data
    : raw;

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

async function main() {
  // 1. 登录
  const login = await api("/api/auth/login", {
    method: "POST",
    body: { username: process.env.SMOKE_USER || "admin", password: PASSWORD },
  });
  const token = unwrap(login.data)?.accessToken;
  assert("login returns accessToken", !!token, `status=${login.status}`);
  if (!token) process.exit(1);

  // 2. FEAT-01 silences CRUD（真机 DB 往返）
  const created = await api("/api/notification/silences", {
    method: "POST",
    token,
    body: { scope: "task", taskId: "00000000-0000-0000-0000-000000000000", durationMinutes: 5, reason: "smoke-test" },
  });
  const silenceId = unwrap(created.data)?.id;
  assert("POST /notification/silences creates (201)", created.status === 201 && !!silenceId, `status=${created.status}`);

  const listed = await api("/api/notification/silences", { token });
  const found = (unwrap(listed.data) ?? []).some((s) => s.id === silenceId);
  assert("GET /notification/silences lists the created row", found, `status=${listed.status}`);

  const removed = await api(`/api/notification/silences/${silenceId}`, { method: "DELETE", token });
  assert("DELETE /notification/silences/:id removes", removed.status === 200 && unwrap(removed.data) === true, `status=${removed.status}`);

  // 3. CORE-06：创建 fixed_rate 5s 任务 → 等 12s（至少两拍）→ 延迟直方图有样本
  const mk = await api("/api/tasks", {
    method: "POST",
    token,
    body: {
      name: "smoke-latency-fixed",
      runtime: "node",
      entrypoint: "noop.js",
      triggerType: "fixed_rate",
      fixedRate: 5,
      timeout: 10,
      maxRetry: 0,
    },
  });
  const taskId = unwrap(mk.data)?.id;
  assert("create fixed_rate smoke task", mk.status === 201 && !!taskId, `status=${mk.status}`);

  // CORE-06：新任务要等调度器分钟级 reload 收编（scheduleOne 仅 Leader 执行），
  // 轮询至 90s——触发后 fixed_rate 每 5s 一拍，延迟直方图应有样本
  let latCount = 0;
  let latBuckets = [];
  let p99 = undefined;
  for (let i = 0; i < 18; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const sched = await api("/api/metrics/scheduler", { token });
    const counters = unwrap(sched.data)?.counters ?? {};
    latCount = counters.triggerLatencyCount ?? 0;
    latBuckets = counters.triggerLatencyBuckets ?? [];
    p99 = unwrap(sched.data)?.derived?.p99TriggerLatencyMs;
    if (latCount > 0) break;
  }
  assert("CORE-06 fixed_rate trigger latency recorded (count > 0)", latCount > 0, `count=${latCount}`);
  assert("CORE-06 latency buckets array aligned (8 buckets)", Array.isArray(latBuckets) && latBuckets.length === 8, JSON.stringify(latBuckets));
  assert("CORE-06 derived p99 exposed", typeof p99 === "number", `p99=${p99}`);

  // 4. Prometheus 文本端点（text/plain，不能用 res.json）
  const promRes = await fetch(`${BASE}/api/metrics`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await promRes.text();
  assert("prom renders latency bucket series", text.includes("autoflow_scheduler_trigger_latency_ms_bucket"), "");
  assert("prom renders latency +Inf and sum/count", text.includes('le="+Inf"') && text.includes("autoflow_scheduler_trigger_latency_ms_sum"), "");
  assert("prom renders sse gauges (BUG-05)", text.includes("autoflow_sse_streams_active") && text.includes("autoflow_sse_streams_limit"), "");

  // 5. manual 触发 → PENDING 行（无执行器，队列健康即可）
  const trig = await api(`/api/tasks/${taskId}/trigger`, { method: "POST", token, body: {} });
  const execId = unwrap(trig.data)?.executionId ?? unwrap(trig.data)?.id;
  assert("manual trigger accepted (no executor → queued/pending)", trig.status === 201, `status=${trig.status} exec=${execId}`);

  // 6. 清理：暂停 + 软删 smoke 任务
  const paused = await api(`/api/tasks/${taskId}/pause`, { method: "POST", token });
  const deleted = await api(`/api/tasks/${taskId}`, { method: "DELETE", token });
  assert("cleanup: pause+delete smoke task", paused.ok && deleted.ok, "");

  const failed = results.filter((r) => !r.pass);
  console.log(`\n[smoke] ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("[smoke] fatal:", e);
  process.exit(1);
});
