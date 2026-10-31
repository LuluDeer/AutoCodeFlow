#!/usr/bin/env node
/**
 * N5（R6-a / DA §4.1）：**本地 token 估算器 ↔ provider 实测 usage** 校准审计（只读）。
 *
 * ## 为什么需要它
 *
 * 上下文窗口闸门用的是本地启发式估算（`agent-context.ts` 的
 * `estimateTextTokens`：CJK 1 token/字、其余 4 字符/token），而 provider 每轮
 * 都在 `usage.prompt_tokens` 里回**真实**占用——它已被逐条落库
 * （`agent_steps.tokensIn`，写入点见 `agent-runtime.service.ts` 的
 * 「provider 的 usage.prompt_tokens 是本轮真实上下文占用」注释）。
 *
 * 于是「窗口到底会不会撞 400」这件事本可以**用库里已有的数据回答**，不必靠猜：
 *   · 估算无系统性偏差 → 不该动系数，也不该降默认 maxTokens，剩下的真实超窗
 *     只能靠提前收敛（N6）兜底；
 *   · 估算系统性偏低 → 要么调系数、要么降默认 maxTokens（保守裕量）；
 *   · 比值尾部极重（不可用单系数校正）→ 只能靠兜底 + 保守裕量。
 * 本脚本把这条判据机械化，并把结论写进 `agent.context.maxTokens` 的取值依据。
 *
 * ## 怎么算「同一轮的估算值」
 *
 * 对每个 `tokensIn > 0` 的 assistant 步 K，按 `rebuildMessages` 的**同一套规则**
 * 从 DB 重建「K 之前模型看到的 messages」（步骤正文 / tool_calls JSON / 折叠摘要
 * 替身 / 重放的工具应答），再用**源码里的真实估算函数**算 token（不是脚本自己
 * 复刻一份系数——复刻必然漂移）。
 *
 * ### 为什么比值要减掉「每会话常量」
 *
 * provider 的实测包含两块**库里没有**的占用：system prompt（`SYSTEM_PROMPT` +
 * `contextJson`）与工具 schema（几十个工具的 JSON schema，可达数千 token）。
 * 直接拿 DB 可重建的估算当分母，会把这两块全算成「估算偏低」，得出错误的
 * 「调系数/降默认」结论。
 *
 * 因此每个会话取**首轮残差** `offset = measured₁ − estimate₁`（它恰好就是
 * 该会话的 system + schema + 重建误差），之后每轮用
 * `adjusted = estimate + offset`，比值 `ratio = measured / adjusted`。
 * 常量在会话内相互抵消，剩下的是「随内容增长的那部分估算准不准」——这才是
 * 系数该回答的问题。只有一个实测轮的会话无法抵消常量，**整会话跳过**并计数。
 *
 * ### 如实声明的重建误差（不掩盖）
 *   · system prompt / 工具 schema 不参与逐轮估算，只经上面的首轮残差近似；
 *   · 工具结果正文以库里的 `resultJson`（≤32KB 预览形态）重建，运行时内存里
 *     的实时结果可能更长 → 估算在长结果上**偏低**；
 *   · 审批单状态细节（granted/denied/consumed）不重建，`awaiting_approval`
 *     一律按「等待人工审批」文案估算（量级同档）。
 *
 * ## 用法
 *   node scripts/agent-context-token-audit.mjs --report            # 默认动作
 *   node scripts/agent-context-token-audit.mjs --report --json
 *   node scripts/agent-context-token-audit.mjs --report --dsn postgres://u:p@h:5432/db
 *   node scripts/agent-context-token-audit.mjs --report --min-samples 50
 *   node scripts/agent-context-token-audit.mjs --selftest          # 判据自检（不连 DB）
 *
 * 连接参数：`--dsn` > `DATABASE_URL` > `DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/
 * DB_DATABASE`（缺省与 `configuration.ts` 一致：localhost:5432/postgres/autocodeflow）。
 * **只读**：只跑 SELECT，不写任何表、不写任何文件。
 *
 * ## 无可用 DB 时的行为（如实报错，不伪造数据）
 *   退出码 3，打印「连不上哪个 target（口令已省略）+ 三种跑法」。三种跑法分别是
 *   · 本机直连：`DB_HOST=... DB_PASSWORD=... node scripts/agent-context-token-audit.mjs`；
 *   · compose 网络内：`docker exec <admin-api 容器> node -e ...`（或把本脚本
 *     `docker cp` 进容器后 `docker exec ... node /tmp/agent-context-token-audit.mjs`，
 *     容器内 `DB_HOST=postgres` 才解析得到）；
 *   · 容器 IP 直连：`--dsn postgres://autoflow:<pwd>@<容器IP>:5432/autoflow`。
 *   退出码 4 表示「连上了但没有可用样本」（例如 `tokensIn` 全为 0）——这与
 *   「连不上」是两件事，报告里分开说。
 *
 * ## 预期输出形态
 *   数据源（口令省略）→ 样本计数（轮数/会话数/跳过会话数）→
 *   总体 p50/p90/p99 → 按 provider/model 分组 → 结论（四选一）+ 理由。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const ESTIMATOR_SOURCE =
  "apps/admin-api/src/modules/agent/runtime/agent-context.ts";
const SHAPING_SOURCE =
  "apps/admin-api/src/modules/agent/tools/tool-result-shaping.ts";
const RUNTIME_SOURCE =
  "apps/admin-api/src/modules/agent/runtime/agent-runtime.service.ts";

/** 发现「系统性偏低」所需的**最小样本轮数**；低于它不下结论（见 decideVerdict）。 */
export const MIN_SAMPLES = 30;
/** `TOOL_RESULT_REPLAY_MAX_CHARS` 的兜底值（真实值从源码读，见 readReplayMaxChars）。 */
export const REPLAY_MAX_CHARS_FALLBACK = 2000;

// ── 加载仓库内真实实现（Node ≥ 24 原生 TS 类型擦除；零 npm 依赖）────────────
let estimateTokens = null;
let estimateMessageTokens = null;
let shapeToolResultForModel = null;

async function loadRuntimeEstimator() {
  if (estimateTokens) return;
  const originalEmitWarning = process.emitWarning;
  // Node 对无 "type":"module" 的包内的 .ts 会打 MODULE_TYPELESS_PACKAGE_JSON
  // 警告——那是 import 机制的正常噪音，不是本脚本的问题，暂时静音。
  process.emitWarning = () => {};
  try {
    const ctx = await import(pathToFileURL(join(ROOT, ESTIMATOR_SOURCE)).href);
    const shaping = await import(
      pathToFileURL(join(ROOT, SHAPING_SOURCE)).href
    );
    estimateTokens = ctx.estimateTokens;
    estimateMessageTokens = ctx.estimateMessageTokens;
    shapeToolResultForModel = shaping.shapeToolResultForModel;
    if (
      typeof estimateTokens !== "function" ||
      typeof estimateMessageTokens !== "function" ||
      typeof shapeToolResultForModel !== "function"
    ) {
      throw new Error(
        "源码导出的函数名漂移（estimateTokens/estimateMessageTokens/shapeToolResultForModel）",
      );
    }
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

/**
 * 从 `agent-runtime.service.ts` 读 `TOOL_RESULT_REPLAY_MAX_CHARS`。
 * 读不到返回 null（调用方回落兜底值并明确标注），读到就与运行时同口径。
 */
export function readReplayMaxChars(root = ROOT) {
  try {
    const text = readFileSync(join(root, RUNTIME_SOURCE), "utf8");
    const m = text.match(/const\s+TOOL_RESULT_REPLAY_MAX_CHARS\s*=\s*([\d_]+)/);
    if (!m) return null;
    const n = Number(m[1].replace(/_/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// ── 纯计算：分位 / 比值 / 分组 / 结论（全部可被 --selftest 直接钉住）────────

/**
 * 最近秩分位（nearest-rank，不做线性插值）。
 *
 * 为什么不用插值：样本是「离散的比值观测」，插值出来的 p99 会是一个**没有
 * 任何一次观测对得上**的数；排障时人会去库里找那个比值的会话。最近秩保证
 * 分位数点名的值真实存在（与本仓「不引入 Histogram」的既有口径一致）。
 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

/** 一组比值 → { n, p50, p90, p99, min, max }（空集合返回 null 字段而非 0）。 */
export function summarize(ratios) {
  const clean = ratios.filter((r) => Number.isFinite(r) && r > 0);
  return {
    n: clean.length,
    p50: percentile(clean, 50),
    p90: percentile(clean, 90),
    p99: percentile(clean, 99),
    min: clean.length ? Math.min(...clean) : null,
    max: clean.length ? Math.max(...clean) : null,
  };
}

/** 按 key 分组 → Map<key, ratio[]>（保持插入顺序，便于稳定输出）。 */
export function groupRatios(samples, keyOf) {
  const groups = new Map();
  for (const s of samples) {
    const key = keyOf(s);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s.ratio);
  }
  return groups;
}

/**
 * 结论判据（四选一）。阈值是**判据**不是圣旨，全部由 --selftest 钉住：
 *   · 样本 < MIN_SAMPLES → `insufficient`：**不调系数、不降默认值**
 *     （用 30 轮不到的数据去动全局默认，是把噪声写进配置）。
 *   · p50 ≤ 1.25 → `keep_defaults_and_need_fallback`：估算无系统性偏低，
 *     系数与默认值都不该动；真实超窗只能靠提前收敛（N6）兜底。
 *   · p50 > 1.25 且 p90 ≤ 2.5 → `tune_coefficient`：系统性偏低且尾部可控，
 *     单系数能校正。
 *   · p50 > 1.25 且 p90 > 2.5 → `lower_default_max_tokens`：尾部重到单系数
 *     校不准，只能靠保守裕量（降默认 maxTokens）把风险压住。
 */
export function decideVerdict(overall, minSamples = MIN_SAMPLES) {
  if (overall.n < minSamples) {
    return {
      verdict: "insufficient",
      reason:
        `有效样本 ${overall.n} 轮 < 门槛 ${minSamples} 轮：数据不足以区分` +
        `「估算偏低」与「个别长会话」，不动系数、不动默认 maxTokens。`,
    };
  }
  if (overall.p50 <= 1.25) {
    return {
      verdict: "keep_defaults_and_need_fallback",
      reason:
        `p50=${overall.p50} ≤ 1.25：估算没有系统性偏低，调系数/降默认值都无证据；` +
        `真实超窗（折叠折不动）只能靠提前收敛兜底。`,
    };
  }
  if (overall.p90 <= 2.5) {
    return {
      verdict: "tune_coefficient",
      reason:
        `p50=${overall.p50} > 1.25 且 p90=${overall.p90} ≤ 2.5：估算系统性偏低、` +
        `尾部可控 → 按 p50 调整估算系数（或等量提高折叠触发裕量）。`,
    };
  }
  return {
    verdict: "lower_default_max_tokens",
    reason:
      `p50=${overall.p50} > 1.25 且 p90=${overall.p90} > 2.5：比值尾部过重，` +
      `单一系数校不准 → 用保守裕量（降默认 maxTokens）压住风险。`,
  };
}

/** 结论 → 一句可执行建议（写给人看，也用于落文档）。 */
export function verdictAdvice(verdict) {
  switch (verdict) {
    case "tune_coefficient":
      return "调 `agent-context.ts` 的估算系数（CJK/非 CJK 两档），改完重跑本脚本对比 p50。";
    case "lower_default_max_tokens":
      return "降低 `DEFAULT_CONTEXT_WINDOW.maxTokens`（或 `AGENT_CONTEXT_MAX_TOKENS`）留出保守裕量。";
    case "keep_defaults_and_need_fallback":
      return "不改系数、不改默认 maxTokens；靠 N6 的 `context_unrecoverable` 提前收敛兜底。";
    default:
      return "样本不足：保持现状（系数与默认值都不动），并继续用 N6 提前收敛兜底；攒够样本后重跑本脚本。";
  }
}

// ── 从 DB 行重建「某一轮的 prompt 估算」（镜像 rebuildMessages 的规则）──────

/** 工具调用行的「重放文案」——镜像 `replayedToolResult` 的主分支（审批细节见头注）。 */
export function renderReplayText(
  row,
  replayMaxChars = REPLAY_MAX_CHARS_FALLBACK,
) {
  if (!row) {
    return "【工具结果缺失】该调用没有对应的执行记录（可能在上报前中断）——请重新观察现状后再决定下一步。";
  }
  if (row.status === "awaiting_approval") {
    return `【等待人工审批】${row.errorMessage ?? "该调用需人工审批"}（会话已挂起；批准后会恢复；批准前请勿重复提交）。`;
  }
  if (row.status === "in_flight") {
    return (
      "【结果未知】该调用在进程中断前已发起，副作用可能已经发生。" +
      "请先用只读工具核实当前状态；确认未生效后再决定是否重新提交，" +
      "不要直接重提同一调用。"
    );
  }
  if (row.status === "ok") {
    const stored = row.resultJson ?? null;
    if (stored && stored.truncated === true) {
      if (typeof stored.full === "string") {
        const shaped = shapeToolResultForModel(stored.full, replayMaxChars);
        return `【工具结果（重放）】${shaped.content}`;
      }
      const preview = typeof stored.preview === "string" ? stored.preview : "";
      return (
        `【工具结果（重放·仅预览）】${preview}` +
        `\n（原结果超过 32KB 存储上限，仅保留预览与 sha256=${String(stored.sha256 ?? "n/a")}；` +
        `需要完整内容请按参数重新查询只读资源）`
      );
    }
    const body = stored ? JSON.stringify(stored) : "";
    const shaped = shapeToolResultForModel(body, replayMaxChars);
    return `【工具结果（重放）】${shaped.content}${
      row.resultTruncated ? "…（原结果已截断）" : ""
    }`;
  }
  if (
    row.status === "denied" &&
    typeof row.errorMessage === "string" &&
    row.errorMessage.startsWith("skipped:")
  ) {
    if (row.errorMessage.includes("approval")) {
      return "【未执行】本次调用因同批前一个调用进入人工审批而跳过（会话已挂起）。如需执行本调用，请在恢复后重新提交。";
    }
    return "【未执行】本次调用因会话墙钟预算到期而跳过。如需继续，请新建会话或调大预算后重新指派。";
  }
  return `【调用未成功】状态 ${row.status}${
    row.errorMessage ? `：${row.errorMessage}` : ""
  }`;
}

/** `stepToMessages` 的镜像：折叠步用摘要替身，tool 步带 tool_call_id。 */
export function stepToMessages(step) {
  if (step.summary && step.role !== "system") {
    return [
      {
        role: step.role === "tool" ? "user" : step.role,
        content: `[阶段小结] ${step.summary}`,
      },
    ];
  }
  if (step.role === "tool") {
    return [
      {
        role: "tool",
        content: step.content ?? "",
        tool_call_id: step.toolCallId ?? undefined,
      },
    ];
  }
  if (step.role === "assistant") {
    return [
      {
        role: "assistant",
        content: step.content ?? "",
        tool_calls: step.toolCallsJson ?? undefined,
      },
    ];
  }
  return [{ role: step.role, content: step.content ?? "" }];
}

/**
 * 按会话把 DB 行摊成「逐轮样本」。
 *
 * 输入（都是 `pg` 的原样行）：
 *   sessions  [{ id, kind }]
 *   steps     [{ sessionId, id, seq, role, content, toolCallsJson, toolCallId,
 *               summary, tokensIn, provider, model }]
 *   toolCalls [{ sessionId, stepId, toolCallId, toolName, status,
 *               resultJson, resultTruncated, errorMessage }]
 *
 * 返回 { samples, skippedSessions, sessionsTotal, roundsMeasured }：
 *   samples = [{ sessionId, kind, provider, model, seq, measured, estimate,
 *                offset, adjusted, ratio, roundsInSession }]
 */
export function buildRoundSamples(
  { sessions, steps, toolCalls },
  { replayMaxChars = REPLAY_MAX_CHARS_FALLBACK } = {},
) {
  const rowsBySession = new Map();
  for (const s of steps) {
    if (!s || s.tokensIn === null || s.tokensIn === undefined) continue;
    // 只重放测量用的那一轮：K 之前的 assistant 步 + 工具台账
    if (!rowsBySession.has(s.sessionId)) rowsBySession.set(s.sessionId, []);
    rowsBySession.get(s.sessionId).push(s);
  }
  const callsBySession = new Map();
  for (const c of toolCalls) {
    if (!callsBySession.has(c.sessionId)) callsBySession.set(c.sessionId, []);
    callsBySession.get(c.sessionId).push(c);
  }
  const kindBySession = new Map(sessions.map((s) => [s.id, s.kind]));

  const samples = [];
  let skippedSessions = 0;
  let roundsMeasured = 0;
  let sessionsTotal = 0;

  for (const [sessionId, sessionSteps] of rowsBySession) {
    sessionsTotal += 1;
    const ordered = [...sessionSteps].sort((a, b) => a.seq - b.seq);
    const measuredSteps = ordered.filter(
      (s) => s.role === "assistant" && s.tokensIn > 0,
    );
    roundsMeasured += measuredSteps.length;
    if (measuredSteps.length < 2) {
      // 单轮会话无法抵消 system/schema 常量（见头注），如实跳过而不是凑数。
      skippedSessions += 1;
      continue;
    }
    const sessionCalls = callsBySession.get(sessionId) ?? [];
    const perRound = [];
    for (const target of measuredSteps) {
      const promptSteps = ordered.filter((s) => s.seq < target.seq);
      const messages = [];
      const answered = new Set(
        promptSteps
          .filter((s) => s.role === "tool" && s.toolCallId)
          .map((s) => s.toolCallId),
      );
      const rowByCallId = new Map();
      for (const row of sessionCalls) {
        if (row.toolCallId) rowByCallId.set(row.toolCallId, row);
      }
      const consumed = new Set();
      for (const s of promptSteps) {
        messages.push(...stepToMessages(s));
        if (s.role !== "assistant" || s.summary) continue;
        const calls = Array.isArray(s.toolCallsJson) ? s.toolCallsJson : [];
        for (const call of calls) {
          if (!call?.id || answered.has(call.id)) continue;
          const direct = rowByCallId.get(call.id);
          let row = direct;
          if (!row) {
            row = sessionCalls.find(
              (r) =>
                r.stepId === s.id &&
                r.toolName === (call.function?.name ?? "") &&
                !consumed.has(r.id),
            );
          }
          if (row) consumed.add(row.id);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: renderReplayText(row, replayMaxChars),
          });
          answered.add(call.id);
        }
      }
      perRound.push({
        seq: target.seq,
        measured: target.tokensIn,
        estimate: estimateTokens(messages),
        provider: target.provider ?? "unknown",
        model: target.model ?? "unknown",
        kind: kindBySession.get(sessionId) ?? "unknown",
      });
    }

    // 首轮残差 = system prompt + 工具 schema + 重建误差（会话内常量）
    const first = perRound[0];
    if (!(first.estimate > 0) || !(first.measured > 0)) {
      skippedSessions += 1;
      continue;
    }
    const offset = first.measured - first.estimate;
    for (const round of perRound) {
      const adjusted = round.estimate + offset;
      if (!(adjusted > 0)) continue;
      samples.push({
        ...round,
        sessionId,
        offset,
        adjusted,
        ratio: round.measured / adjusted,
        roundsInSession: perRound.length,
      });
    }
  }

  return { samples, skippedSessions, sessionsTotal, roundsMeasured };
}

/** 总体 + 分组的一份可打印摘要。 */
export function summarizeAudit(samples, minSamples = MIN_SAMPLES) {
  const overall = summarize(samples.map((s) => s.ratio));
  const groups = groupRatios(samples, (s) => `${s.provider}/${s.model}`);
  const grouped = [...groups.entries()].map(([key, ratios]) => ({
    key,
    ...summarize(ratios),
  }));
  const verdict = decideVerdict(overall, minSamples);
  return {
    overall,
    grouped,
    ...verdict,
    advice: verdictAdvice(verdict.verdict),
  };
}

// ── DB 连接（只读）─────────────────────────────────────────────────────────

/** 解析连接目标：`--dsn` > `DATABASE_URL` > DB_*（缺省对齐 configuration.ts）。 */
export function resolveDbTarget(env = process.env, dsn = null) {
  const fromDsn = (raw) => {
    const u = new URL(raw);
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : 5432,
      user: decodeURIComponent(u.username || "postgres"),
      password: decodeURIComponent(u.password || ""),
      database:
        decodeURIComponent(u.pathname.replace(/^\//, "")) || "autocodeflow",
      source: "--dsn/DATABASE_URL",
    };
  };
  if (dsn) return fromDsn(dsn);
  if (env.DATABASE_URL) return fromDsn(env.DATABASE_URL);
  const port = Number.parseInt(env.DB_PORT ?? "5432", 10);
  return {
    host: env.DB_HOST || "localhost",
    port: Number.isFinite(port) && port > 0 ? port : 5432,
    user: env.DB_USERNAME || "postgres",
    password: env.DB_PASSWORD || "",
    database: env.DB_DATABASE || "autocodeflow",
    source: "DB_* 环境变量",
  };
}

/** 打印用 target（**口令恒不输出**）。 */
export function describeTarget(target) {
  return `postgres://${target.user}:***@${target.host}:${target.port}/${target.database}（来源：${target.source}）`;
}

const STEPS_QUERY = `
  SELECT st."sessionId", st.id, st.seq, st.role, st.content,
         st."toolCallsJson", st."toolCallId", st.summary,
         st."tokensIn", st.provider, st.model
    FROM agent_steps st
   WHERE st."sessionId" IN (
           SELECT DISTINCT "sessionId" FROM agent_steps WHERE "tokensIn" > 0
         )
   ORDER BY st."sessionId", st.seq`;

const SESSIONS_QUERY = `
  SELECT s.id, s.kind
    FROM agent_sessions s
   WHERE s.id IN (
           SELECT DISTINCT "sessionId" FROM agent_steps WHERE "tokensIn" > 0
         )`;

const TOOL_CALLS_QUERY = `
  SELECT c."sessionId", c."stepId", c."toolCallId", c."toolName", c.status,
         c."resultJson", c."resultTruncated", c."errorMessage"
    FROM agent_tool_calls c
   WHERE c."sessionId" IN (
           SELECT DISTINCT "sessionId" FROM agent_steps WHERE "tokensIn" > 0
         )`;

async function loadRows(target) {
  const require = createRequire(join(ROOT, "apps/admin-api/package.json"));
  let pg;
  try {
    pg = require("pg");
  } catch (err) {
    const e = new Error(
      `模块 pg 不可用（${err?.code ?? err?.message}）——先在本仓装依赖（pnpm install），` +
        `或用 --dsn 指到可直连的库后重试。`,
    );
    e.kind = "no-pg";
    throw e;
  }
  const client = new pg.Client({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    connectionTimeoutMillis: 4000,
  });
  try {
    await client.connect();
  } catch (err) {
    const e = new Error(
      `连接失败：${err?.code ?? ""} ${err?.message ?? err}`.trim(),
    );
    e.kind = "connect";
    throw e;
  }
  try {
    // 顺序执行：pg 的 Client 是单连接，并发 query 会被官方标记为 deprecated
    // （pg@9 移除）——只读审计没有并发需求。
    const steps = await client.query(STEPS_QUERY);
    const sessions = await client.query(SESSIONS_QUERY);
    const toolCalls = await client.query(TOOL_CALLS_QUERY);
    return {
      steps: steps.rows,
      sessions: sessions.rows,
      toolCalls: toolCalls.rows,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ── 输出 ───────────────────────────────────────────────────────────────────

function fmt(x) {
  return x === null || x === undefined ? "n/a" : Number(x).toFixed(3);
}

function printUsage(stream = console.error) {
  stream(`
用法（只读，绝不写库）：
  node scripts/agent-context-token-audit.mjs --report [--json] [--min-samples N]
  node scripts/agent-context-token-audit.mjs --report --dsn postgres://user:pwd@host:5432/db
  node scripts/agent-context-token-audit.mjs --selftest

连接参数优先级：--dsn > DATABASE_URL > DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE
（缺省与 apps/admin-api 的 configuration.ts 一致：localhost:5432 / postgres / autocodeflow）。

连不上库时的三种跑法：
  1) 本机直连：DB_HOST=<库地址> DB_PASSWORD=<口令> node scripts/agent-context-token-audit.mjs --report
  2) compose 网络内（DB_HOST 只在容器网络里能解析）：
     docker cp scripts/agent-context-token-audit.mjs <admin-api 容器>:/tmp/ \\
       && docker exec <admin-api 容器> node /tmp/agent-context-token-audit.mjs --report
  3) 容器 IP 直连：docker inspect <postgres 容器> --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \\
       → node scripts/agent-context-token-audit.mjs --report --dsn postgres://<u>:<p>@<IP>:5432/<db>`);
}

function report(meta, json) {
  const { samples, skippedSessions, sessionsTotal, roundsMeasured } = meta;
  const summary = summarizeAudit(samples, meta.minSamples);
  if (json) {
    console.log(
      JSON.stringify(
        {
          target: describeTarget(meta.target),
          counts: {
            sessionsTotal,
            roundsMeasured,
            samples: samples.length,
            skippedSessions,
          },
          overall: summary.overall,
          grouped: summary.grouped,
          verdict: summary.verdict,
          reason: summary.reason,
          advice: summary.advice,
          reconstruction: meta.reconstruction,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log("Agent 上下文估算审计（N5，只读）");
  console.log(`数据源：${describeTarget(meta.target)}`);
  console.log(
    `样本：${samples.length} 轮 / ${sessionsTotal} 个有实测的会话` +
      `（实测轮共 ${roundsMeasured}，跳过 ${skippedSessions} 个会话：不足 2 个实测轮，` +
      `或首轮估算为 0 无法定残差）`,
  );
  console.log(`重建口径：${meta.reconstruction}`);
  console.log(
    "比值 = measured / (estimate + 本会话首轮残差)；>1 表示估算偏低。",
  );
  console.log("");
  printStats("总体", summary.overall);
  console.log("");
  console.log("按 provider/model：");
  if (summary.grouped.length === 0) console.log("  （无样本）");
  for (const g of summary.grouped) printStats(`  ${g.key}`, g);
  console.log("");
  console.log(`结论：${summary.verdict}`);
  console.log(`理由：${summary.reason}`);
  console.log(`建议：${summary.advice}`);
}

function printStats(label, s) {
  console.log(
    `${label}：n=${s.n} p50=${fmt(s.p50)} p90=${fmt(s.p90)} p99=${fmt(s.p99)} ` +
      `min=${fmt(s.min)} max=${fmt(s.max)}`,
  );
}

// ── --selftest：夹具覆盖 比值/分位/分组/判据/重建 ───────────────────────────

function must(cond, message) {
  if (!cond) throw new Error(message);
}

function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

/** 造夹具：sessions/steps/toolCalls 都用 `pg` 的原样行形状（snake/camel 混合按真实列名）。 */
function fixture() {
  const sessions = [
    { id: "s1", kind: "ops_watch" },
    { id: "s2", kind: "chat" },
    { id: "s-single", kind: "chat" },
  ];
  // s1：3 个实测轮。prompt 内容递增：内容长度决定 estimate，measured 由夹具给定。
  const long = "字".repeat(400); // CJK：400 token
  const steps = [
    {
      sessionId: "s1",
      id: "a1",
      seq: 1,
      role: "user",
      content: long,
      toolCallsJson: null,
      toolCallId: null,
      summary: null,
      tokensIn: 0,
      provider: null,
      model: null,
    },
    {
      sessionId: "s1",
      id: "a2",
      seq: 2,
      role: "assistant",
      content: "",
      toolCallsJson: [
        { id: "c1", function: { name: "list_tasks", arguments: "{}" } },
      ],
      toolCallId: null,
      summary: null,
      tokensIn: 500,
      provider: "qwen",
      model: "qwen-vl-max",
    },
    {
      sessionId: "s1",
      id: "a3",
      seq: 3,
      role: "assistant",
      content: long,
      toolCallsJson: null,
      toolCallId: null,
      summary: null,
      tokensIn: 1100,
      provider: "qwen",
      model: "qwen-vl-max",
    },
    {
      sessionId: "s1",
      id: "a4",
      seq: 4,
      role: "assistant",
      content: long + long,
      toolCallsJson: null,
      toolCallId: null,
      summary: null,
      tokensIn: 1900,
      provider: "openai",
      model: "gpt-4o-mini",
    },
    // s2：2 个实测轮，第二轮残差固定后比值由复算决定（首轮恒为 1）
    {
      sessionId: "s2",
      id: "b1",
      seq: 1,
      role: "user",
      content: "abc",
      toolCallsJson: null,
      toolCallId: null,
      summary: null,
      tokensIn: 0,
      provider: null,
      model: null,
    },
    {
      sessionId: "s2",
      id: "b2",
      seq: 2,
      role: "assistant",
      content: "字".repeat(100),
      toolCallsJson: null,
      toolCallId: null,
      summary: null,
      tokensIn: 300,
      provider: "qwen",
      model: "qwen-vl-max",
    },
    {
      sessionId: "s2",
      id: "b3",
      seq: 3,
      role: "assistant",
      content: "字".repeat(300),
      toolCallsJson: null,
      toolCallId: null,
      summary: null,
      tokensIn: 1000,
      provider: "qwen",
      model: "qwen-vl-max",
    },
    // 只有一个实测轮 → 必须整会话跳过
    {
      sessionId: "s-single",
      id: "c1",
      seq: 1,
      role: "assistant",
      content: "x",
      toolCallsJson: null,
      toolCallId: null,
      summary: null,
      tokensIn: 42,
      provider: "qwen",
      model: "qwen-vl-max",
    },
  ];
  const toolCalls = [
    {
      sessionId: "s1",
      stepId: "a2",
      toolCallId: "c1",
      toolName: "list_tasks",
      status: "ok",
      resultJson: { items: [1, 2, 3] },
      resultTruncated: false,
      errorMessage: null,
    },
  ];
  return { sessions, steps, toolCalls };
}

export function runSelftest() {
  const cases = [
    {
      name: "percentile：最近秩（不插值），空集返回 null",
      fn: () => {
        must(percentile([], 50) === null, "空集应返回 null");
        must(percentile([1], 99) === 1, "单元素任何分位都是它本身");
        must(
          percentile([1, 2, 3, 4], 50) === 2,
          "p50(4 个) = 第 2 个（ceil(0.5*4)=2）",
        );
        must(
          percentile([1, 2, 3, 4], 90) === 4,
          "p90(4 个) = 第 4 个（ceil(0.9*4)=4）",
        );
        must(percentile([4, 3, 2, 1], 25) === 1, "乱序输入先排序");
      },
    },
    {
      name: "summarize：过滤非有限/非正比值，n/min/max 与分位一致",
      fn: () => {
        const s = summarize([
          2,
          1,
          3,
          Number.NaN,
          0,
          -1,
          Number.POSITIVE_INFINITY,
        ]);
        must(s.n === 3, `n 应为 3，实际 ${s.n}`);
        must(
          s.p50 === 2 && s.p90 === 3 && s.p99 === 3,
          "分位与排序后的 [1,2,3] 不符",
        );
        must(s.min === 1 && s.max === 3, "min/max 不符");
      },
    },
    {
      name: "groupRatios：按 provider/model 分组，键与比值一一对应",
      fn: () => {
        const samples = [
          { provider: "qwen", model: "m1", ratio: 1 },
          { provider: "qwen", model: "m1", ratio: 3 },
          { provider: "openai", model: "m2", ratio: 2 },
        ];
        const g = groupRatios(samples, (s) => `${s.provider}/${s.model}`);
        must(g.size === 2, "应有 2 组");
        must(
          JSON.stringify(g.get("qwen/m1")) === "[1,3]",
          "qwen/m1 组内容不符",
        );
        must(
          JSON.stringify(g.get("openai/m2")) === "[2]",
          "openai/m2 组内容不符",
        );
      },
    },
    {
      name: "decideVerdict：样本不足 → insufficient（不调系数/不降默认）",
      fn: () => {
        const v = decideVerdict(summarize([2, 2, 2]), 30);
        must(v.verdict === "insufficient", `实际 ${v.verdict}`);
        must(v.reason.includes("不动系数"), "理由必须写明不动系数/默认值");
      },
    },
    {
      name: "decideVerdict：p50 ≤ 1.25 → 保持默认 + 需要兜底",
      fn: () => {
        const ratios = Array.from(
          { length: 40 },
          (_, i) => 0.9 + (i % 5) * 0.05,
        );
        const v = decideVerdict(summarize(ratios), 30);
        must(
          v.verdict === "keep_defaults_and_need_fallback",
          `实际 ${v.verdict}`,
        );
      },
    },
    {
      name: "decideVerdict：系统偏低且尾部可控 → 调系数",
      fn: () => {
        const ratios = Array.from(
          { length: 40 },
          (_, i) => 1.5 + (i % 10) * 0.08,
        );
        const v = decideVerdict(summarize(ratios), 30);
        must(v.verdict === "tune_coefficient", `实际 ${v.verdict}`);
      },
    },
    {
      name: "decideVerdict：p50 偏高且尾部极重 → 降默认 maxTokens",
      fn: () => {
        const ratios = [
          ...Array.from({ length: 30 }, () => 1.5),
          ...Array.from({ length: 10 }, () => 9),
        ];
        const v = decideVerdict(summarize(ratios), 30);
        must(v.verdict === "lower_default_max_tokens", `实际 ${v.verdict}`);
      },
    },
    {
      name: "verdictAdvice：四种结论都给出非空且互不相同的建议",
      fn: () => {
        const all = [
          "tune_coefficient",
          "lower_default_max_tokens",
          "keep_defaults_and_need_fallback",
          "insufficient",
        ].map((v) => verdictAdvice(v));
        must(
          all.every((a) => typeof a === "string" && a.length > 0),
          "建议不得为空",
        );
        must(new Set(all).size === 4, "四种结论的建议必须互不相同");
      },
    },
    {
      name: "resolveDbTarget：--dsn 优先、URL 解码、缺省对齐 configuration.ts",
      fn: () => {
        const env = {
          DB_HOST: "h",
          DB_PORT: "5433",
          DB_USERNAME: "u",
          DB_PASSWORD: "p",
          DB_DATABASE: "d",
        };
        const t = resolveDbTarget(env);
        must(
          t.host === "h" &&
            t.port === 5433 &&
            t.user === "u" &&
            t.database === "d",
          "DB_* 解析不符",
        );
        const t2 = resolveDbTarget(
          env,
          "postgres://a%40b:p%3Aw@db.internal:6543/x",
        );
        must(
          t2.user === "a@b" && t2.password === "p:w" && t2.port === 6543,
          "DSN 解码不符",
        );
        const t3 = resolveDbTarget({}, null);
        must(
          t3.host === "localhost" &&
            t3.port === 5432 &&
            t3.database === "autocodeflow",
          "缺省值不符",
        );
      },
    },
    {
      name: "describeTarget：口令恒不出现",
      fn: () => {
        const text = describeTarget({
          host: "h",
          port: 5432,
          user: "u",
          password: "s3cr3t",
          database: "d",
          source: "test",
        });
        must(!text.includes("s3cr3t"), "口令泄漏进了描述串");
        must(text.includes("***"), "应显式以 *** 表示口令省略");
      },
    },
    {
      name: "readReplayMaxChars：能从运行时源码读到常量（漂移即失败）",
      fn: () => {
        const n = readReplayMaxChars(ROOT);
        must(
          n === REPLAY_MAX_CHARS_FALLBACK,
          `源码常量 ${n} ≠ 本脚本口径 ${REPLAY_MAX_CHARS_FALLBACK}`,
        );
      },
    },
    {
      name: "renderReplayText：ok 分支走真实裁剪函数；缺失行给出「结果缺失」文案",
      fn: () => {
        must(
          renderReplayText(undefined).includes("工具结果缺失"),
          "缺失行文案不符",
        );
        const ok = renderReplayText({
          status: "ok",
          resultJson: { a: 1 },
          resultTruncated: false,
          errorMessage: null,
        });
        must(ok.startsWith("【工具结果（重放）】"), `ok 分支前缀不符：${ok}`);
        const long = renderReplayText(
          {
            status: "ok",
            resultJson: { s: "x".repeat(5000) },
            resultTruncated: false,
            errorMessage: null,
          },
          2000,
        );
        must(long.includes("中间省略"), "超长结果应被首尾裁剪并带省略标记");
        must(
          renderReplayText({
            status: "denied",
            errorMessage: "skipped: approval",
          }).includes("未执行"),
          "denied/skipped 文案不符",
        );
      },
    },
    {
      name: "buildRoundSamples：逐轮重建 + 首轮残差 + 单轮会话跳过 + 分组输入正确",
      fn: () => {
        const f = fixture();
        const out = buildRoundSamples(f, {
          replayMaxChars: REPLAY_MAX_CHARS_FALLBACK,
        });
        must(
          out.sessionsTotal === 3,
          `sessionsTotal 应为 3，实际 ${out.sessionsTotal}`,
        );
        must(
          out.roundsMeasured === 6,
          `实测轮应为 6，实际 ${out.roundsMeasured}`,
        );
        must(
          out.skippedSessions === 1,
          `应跳过 1 个单轮会话，实际 ${out.skippedSessions}`,
        );
        must(
          out.samples.length === 5,
          `样本应为 5（s1 3 轮 + s2 2 轮），实际 ${out.samples.length}`,
        );
        // 首轮残差：adjusted(第1轮) 必须等于 measured(第1轮) → ratio 恒为 1
        const s1r1 = out.samples.find(
          (s) => s.sessionId === "s1" && s.seq === 2,
        );
        must(approx(s1r1.ratio, 1), `首轮 ratio 应为 1，实际 ${s1r1.ratio}`);
        // 固定残差后，后续轮的 ratio = measured/(estimate+offset)，可由夹具复算
        const s1r3 = out.samples.find(
          (s) => s.sessionId === "s1" && s.seq === 4,
        );
        must(
          approx(s1r3.adjusted, s1r3.estimate + s1r1.offset),
          "非首轮必须使用同一会话的首轮残差",
        );
        must(
          s1r3.provider === "openai" && s1r3.model === "gpt-4o-mini",
          "逐轮 provider/model 应取自该轮",
        );
        must(
          out.samples.every((s) => s.ratio > 0),
          "所有比值应为正有限值",
        );
      },
    },
    {
      name: "summarizeAudit：夹具下给出总体/分组/结论三件套",
      fn: () => {
        const f = fixture();
        const meta = buildRoundSamples(f, {
          replayMaxChars: REPLAY_MAX_CHARS_FALLBACK,
        });
        const audit = summarizeAudit(meta.samples, MIN_SAMPLES);
        must(
          audit.overall.n === 5,
          `overall.n 应为 5，实际 ${audit.overall.n}`,
        );
        must(
          audit.grouped.length >= 2,
          "至少 qwen/qwen-vl-max 与 openai/gpt-4o-mini 两组",
        );
        must(
          audit.verdict === "insufficient",
          "夹具样本 < 30 → 结论必须是样本不足",
        );
        must(
          typeof audit.advice === "string" && audit.advice.length > 0,
          "建议不得为空",
        );
      },
    },
    {
      name: "buildRoundSamples：tokensIn 全 0 → 零样本（区分「没数据」与「连不上」）",
      fn: () => {
        const out = buildRoundSamples({
          sessions: [{ id: "s", kind: "chat" }],
          steps: [
            {
              sessionId: "s",
              id: "a",
              seq: 1,
              role: "assistant",
              content: "x",
              toolCallsJson: null,
              toolCallId: null,
              summary: null,
              tokensIn: 0,
              provider: "qwen",
              model: "m",
            },
          ],
          toolCalls: [],
        });
        must(
          out.samples.length === 0 && out.roundsMeasured === 0,
          "全 0 必须是零样本",
        );
      },
    },
  ];

  let failed = 0;
  for (const c of cases) {
    try {
      c.fn();
      console.log(`  ✓ ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${c.name}\n      ${err.message}`);
    }
  }
  console.log("");
  console.log(
    `agent-context-token-audit selftest：${cases.length - failed}/${cases.length} 通过` +
      (failed > 0 ? `（${failed} 条失败）` : ""),
  );
  return failed > 0 ? 1 : 0;
}

// ── 入口 ───────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const opts = {
    mode: "report",
    json: false,
    dsn: null,
    minSamples: MIN_SAMPLES,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--selftest") opts.mode = "selftest";
    else if (a === "--report") opts.mode = "report";
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--dsn") opts.dsn = argv[++i] ?? null;
    else if (a.startsWith("--dsn=")) opts.dsn = a.slice("--dsn=".length);
    else if (a === "--min-samples")
      opts.minSamples = Number.parseInt(argv[++i] ?? "", 10);
    else if (a.startsWith("--min-samples="))
      opts.minSamples = Number.parseInt(a.slice("--min-samples=".length), 10);
    else {
      throw new Error(`未知参数：${a}`);
    }
  }
  if (!Number.isFinite(opts.minSamples) || opts.minSamples <= 0) {
    opts.minSamples = MIN_SAMPLES;
  }
  return opts;
}

async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    printUsage();
    return 2;
  }
  if (opts.help) {
    printUsage(console.log);
    return 0;
  }
  if (opts.mode === "selftest") {
    await loadRuntimeEstimator();
    return runSelftest();
  }

  try {
    await loadRuntimeEstimator();
  } catch (err) {
    console.error(
      `✗ 无法从源码加载真实估算函数（Node ≥ 24 的类型擦除）：${err.message}\n` +
        `  本脚本刻意不自己复刻系数（复刻必然与源码漂移），因此加载失败时如实退出。`,
    );
    return 2;
  }

  const target = resolveDbTarget(process.env, opts.dsn);
  const replayMaxChars = readReplayMaxChars(ROOT) ?? REPLAY_MAX_CHARS_FALLBACK;
  let rows;
  try {
    rows = await loadRows(target);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    console.error(`  目标：${describeTarget(target)}`);
    if (!target.password) {
      console.error(
        "  提示：口令为空时 PostgreSQL 会回 SASL/SCRAM 报错——合理的形态是「口令没配」，" +
          "请设 DB_PASSWORD（或 --dsn）后重试。",
      );
    }
    console.error("");
    printUsage();
    return 3;
  }

  const meta = buildRoundSamples(rows, { replayMaxChars });
  if (meta.roundsMeasured === 0) {
    console.error(
      `✗ 数据库连上了，但 \`agent_steps\` 里没有一行 \`tokensIn > 0\`——没有可校准的实测样本。`,
    );
    console.error(`  目标：${describeTarget(target)}`);
    console.error(
      "  这不是「脚本坏了」也不是「估算准确」：请先让会话真的打到 provider 并落库 usage，再重跑。",
    );
    console.error(
      "  预期输出形态：样本计数 → 总体 p50/p90/p99 → 按 provider/model 分组 → 结论四选一。",
    );
    return 4;
  }

  report(
    {
      target,
      ...meta,
      minSamples: opts.minSamples,
      reconstruction:
        `依据 \`${ESTIMATOR_SOURCE}\` 的真实估算函数 + \`${RUNTIME_SOURCE}\` 的 ` +
        `stepToMessages/重放规则（replayMaxChars=${replayMaxChars}）；system prompt 与工具 schema ` +
        `不逐轮重建，改由每会话首轮残差抵消。`,
    },
    opts.json,
  );
  return 0;
}

// 仅在被直接执行时跑 main（被 import 时只导出纯函数，便于别处复用与测试）
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`✗ 未预期异常：${err?.stack ?? err}`);
      process.exit(2);
    },
  );
}
