/**
 * A6（DEEP_REVIEW §七）：死信侧车的**磁盘格式**常量。
 *
 * 单独成文件是因为它同时被两处消费，而这两处不该互相 import：
 *   - `callback.ts`    写/读侧车（对账分层处置的依据）；
 *   - `file-logger.ts` 数死信、扫死信保留（必须**排除**侧车——上报的是
 *                      「积压了多少条没送出去的回调」，侧车不是回调）。
 *
 * 格式：与 payload 同目录、同 basename + 后缀。放在同目录（而不是单独子目录）
 * 是为了让 payload 与它的上下文一起被 mv/rm，不产生跨目录的孤儿。
 */
export const DEAD_LETTER_SIDECAR_SUFFIX = '.deadletter.json';

/** 匹配侧车文件名的正则（file-logger 的保留扫描用它把侧车排除出 keepNewest）。 */
export const DEAD_LETTER_SIDECAR_EXCLUDE_RE = /\.deadletter\.json$/;

/** payload 文件名 → 侧车文件名。 */
export function deadLetterSidecarName(payloadName: string): string {
  return payloadName + DEAD_LETTER_SIDECAR_SUFFIX;
}

/** 侧车文件名 → payload 文件名；非侧车返回 null。 */
export function deadLetterPayloadName(sidecarName: string): string | null {
  if (!sidecarName.endsWith(DEAD_LETTER_SIDECAR_SUFFIX)) return null;
  return sidecarName.slice(0, -DEAD_LETTER_SIDECAR_SUFFIX.length);
}
