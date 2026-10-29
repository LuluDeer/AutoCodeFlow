/**
 * 推理质量轮（2026-10-28）：**provider / model 注册表**（LLM 接入面）。
 *
 * ## 为什么要这张表，而不是继续按厂商写分支
 * 现状是「一个全局 `ai.provider` + 每个厂商一套代码分支与配置键」：`qwen` 有
 * `qwenApiKey/qwenBaseUrl/qwenModel/qwenMaxTokens/qwenTimeoutMs` 五件套，且
 * `chatMultimodal` **只认 qwen**——接入第二家 OpenAI 兼容端点（vLLM / DeepSeek /
 * 自建网关）就没有位置放，Agent 也跟着锁死在一家厂商上。
 *
 * 正确抽象：**provider = 一个 OpenAI 兼容端点定义**（名称 + baseUrl + key + model
 * + 参数 + 能力），厂商名只是 `id`。于是：
 *   · 接新模型 = 往表里加一条（不改代码、不加分支）；
 *   · 能力（是否支持视频、是否支持 tool-calling）是**条目字段**，由接入的人勾选，
 *     而不是代码里 `provider === 'qwen'` 这种硬判断；
 *   · 按用途选模型（分析 / Agent / 视频理解）就是「按用途指向某个 id」。
 *
 * ## 存储形态（为什么密钥不在这张表里）
 * `ai.providers` 是一条 JSON（DB system_config，可读面会回显给设置页）：
 * ```json
 * [{ "id":"qwen-vl","label":"通义千问 VL","baseUrl":"https://…","model":"qwen-vl-max",
 *    "maxTokens":8192,"timeoutMs":120000,"supportsVideo":true,"enabled":true }]
 * ```
 * **密钥单独存** `ai.providers.<id>.apiKey`（`isSecret: true`，读面掩码为 `***`，
 * 提交 `***` 表示"不修改"）。理由：把 key 塞进 JSON 会让整条记录变成一条
 * 无法掩码的混合体——`system_configs` 的 `isSecret` 是**逐键**语义，塞进去就
 * 等于把密钥降级成明文可读配置。
 *
 * ## 存量兼容
 * `ai.providers` 未配置时，用旧键合成三条内置条目（openai / qwen / ollama），
 * 存量部署零行为变化；一旦写入 `ai.providers`，以新表为准。旧键仍作为该 id 的
 * **回落**（见 `legacyDefaults`），所以升级不需要改 .env。
 */

/** 用途：分析（失败日志/健康/排程）、Agent 推理、视频理解（转 SOP）。 */
export const AI_PURPOSES = ["analysis", "agent", "video"] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

/** 出站协议面：OpenAI 兼容 /chat/completions，或 ollama 的 /api/generate。 */
export type AiTransport = "openai" | "ollama";

/** 注册表条目（不含密钥）。 */
export interface AiProviderEntry {
  /** 引用名（`ai.provider` / `ai.routes.*.provider` 指向它）。小写字母数字与 `-_.` */
  id: string;
  label: string;
  transport: AiTransport;
  baseUrl: string;
  /** 该条目的默认模型名。 */
  model: string;
  maxTokens: number;
  timeoutMs: number;
  /** 是否接受 `video_url` 片段（勾选后才允许被"视频理解"用途选中）。 */
  supportsVideo: boolean;
  enabled: boolean;
}

/** 对外视图（设置页/路由预览用）：不含密钥，只给"有没有配"。 */
export interface AiProviderView extends AiProviderEntry {
  hasApiKey: boolean;
  /** true = 由旧配置键合成（尚未写入 `ai.providers`）。 */
  legacy: boolean;
}

/** 内置 id 的缺省值（旧键语义的等价物）。 */
export const LEGACY_DEFAULTS: Record<
  "openai" | "qwen" | "ollama",
  Omit<AiProviderEntry, "id">
> = {
  openai: {
    label: "OpenAI 兼容端点",
    transport: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    maxTokens: 500,
    timeoutMs: 30_000,
    supportsVideo: false,
    enabled: true,
  },
  qwen: {
    label: "通义千问（DashScope 兼容端点）",
    transport: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-vl-max",
    maxTokens: 4_096,
    timeoutMs: 120_000,
    // DashScope 扩展支持 video_url——这是**能力勾选**，不是厂商分支
    supportsVideo: true,
    enabled: true,
  },
  ollama: {
    label: "本地 Ollama",
    transport: "ollama",
    baseUrl: "http://localhost:11434",
    model: "llama3",
    maxTokens: 512,
    timeoutMs: 60_000,
    supportsVideo: false,
    enabled: true,
  },
};

/** 新条目的缺省值（非内置 id）。 */
export const CUSTOM_PROVIDER_DEFAULTS: Omit<AiProviderEntry, "id"> = {
  label: "",
  transport: "openai",
  baseUrl: "",
  model: "",
  maxTokens: 4_096,
  timeoutMs: 60_000,
  supportsVideo: false,
  enabled: true,
};

/** id 形态闸：允许字母数字与 `-_.`，1..64 —— 会进配置键名，必须封死怪异字符。 */
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function positiveInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 单条目的一化（脏值回落 + 形态校验）。 */
export function normalizeProviderEntry(
  raw: unknown,
  fallbackId = "",
):
  | { status: "ok"; entry: AiProviderEntry }
  | { status: "error"; message: string } {
  if (!isPlainObject(raw))
    return { status: "error", message: "provider 条目必须是对象" };
  const id = (str(raw.id) || fallbackId).toLowerCase();
  if (!ID_RE.test(id)) {
    return {
      status: "error",
      message: `provider id 非法：${id || "(空)"}（允许 a-z0-9._-）`,
    };
  }

  const base = LEGACY_DEFAULTS[id as keyof typeof LEGACY_DEFAULTS]
    ? LEGACY_DEFAULTS[id as keyof typeof LEGACY_DEFAULTS]
    : CUSTOM_PROVIDER_DEFAULTS;

  const transport =
    str(raw.transport).toLowerCase() === "ollama" ? "ollama" : "openai";
  // baseUrl 的协议校验推迟到路由解析（这里允许留空 = 用缺省；
  // 半成品条目不该在"保存"时就被拒——接入的人常常先建条目再填地址）
  const baseUrl = str(raw.baseUrl) || base.baseUrl;

  return {
    status: "ok",
    entry: {
      id,
      label: str(raw.label) || base.label || id,
      transport,
      baseUrl,
      model: str(raw.model) || base.model,
      maxTokens: positiveInt(raw.maxTokens, base.maxTokens),
      timeoutMs: positiveInt(raw.timeoutMs, base.timeoutMs),
      // 未写 = 用该 id 的内置缺省（qwen 缺省支持视频，保持存量语义）；
      // 显式 false 才是"这个模型不支持视频"——能力位不能被静默吞掉
      supportsVideo:
        raw.supportsVideo === undefined
          ? base.supportsVideo
          : raw.supportsVideo === true,
      enabled: raw.enabled !== false,
    },
  };
}

/**
 * 解析 `ai.providers` JSON。
 *
 * 容错姿态：单条非法只丢该条并记入 `errors`（设置页可提示），**不整表失效**
 * ——一条写坏的条目不该让全部 AI 能力下线。
 */
export function parseProvidersJson(raw: string | null | undefined): {
  entries: AiProviderEntry[];
  errors: string[];
  configured: boolean;
} {
  const text = (raw ?? "").trim();
  if (!text) return { entries: [], errors: [], configured: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      entries: [],
      errors: ["ai.providers 不是合法 JSON——已回落到旧配置键合成"],
      configured: false,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      entries: [],
      errors: ["ai.providers 必须是数组——已回落到旧配置键合成"],
      configured: false,
    };
  }

  const entries: AiProviderEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  parsed.forEach((item, index) => {
    const res = normalizeProviderEntry(item);
    if (res.status === "error") {
      errors.push(`第 ${index + 1} 条：${res.message}`);
      return;
    }
    if (seen.has(res.entry.id)) {
      errors.push(`第 ${index + 1} 条：id 重复（${res.entry.id}），已忽略`);
      return;
    }
    seen.add(res.entry.id);
    entries.push(res.entry);
  });
  return { entries, errors, configured: true };
}

/** 旧键合成（`ai.openai*` / `ai.qwen*` / `ai.ollama*` → 三条内置条目）。 */
export function legacyProviders(input: {
  openai?: Partial<Omit<AiProviderEntry, "id">>;
  qwen?: Partial<Omit<AiProviderEntry, "id">>;
  ollama?: Partial<Omit<AiProviderEntry, "id">>;
}): AiProviderEntry[] {
  const ids = ["openai", "qwen", "ollama"] as const;
  return ids.map((id) => {
    const base = LEGACY_DEFAULTS[id];
    const over = input[id] ?? {};
    return {
      id,
      label: over.label ?? base.label,
      transport: over.transport ?? base.transport,
      baseUrl: over.baseUrl ?? base.baseUrl,
      model: over.model ?? base.model,
      maxTokens: positiveInt(over.maxTokens, base.maxTokens),
      timeoutMs: positiveInt(over.timeoutMs, base.timeoutMs),
      supportsVideo: over.supportsVideo ?? base.supportsVideo,
      enabled: over.enabled ?? true,
    };
  });
}

/** 新增/覆盖一条（同 id 覆盖）。 */
export function upsertProviderEntry(
  entries: readonly AiProviderEntry[],
  entry: AiProviderEntry,
): AiProviderEntry[] {
  const rest = entries.filter((e) => e.id !== entry.id);
  return [...rest, entry].sort((a, b) => a.id.localeCompare(b.id));
}

/** 删除一条；内置 id 允许删除（删掉即"不再提供"，回落由旧键决定）。 */
export function removeProviderEntry(
  entries: readonly AiProviderEntry[],
  id: string,
): AiProviderEntry[] {
  return entries.filter((e) => e.id !== id);
}

/** 序列化回存储形态（**不含密钥**；稳定排序便于 diff 与审计）。 */
export function serializeProviders(
  entries: readonly AiProviderEntry[],
): string {
  return JSON.stringify(
    [...entries]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => ({
        id: e.id,
        label: e.label,
        transport: e.transport,
        baseUrl: e.baseUrl,
        model: e.model,
        maxTokens: e.maxTokens,
        timeoutMs: e.timeoutMs,
        supportsVideo: e.supportsVideo,
        enabled: e.enabled,
      })),
  );
}

/** 对外视图（掩码密钥存在性）。 */
export function toProviderViews(
  entries: readonly AiProviderEntry[],
  keys: Readonly<Record<string, string | undefined>>,
  opts: { legacy: boolean },
): AiProviderView[] {
  return entries.map((e) => ({
    ...e,
    hasApiKey: !!keys[e.id]?.trim(),
    legacy: opts.legacy,
  }));
}

/** 可按用途选用的条目（启用 + 该用途要求的能力）。 */
export function selectableProviders(
  entries: readonly AiProviderEntry[],
  purpose: AiPurpose,
): AiProviderEntry[] {
  return entries.filter((e) => {
    if (!e.enabled) return false;
    if (purpose === "video") return e.supportsVideo;
    // analysis / agent 都要求能出文本；agent 另外要 tool-calling 面
    // （transport=ollama 只有 /api/generate，没有 tools）
    if (purpose === "agent") return e.transport === "openai";
    return true;
  });
}
