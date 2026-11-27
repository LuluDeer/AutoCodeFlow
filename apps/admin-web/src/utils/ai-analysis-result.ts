/**
 * UX-AUDIT：后端 analyze 永不抛错，空串结果照常 200——只有真有报告才算成功。
 * 外提为独立工具模块以免抬高 ExecutionDetailPage 的分支密度基线。
 */
export function hasAiAnalysis(analysis: { aiAnalysis?: string } | null | undefined): boolean {
  if (!analysis || typeof analysis.aiAnalysis !== 'string') return false;
  return analysis.aiAnalysis.trim().length > 0;
}
