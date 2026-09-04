import { client } from './client';

export interface AiConfig {
  provider: 'disabled' | 'openai' | 'ollama';
  openaiModel: string;
  openaiBaseUrl: string;
  ollamaHost: string;
  ollamaModel: string;
  hasApiKey: boolean;
}

export interface SaveAiConfigPayload {
  provider: 'disabled' | 'openai' | 'ollama';
  openaiApiKey?: string;
  openaiModel?: string;
  openaiBaseUrl?: string;
  ollamaHost?: string;
  ollamaModel?: string;
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
  getConfig: () => client.get<AiConfig>('/ai/config'),
  saveConfig: (data: SaveAiConfigPayload) => client.post<{ ok: boolean }>('/ai/config', data),
  testConfig: () => client.post<{ ok: boolean; message: string }>('/ai/test'),
  analyzeApp: (appId: string) => client.post<AppHealthReport>(`/applications/${appId}/analyze`),
  suggestSchedule: (taskId: string) => client.post<ScheduleSuggestion>(`/tasks/${taskId}/suggest-schedule`),
};
