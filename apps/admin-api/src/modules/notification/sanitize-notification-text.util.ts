/**
 * A-5: 出站通知正文脱敏（与 ai/ai.service.ts sanitizeLogs 同源正则）。
 *
 * 执行失败告警的 errorSummary 直接取 errorMessage/logs 原文（截 500 字符）进
 * IM/邮件——任务日志里的 env 赋值、Bearer token、长 hex/base64 密钥会原样
 * 外发到第三方渠道。AI 侧早有同款脱敏（S-10），但只护 AI 出站；本工具把同一
 * 组正则复用到通知出站面（NotificationService.sendToChannels 的渠道发送前
 * 单一收口点）。
 *
 * 与 sanitizeLogs 的差异：**不做 3000 字符截断**——通知正文长度由上游自控
 * （listener 已截 500），截断会吞掉非敏感的排障信息；只做模式掩码，普通
 * 错误文本逐字保留（可读性不变）。
 */
export function sanitizeNotificationText(input: string): string {
  if (!input) return input;
  return (
    input
      // env var assignments: KEY=value
      .replace(/([A-Z_]{3,}\s*=\s*)[^\s\n]+/g, "$1[REDACTED]")
      // Bearer / token headers
      .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "$1[REDACTED]")
      // long hex strings (>=32 chars — likely keys/tokens)
      .replace(/[0-9a-fA-F]{32,}/g, "[REDACTED_HEX]")
      // long base64-like strings (>=40 chars)
      .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[REDACTED_B64]")
  );
}
