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

export interface AppHealthReport {
  taskCount: number;
  successRate: number;
  avgDuration: number;
  failedTasks: Array<{ id: string; name: string; failureRate: number }>;
  aiAnalysis: string;
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
