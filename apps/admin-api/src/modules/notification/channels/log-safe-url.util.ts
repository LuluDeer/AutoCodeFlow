/**
 * R32-A2: 出站日志里的 URL 脱敏。
 *
 * 各渠道在「发送成功 / SSRF 拒绝 / 加签失败」时都会打日志，而渠道 URL 恰恰
 * 常把凭据放在 query 里（dingtalk/wecom 的 `?access_token=`、企业微信的
 * `?key=`、slack 的 path token）。日志会进文件、采集端、工单——比 HTTP
 * 读面（有掩码 + ADMIN 门禁）更远离权限控制，所以这里按参数名做**日志专用**
 * 掩码，不做整体丢弃：保留 scheme/host/path（排障必需），只把 secret 类参数
 * 的值换成 `***`。
 *
 * 与读面（NotificationConfigService.maskUrlSecrets）的区别：这里是"宁可多掩"，
 * 因为它不是契约——前端从不解析日志行，掩错一个 `?key=` 的代价远小于把
 * 机器人 token 写进日志。userinfo（`https://user:pass@host`）同样掩掉。
 *
 * 纯函数、无依赖：六个渠道共用同一份规则，避免"这个渠道脱敏、那个没脱"。
 */
const SECRET_QUERY_PARAM_RE =
  /([?&][^=&#]*(?:pass|secret|token|key|sign)[^=&#]*=)[^&#]+/gi;

/** `https://u:p@h/x?a=1` → `https://[redacted]@h/x?a=***`；空值返回空串。 */
export function redactUrlForLog(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, "$1[redacted]@")
    .replace(SECRET_QUERY_PARAM_RE, "$1***");
}
