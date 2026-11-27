# AutoCodeFlow — Positioning

This is the external-facing pitch. The `docs/` tree also contains internal handoff/process logs (round notes, ADRs, agent handoffs); those are working records, not the product promise. Link to capability from here, do not quote internal logs as marketing.

## Primary persona

The developer / ops engineer who runs scheduled scripts and AI agents on real machines inside their own network, and needs the results to be **observable and verifiable**. They can run Docker and use a terminal. A business user with a workbench is an emerging second audience, not the primary one.

## The one promise

**Give AI agents hands on real desktops and leave auditable evidence of what they did.**

## Current capability matrix

Status is as of 2026-11-27 and reflects what is actually in the code.

| Capability | Status | What actually works today |
|---|---|---|
| Scheduler + executors | Shipped | Cron / fixed-rate / webhook / DAG scheduling; Node, Python and Electron executors pull work, report logs, status and artifacts. |
| Auditable timeline | Shipped | Run timeline is built from stored `createdAt` / `startTime` / `endTime` timestamps. It is **not** step-by-step replay. |
| MCP tool surface | Shipped | 57 registered tools (runtime baseline `EXPECTED_TOOL_COUNT = 57`). |
| Deterministic plan-card scaffold | Partial | `buildPreview` maps goal + cadence to a rule-checked plan card (whitelist, budget cap, acceptance `task_status=success`). No LLM is called; it is not autonomous planning. |
| Admin publish of SOP drafts | Shipped | Commit produces a **draft**; an admin must publish before it takes effect. Nothing self-publishes. |
| Business-user workbench | Emerging | A separate isolated desktop window plus a central `/workbench` web page exist. In-session capabilities are still being implemented (see phases below). |
| Approval / four-eyes | Partial | Two-person approval exists for deployments; scope/policy engine and in-process gates are wired. Broader workbench four-eyes flows remain in progress. |
| Cost / observability | Partial | Prometheus metrics, SSE logs, Loki aggregation, relative budget units (RU, no token prices). `traceparent` is propagated, but spans stay in in-process `[trace]` logs; **OTLP export is not wired**, so the Jaeger UI stays empty. |

### Desktop workbench phases (ADR-044)

- **Phase A — shipped (2026-11-27):** a separate `BrowserWindow` with an isolated session partition (`persist:acf-workbench`), a minimal preload, and `loadURL` of the central `/workbench` page. The original four executor pages (status / config / history / apps) are unchanged.
- **Phase B — in progress:** in-session capability flow (goal → preview → commit → approval → record), session manager and tool process.
- **Phase C — planned:** hardening / follow-on work beyond the in-session flow. Not claimed complete.

## The 5-minute first-run path (what actually works today)

```bash
git clone https://github.com/LuluDeer/AutoCodeFlow.git
cd AutoCodeFlow
./scripts/demo.sh
```

The script generates secrets, starts an isolated local stack (it never touches your `.env`), seeds demo tasks and SOPs, triggers one run and waits for `SUCCESS`, then prints the UI URL and admin password.

- First run builds images (~3–8 min depending on network); later starts ~30 s.
- UI: `http://localhost:8088`; API docs: `http://127.0.0.1:3105/api/docs`.
- Stop: `./scripts/demo.sh --down`; reset: `./scripts/demo.sh --reset`.
- Deeper walkthrough: [quickstart](quickstart.md).

This path exercises scheduler + executors + the auditable timeline. It does **not** exercise an AI planner or a step-replay viewer — neither exists.

## Explicit non-goals

- Not a managed SaaS. Self-hosted first; APIs may still change within 2.x.
- Not a big-data / Spark / Flink orchestration engine.
- Not a step-replay engine — the timeline reports timestamps, not reconstructed steps.
- Not an autonomous AI planner — plan cards are deterministic templates; a human must publish.
- Not a no-terminal product for teams that refuse to touch a CLI.
- Not an OTLP/Jaeger trace backend today — OTLP export is planned, not implemented.
- Not a finished business-user workbench — phases B/C are in progress, not shipped.

Internal process logs are not part of this external positioning; do not present them as product capability.
