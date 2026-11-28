# AutoCodeFlow — Positioning

This is the external-facing pitch. The `docs/` tree also contains internal handoff/process logs (round notes, ADRs, agent handoffs); those are working records, not the product promise. Link to capability from here, do not quote internal logs as marketing.

## The one promise

**A SOP execution runtime inside your network — humans write SOPs that define "what done means", AI agents execute them on real desktops, and every step leaves auditable evidence.**

## Primary audience

The developer / ops engineer who runs scheduled scripts and AI agents on real machines inside their own network, and needs the results to be **observable and verifiable**. They can run Docker and use a terminal.

The second audience is the **process owner** — often a business-side person — who wants recurring manual work handed to AI: they draft or review the SOP that defines "what done means", then delegate the execution. The desktop workbench is the **entry form** for this audience to submit goals into the SOP pipeline; it is not a separate product line.

## Three core paths

1. **Ops quick path.** `./scripts/demo.sh` → instantiate a template → schedule it (cron / webhook) → failures land in the inbox → a read-only agent session helps diagnose → fix. Success metric: TTFV median ≤ 10 minutes (instrumented).
2. **SOP main path (mainline).** Draft a SOP from a screen recording or a chat → a human completes the acceptance criteria and publishes → assign to a real executor → the desktop agent executes on the real machine → clarifications and machine acceptance → audited timeline and artifacts → controlled revision.
3. **Business light path (entry form, not a separate product line).** Submit a goal in the workbench → deterministic plan card (AI suggestions, where present, are display-only) → approval → execution through the SOP pipeline → auditable evidence.

## Current capability matrix

Status is as of 2026-11-28 and reflects what is actually in the code.

| Capability | Status | What actually works today |
|---|---|---|
| SOP pipeline | Shipped — full chain (draft → publish gate → assign → desktop execution → clarification → machine acceptance → controlled revision) | Screen-recording / chat drafts are AI-assisted and never self-publish; an admin publish (approval required) freezes an immutable snapshot with `contentHash`; assignment dispatches to a pulling executor and the desktop agent runs on the real machine; clarification round-trips and platform acceptance really verify; revisions go through controlled patch versions. |
| Scheduler + executors | Shipped | Cron / fixed-rate / webhook / DAG scheduling; Node, Python and Electron executors pull work, report logs, status and artifacts. |
| Auditable timeline | Shipped | Run timeline is built from stored `createdAt` / `startTime` / `endTime` timestamps. It is **not** step-by-step replay. |
| MCP tool surface | Shipped | 63 registered tools (runtime baseline `EXPECTED_TOOL_COUNT = 63`). |
| Deterministic plan-card scaffold | Partial | `buildPreview` maps goal + cadence to a rule-checked plan card (whitelist, budget cap, acceptance `task_status=success`). Cards are deterministic by default; an optional AI enhancement exists behind the `useAi` flag (15 s timeout, falls back to deterministic, never enters card hash / eligibility) but has no UI entry yet. |
| Business-user workbench (entry form) | Partial | A separate isolated desktop window plus the central `/workbench` page exist as the entry form for submitting goals into the SOP pipeline. The direct workbench-session → SOP-assignment link is not wired yet. |
| Approval / four-eyes | Partial | Two-person approval exists for deployments; `sop_publish` requires explicit approval (publish right = instruction-injection right); scope/policy engine and in-process gates are wired. |
| Cost / observability | Partial | Prometheus metrics, SSE logs, Loki aggregation, relative budget units (RU, no token prices). `traceparent` is propagated and spans stay in in-process `[trace]` logs; there is no OTLP export. |

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

This path exercises scheduler + executors + the auditable timeline. It does **not** exercise an AI planner or a step-replay viewer — neither exists as an autonomous planner.

## Explicit non-goals

- Not a managed SaaS. Self-hosted first; APIs may still change within 2.x.
- Not a big-data / Spark / Flink orchestration engine.
- Not a step-replay engine — the timeline reports timestamps, not reconstructed steps.
- Not an autonomous AI planner — plan cards are deterministic templates (AI suggestions are display-only); a human must publish.
- Not a no-terminal product for teams that refuse to touch a CLI.
- Not an OTLP/Jaeger trace backend today — `traceparent` propagates, spans stay in in-process logs, and no OTLP export is wired.
- Not a business-user cockpit product — the workbench is an entry form into the SOP pipeline, not a parallel product line.

Internal process logs are not part of this external positioning; do not present them as product capability.
