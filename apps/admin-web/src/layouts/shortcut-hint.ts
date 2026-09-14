/**
 * F-25（DEEP_REVIEW 0ef3bbe）：头部搜索入口的快捷键提示按平台判定。
 *
 * 此前 tooltip 硬编码 "Ctrl K"，Mac 用户实际按 ⌘K（CommandPalette 监听
 * metaKey || ctrlKey）。抽成纯函数便于双分支单测（jsdom 只能覆盖一个平台）。
 */

/** navigator.platform / userAgent → 是否 macOS 系（含 iOS，逻辑同浏览器惯例） */
export function isMacPlatform(platform?: string | null, userAgent?: string | null): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform ?? '') || /Mac/.test(userAgent ?? '');
}

/** 平台 → 搜索快捷键提示文案 */
export function searchShortcutHint(isMac: boolean): string {
  return isMac ? '⌘K' : 'Ctrl K';
}
