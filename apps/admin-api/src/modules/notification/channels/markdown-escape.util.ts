/**
 * A-6: IM markdown 注入防护（wecom / dingtalk / slack 共用）。
 *
 * 告警 title/content 可能携带任务日志片段或用户可控内容（POST
 * /notification/send 的 SDK 面），未转义直接拼进 markdown 时，攻击者可注入
 * `[文本](url)` 链接（wecom/dingtalk）或 `<url|文本>`（slack mrkdwn）构造
 * 钓鱼链接。这里取**最低限度**处置：剥离链接语法的结构字符（`[ ] ( ) < >`）
 * 与除 \t \n \r 外的 C0/G1 控制字符——普通告警文本（错误消息、计数、时间）
 * 的可读性不受影响；email 是纯文本发送、feishu 是 text payload，均无注入
 * 面，不经本工具。
 */
export function escapeMarkdownText(input: string): string {
  if (!input) return input;
  return (
    input
      // 链接/注入语法的结构字符（wecom·dingtalk 的 [text](url)、slack 的 <url|text>）
      .replace(/[[\]()<>]/g, "")
      // 控制字符（保留 \t \n \r；\u007F=DEL）——防零宽/回滚类排版钓鱼
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
  );
}
