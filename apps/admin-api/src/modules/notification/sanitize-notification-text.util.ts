/**
 * A-5: 出站通知正文脱敏（通知面的**薄封装**，规则本体不在这里）。
 *
 * 执行失败告警的 errorSummary 直接取 errorMessage/logs 原文（截 500 字符）进
 * IM/邮件——任务日志里的 env 赋值、Bearer token、长 hex/base64 密钥、以及
 * **小写/混写凭据**（`apiKey=…` / `token: …`）会原样外发到第三方渠道。
 *
 * 规则本体在 `common/utils/sanitize-secrets.util.ts`（通知 / AI / SOP / Agent
 * 四个面唯一实现）。本文件只做转发：**通知面不截断**——正文长度由上游自控
 * （listener 已截 500），截断会吞掉非敏感的排障信息；这是「展示策略」而非
 * 「规则」，与共享实现的规则集完全一致（`check-sanitize-parity.mjs` 逐入口比对）。
 *
 * 历史教训（不要再犯）：本文件此前保存的是 `ai.service.ts` 那份四条规则的
 * **复制**，而 agent 侧另有五条规则的实现；两份各自演化，于是通知正文里
 * `apiKey` 赋值形态（形如 `apiKey` 后接一个 `sk-live-…` 假值） 一直是明文——见共享实现的文件头注。
 */
import { sanitizeSecrets } from "../../common/utils/sanitize-secrets.util";

export function sanitizeNotificationText(input: string): string {
  return sanitizeSecrets(input);
}
