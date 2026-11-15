/**
 * P1-3「产物库」页面纯函数：扩展名判定、预览能力分级、来源执行深链。
 * 独立 util（不与组件同文件），便于单测与口径复用。
 */
import type { ArtifactRow } from '../api/artifacts';

/** 图片扩展名（小写、不含点）——可在弹窗内联 <img> 预览。 */
export const PREVIEW_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] as const;

/** 文本类扩展名（小写、不含点）——可在弹窗内联只读预览。 */
export const PREVIEW_TEXT_EXTS = ['txt', 'log', 'json', 'csv', 'md', 'yaml', 'yml', 'xml'] as const;

/** 取文件名扩展名（小写、不含点）；无扩展名返回空串。 */
export function artifactExtension(name: string): string {
  const base = name.split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** 是否图片（可内联预览）。 */
export function isPreviewableImage(name: string): boolean {
  return (PREVIEW_IMAGE_EXTS as readonly string[]).includes(artifactExtension(name));
}

/** 是否文本（可内联预览）。 */
export function isPreviewableText(name: string): boolean {
  return (PREVIEW_TEXT_EXTS as readonly string[]).includes(artifactExtension(name));
}

/** 预览分级：image / text / none。 */
export type PreviewKind = 'image' | 'text' | 'none';

export function previewKind(name: string): PreviewKind {
  if (isPreviewableImage(name)) return 'image';
  if (isPreviewableText(name)) return 'text';
  return 'none';
}

/** 来源执行深链（任务详情下的执行详情页）。 */
export function executionDeepLink(row: Pick<ArtifactRow, 'taskId' | 'executionId'>): string {
  return `/tasks/${row.taskId}/executions/${row.executionId}`;
}
