/**
 * AI 调度建议子域（原 `TaskDetailPage` 内联实现，R6「TaskDetailPage 四子域
 * hook」切法 (a) 的第二刀，纯搬移 / 零行为变更）。
 *
 * 承载「点一下 AI 建议按钮 → 弹窗 → 拉一次 suggestSchedule」这一整段：
 * `aiModalOpen`（弹窗开关）、`aiSuggestion`（结果，null = 未拿到）、
 * `aiLoading`（在途），以及唯一 handler `handleAiSuggest`。
 *
 * 时序原样保留（三条互不可换）：
 *   ① 先在途标记 + 开弹窗（用户立刻看到 loading 骨架，而不是等请求返回才开）；
 *   ② 失败时**关弹窗**并弹 toast（错误信息不全屏阻塞页面）；
 *   ③ `finally` 清在途标记——成功时弹窗留在原地展示结果。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { aiApi } from '../../api/ai';
import type { ScheduleSuggestion } from '../../api/ai';
import { showApiError } from '../../utils/error';
import '../../i18n';

export interface TaskAiSuggestion {
  aiModalOpen: boolean;
  setAiModalOpen: (open: boolean) => void;
  aiSuggestion: ScheduleSuggestion | null;
  aiLoading: boolean;
  handleAiSuggest: () => Promise<void>;
}

export function useTaskAiSuggestion(id: string | undefined): TaskAiSuggestion {
  const { t } = useTranslation();
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<ScheduleSuggestion | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const handleAiSuggest = async () => {
    if (!id) return;
    setAiLoading(true);
    setAiModalOpen(true);
    try {
      const result = await aiApi.suggestSchedule(id);
      setAiSuggestion(result);
    } catch (err: unknown) {
      showApiError(err, t('taskDetail.aiAnalyzeFail'));
      setAiModalOpen(false);
    } finally {
      setAiLoading(false);
    }
  };

  return { aiModalOpen, setAiModalOpen, aiSuggestion, aiLoading, handleAiSuggest };
}
