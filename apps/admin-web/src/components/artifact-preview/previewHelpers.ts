/** 后端 preview 端点认定为文本时，content 才是可直接渲染的 UTF-8 前缀。 */
export function previewContent(preview: {
  kind: 'text' | 'image' | 'binary';
  content?: string | null;
}): string {
  return preview.kind === 'text' ? (preview.content ?? '') : '';
}

/** 预览字节是否不足以覆盖完整文件（展示截断提示）。 */
export function isPreviewTruncated(preview: {
  truncated: boolean;
  size: number;
  content?: string | null;
}): boolean {
  return preview.truncated || preview.size > (preview.content?.length ?? 0);
}
