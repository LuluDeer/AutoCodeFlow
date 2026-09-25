import { client } from './client';

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

export const aiApi = {
  getConfig: (signal?: AbortSignal) =>
    signal
      ? client.get<AiConfig>('/ai/config', { signal })
      : client.get<AiConfig>('/ai/config'),
  saveConfig: (data: SaveAiConfigPayload) => client.post<{ ok: boolean }>('/ai/config', data),
  testConfig: () => client.post<{ ok: boolean; message: string }>('/ai/test'),
  analyzeApp: (appId: string) => client.post<AppHealthReport>(`/applications/${appId}/analyze`),
  suggestSchedule: (taskId: string) => client.post<ScheduleSuggestion>(`/tasks/${taskId}/suggest-schedule`),
};
