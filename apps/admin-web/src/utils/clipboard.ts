/**
 * F-18（DEEP_REVIEW 0ef3bbe）：统一剪贴板写入封装。
 *
 * 全站 3 处 `navigator.clipboard.writeText()` 原先 fire-and-forget：非 HTTPS /
 * iframe 权限受限场景下 writeText reject 产生未处理 rejection，且成功提示照弹
 * （实际没复制）。本封装：
 *  - 优先 navigator.clipboard.writeText；
 *  - 失败时降级 document.execCommand('copy')（旧浏览器/权限受限环境）；
 *  - 返回 boolean 表示是否真正复制成功，调用方据此决定 success/error 反馈。
 */

export async function copyText(text: string): Promise<boolean> {
  // 现代异步剪贴板 API（需安全上下文 / 用户手势）
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 落到 execCommand 降级 */
    }
  }
  // 降级：临时 textarea + execCommand（同步）
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
