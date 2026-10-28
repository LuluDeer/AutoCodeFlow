import { client, getApiBaseUrl } from './client';
import { useAuthStore } from '../store/auth';

export interface AiConfig {
  provider: 'disabled' | 'openai' | 'ollama' | 'qwen';
  openaiModel: string;
  openaiBaseUrl: string;
  ollamaHost: string;
  ollamaModel: string;
  // P1: Qwen / DashScope 多模态生效配置（密钥除外，只有 hasApiKey 布尔）
  qwenModel?: string;
  qwenBaseUrl?: string;
  qwenMaxTokens?: string;
  qwenTimeoutMs?: string;
  hasApiKey: boolean;
}

export interface SaveAiConfigPayload {
  provider: 'disabled' | 'openai' | 'ollama' | 'qwen';
  openaiApiKey?: string;
  openaiModel?: string;
  openaiBaseUrl?: string;
  ollamaHost?: string;
  ollamaModel?: string;
  // P1: Qwen 多模态
  qwenApiKey?: string;
  qwenModel?: string;
  qwenBaseUrl?: string;
  qwenMaxTokens?: string;
  qwenTimeoutMs?: string;
}

/**
 * 与后端 application.service.analyzeHealth 返回结构对齐：
 * { appId, appName, analysis, stats: { totalTasks, avgSuccessRate, avgDuration, criticalTasks } }
 */
export interface AppHealthReport {
  appId: string;
  appName: string;
  analysis: string;
  stats: {
    totalTasks: number;
    /** 百分制（0-100），来自任务 stats.successRate */
    avgSuccessRate: number;
    /** 毫秒 */
    avgDuration: number;
    /** 成功率低于 50% 且运行超过 3 次的任务名 */
    criticalTasks: string[];
  };
}

export interface ScheduleSuggestion {
  taskId: string;
  currentCron: string | null;
  suggestedCron: string;
  reasoning: string;
  successRate: number;
  p95Duration: number;
}

// ── 模型接入与分配（推理质量轮）──────────────────────────────────
export type AiPurpose = 'analysis' | 'agent' | 'video';

export interface AiProviderView {
  id: string;
  label: string;
  transport: 'openai' | 'ollama';
  baseUrl: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  /** 能力位：勾选后才能被"视频理解"用途选中。 */
  supportsVideo: boolean;
  enabled: boolean;
  hasApiKey: boolean;
  /** true = 由旧配置键合成（尚未写入注册表）。 */
  legacy: boolean;
}

export interface AiProviderAdminView {
  providers: AiProviderView[];
  errors: string[];
  routes: Record<AiPurpose, { provider: string; model: string; maxTokens: string; timeoutMs: string }>;
}

export interface SaveAiProviderPayload {
  id: string;
  label?: string;
  transport?: 'openai' | 'ollama';
  baseUrl: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
  supportsVideo?: boolean;
  enabled?: boolean;
  /** 不传或 `***` = 保持原值；空串 = 清除。 */
  apiKey?: string;
}

export interface UploadedAiMedia {
  id: string;
  name: string;
  mime: string | null;
  sizeBytes: number;
}

export interface SopSessionMessage {
  role: 'user' | 'assistant';
  text: string;
  mediaIds?: string[];
  action?: 'ask' | 'draft';
  at: string;
}

export interface SopSessionDraft {
  title: string;
  slug: string;
  frontMatterYaml: string;
  bodyMarkdown: string;
  assumptions: string[];
  provider: string;
  model: string;
}

export interface SopSession {
  id: string;
  status: 'active' | 'drafted' | 'saved';
  messages: SopSessionMessage[];
  media: Array<{ mediaId: string; name: string }>;
  draft: SopSessionDraft | null;
  provider: string | null;
  questionsAsked: number;
  remainingQuestions: number;
  /** 本轮模型是否在要"补录一段"（仅追问轮返回）。 */
  needsVideo?: boolean;
  /**
   * 最近一轮的用量（仅创建/追加轮的响应里带）。`cachedTokens` 是上游报告的
   * **命中缓存**的输入 token——用来验证"复用直链 + append-only 前缀"到底有没有
   * 让 provider 命中缓存（0 不代表不支持，也可能只是没命中）。
   */
  lastTurnUsage?: { tokensIn: number; tokensOut: number; cachedTokens?: number };
}

export interface SopDraftFromVideo {
  title: string;
  slug: string;
  frontMatterYaml: string;
  bodyMarkdown: string;
  provider: string;
  model: string;
  warnings: string[];
}

export const aiApi = {
  getConfig: (signal?: AbortSignal) =>
    signal
      ? client.get<AiConfig>('/ai/config', { signal })
      : client.get<AiConfig>('/ai/config'),
  saveConfig: (data: SaveAiConfigPayload) => client.post<{ ok: boolean }>('/ai/config', data),
  testConfig: () => client.post<{ ok: boolean; message: string }>('/ai/test'),
  analyzeApp: (appId: string) => client.post<AppHealthReport>(`/applications/${appId}/analyze`),
  suggestSchedule: (taskId: string) => client.post<ScheduleSuggestion>(`/tasks/${taskId}/suggest-schedule`),

  // 模型接入与分配
  listProviders: (signal?: AbortSignal) =>
    signal
      ? client.get<AiProviderAdminView>('/ai/providers', { signal })
      : client.get<AiProviderAdminView>('/ai/providers'),
  saveProvider: (data: SaveAiProviderPayload) =>
    client.put<AiProviderAdminView>('/ai/providers', data),
  deleteProvider: (id: string) => client.delete<AiProviderAdminView>(`/ai/providers/${id}`),
  assignRoute: (purpose: AiPurpose, providerId: string, model = '') =>
    client.put<AiProviderAdminView>('/ai/routes', { purpose, providerId, model }),

  // 视频转 SOP
  uploadVideo: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return client.post<UploadedAiMedia>('/ai/media', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      // 视频上传比普通请求慢得多（100MB 量级），单独放宽到 10 分钟
      timeout: 600_000,
    });
  },
  generateSopDraft: (data: { mediaId: string; providerId?: string; hint?: string }) =>
    client.post<SopDraftFromVideo>('/ai/sop-draft/from-video', data, { timeout: 180_000 }),

  // 视频转 SOP（交互式会话）
  listSopSessions: (params?: { page?: number; pageSize?: number }) =>
    client.get<{
      items: Array<{
        id: string;
        status: string;
        createdAt: string;
        updatedAt: string;
        mediaCount: number;
        title: string | null;
      }>;
      total: number;
    }>('/ai/sop-sessions', { params }),
  createSopSession: (data: { mediaId: string; providerId?: string; hint?: string }) =>
    client.post<SopSession>('/ai/sop-sessions', data, { timeout: 180_000 }),
  getSopSession: (id: string, signal?: AbortSignal) =>
    signal
      ? client.get<SopSession>(`/ai/sop-sessions/${id}`, { signal })
      : client.get<SopSession>(`/ai/sop-sessions/${id}`),
  sopSessionTurn: (id: string, data: { text?: string; mediaId?: string }) =>
    client.post<SopSession>(`/ai/sop-sessions/${id}/turns`, data, { timeout: 180_000 }),
  markSopSessionSaved: (id: string) =>
    client.post<SopSession>(`/ai/sop-sessions/${id}/saved`),

  /**
   * 流式追加一轮（SSE）。看视频出稿可能要 30s+，逐字出比"转圈"好得多。
   *
   * 为什么用 `fetch` 而不是 axios/EventSource：
   *  · 这一轮要 POST body（用户的补充），而 `EventSource` 只能 GET；
   *  · axios 的 XHR/适配层拿不到增量（浏览器端没有 stream 响应体）。
   * 认证沿用同一份 Bearer token（`useAuthStore` 是 axios 拦截器读的同一个源），
   * 不新开鉴权通道。
   *
   * 帧协议与服务端一致：`delta`（增量文本）→ `done`（整条会话）或 `error`。
   */
  sopSessionTurnStream: async (
    id: string,
    data: { text?: string; mediaId?: string },
    handlers: { onDelta: (text: string) => void; signal?: AbortSignal },
  ): Promise<SopSession> => {
    const token = useAuthStore.getState().token;
    const res = await fetch(
      `${getApiBaseUrl()}/ai/sop-sessions/${id}/turns/stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(data),
        ...(handlers.signal ? { signal: handlers.signal } : {}),
      },
    );
    if (!res.ok || !res.body) {
      throw new Error(`stream failed (status=${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done: SopSession | null = null;

    const handleBlock = (block: string) => {
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
          continue;
        }
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      if (dataLines.length === 0) return;
      const payload = JSON.parse(dataLines.join('\n')) as unknown;
      if (event === 'delta') {
        const text = (payload as { text?: unknown }).text;
        if (typeof text === 'string' && text.length > 0) handlers.onDelta(text);
        return;
      }
      if (event === 'error') {
        const rec = payload as { code?: string; message?: string };
        throw new Error(rec.message ?? rec.code ?? 'stream error');
      }
      if (event === 'done') {
        done = payload as SopSession;
      }
    };

    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const block of parts) handleBlock(block);
    }
    if (buffer.trim()) handleBlock(buffer);

    if (!done) throw new Error('stream ended without done frame');
    return done;
  },
};
