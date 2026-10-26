/**
 * Strip embedded credentials (user:token@) before a URL reaches the logs.
 *
 * 单一事实源：deploy.ts / execute.ts 此前各持一份同名同正则的私有 redactUrl，
 * update-package.ts 则漏了脱敏（downloadUrl 可携带私服内嵌凭据，原文落日志
 * 即泄漏）。任何要把 URL 写进 logger/logger.info 的位置都应经这里。
 */
export function redactUrl(u: string): string {
  return u.replace(/\/\/[^/@]+@/, '//***@');
}
