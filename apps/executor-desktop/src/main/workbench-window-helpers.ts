/**
 * 工作台窗口的纯辅助层（无 Electron 依赖，selftest 可直接驱动）：
 *  - bounds 的落盘/读回（独立文件，不污染四页 status-window.json）；
 *  - 本地文件选择结果的最小投影（只给名称/大小/MIME/≤64KB 文本预览，
 *    **路径永不越过 IPC 边界**）；
 *  - 加载失败时的内联回退页（含重试按钮）。
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseSavedState, type Rect, type SavedWindowState } from './window-bounds';

/** 工作台窗口状态文件（位于 userData，与四页窗口状态文件分开）。 */
export const WORKBENCH_BOUNDS_FILE = 'workbench-window.json';

export interface WorkbenchLog {
  info(message: string): void;
  warn(message: string): void;
}

/** 读回 bounds；文件不存在/损坏返回 null（窗口按默认尺寸居中）。 */
export function readWorkbenchBounds(logger?: WorkbenchLog): SavedWindowState | null {
  try {
    const file = path.join(process.env.ACF_WORKBENCH_BOUNDS_DIR ?? process.cwd(), WORKBENCH_BOUNDS_FILE);
    return parseSavedState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    logger?.warn(`[workbench] bounds read failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** 防抖落盘；写失败只记日志，不影响窗口体验。 */
export function writeWorkbenchBounds(bounds: Rect, logger?: WorkbenchLog): void {
  try {
    const dir = process.env.ACF_WORKBENCH_BOUNDS_DIR ?? process.cwd();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, WORKBENCH_BOUNDS_FILE);
    const state = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      displayId: null,
      maximized: false,
    };
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch (err) {
    logger?.warn(`[workbench] bounds write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 过桥的文件投影（刻意不含 path/fullPath）。 */
export interface WorkbenchPickedFile {
  name: string;
  size: number;
  mimeType: string;
  textPreview?: string;
}

export const PICK_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const PICK_PREVIEW_MAX_BYTES = 64 * 1024;

/**
 * 把用户选择的文件投影成安全载荷：文件名（去路径分隔符/控制字符）、
 * 字节数、MIME（封闭取值），仅文本文件附 ≤64KB UTF-8 预览。
 * 路径字段一律不输出——这是零凭据/零路径通道的核心不变量。
 */
export function sanitizePickedFiles(raw: unknown): WorkbenchPickedFile[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkbenchPickedFile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const file = item as { name?: unknown; size?: unknown; mimeType?: unknown; buffer?: unknown };
    const name = typeof file.name === 'string'
      ? file.name.replace(/[\\/\u0000-\u001f]/g, '_').slice(-120)
      : 'file';
    const size = typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0
      ? Math.floor(file.size)
      : 0;
    if (size > PICK_MAX_FILE_BYTES) continue;
    const mimeType = typeof file.mimeType === 'string' && /^[a-z0-9+.\-]+\/[a-z0-9+.\-]+$/i.test(file.mimeType) && file.mimeType.length <= 100
      ? file.mimeType
      : 'application/octet-stream';
    const isText = mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml';
    let textPreview: string | undefined;
    if (isText && Buffer.isBuffer(file.buffer)) {
      const slice = file.buffer.subarray(0, PICK_PREVIEW_MAX_BYTES);
      textPreview = slice.toString('utf8');
      if (file.buffer.length > PICK_PREVIEW_MAX_BYTES) textPreview += '\n…[truncated]';
    }
    out.push({ name, size, mimeType, ...(textPreview !== undefined ? { textPreview } : {}) });
  }
  return out.slice(0, 20);
}


const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.log', '.js', '.ts', '.py', '.html', '.css']);

/**
 * 主进程读本地文件并投影成安全载荷：只回传 name/size/mimeType/≤64KB 文本预览。
 * 路径只在此函数内部使用，绝不进入返回值或 IPC 载荷。
 */
export function readLocalFileSelection(filePaths: readonly string[]): WorkbenchPickedFile[] {
  const entries = filePaths.slice(0, 20).map((filePath) => {
    const name = path.basename(filePath);
    const ext = path.extname(name).toLowerCase();
    const mimeType = ext === '.json' ? 'application/json'
      : ext === '.xml' ? 'application/xml'
      : TEXT_EXTENSIONS.has(ext) ? 'text/plain'
      : 'application/octet-stream';
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return { name, size: 0, mimeType };
      const isText = mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml';
      const buffer = isText && stat.size <= PICK_MAX_FILE_BYTES
        ? fs.readFileSync(filePath).subarray(0, PICK_PREVIEW_MAX_BYTES)
        : null;
      return { name, size: stat.size, mimeType, ...(buffer ? { buffer } : {}) };
    } catch {
      return { name, size: 0, mimeType };
    }
  });
  return sanitizePickedFiles(entries);
}

/** HTML 属性文本转义（onclick 等双引号属性用）。 */
function escapeAttr(value: string): string {
  return value.replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  })[c] ?? c);
}

/**
 * 加载失败时的内联回退页（zh/en 双语）。
 *
 * UIAUD-B1-P0-1：失败页当前 URL 是 `data:` URL——`location.reload()` 只会
 * 重新加载这个 data: 页，**永远回不去真实工作台**（审计点名的死循环）。
 * 因此「重试 / Retry」改为导航到 `retryUrl`（创建窗口时解析的真实工作台
 * 地址；同源 http(s)，可通过 will-navigate 白名单）。`retryUrl` 语义：
 *   - 传入 URL → 渲染内嵌 `__acfWorkbenchRetry` 脚本 +「重试」按钮；
 *   - 传 null/undefined → 无真实地址可用，渲染「关闭并重开」按钮（关闭窗口，
 *     重开走原创建入口重新解析配置），绝不渲染 reload。
 * URL 以 JSON 字面量内嵌（`JSON.stringify` 后的 JS 字符串安全嵌入 <script>）。
 */
export function workbenchFallbackHtml(workbenchUrl: string, detail: string, retryUrl?: string | null): string {
  const escape = (value: string): string => value.replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  })[c] ?? c);
  const safeDetail = escape(detail).slice(0, 300);
  const safeUrl = escape(workbenchUrl);
  const retryButton = retryUrl
    ? `<button type="button" onclick="${escapeAttr('__acfWorkbenchRetry()')}">重试 / Retry</button>`
    : `<button type="button" onclick="${escapeAttr('window.close()')}">关闭并重开 / Close and reopen</button>`;
  const retryScript = retryUrl
    ? `<script>window.__acfWorkbenchRetry = function () { location.replace(${JSON.stringify(retryUrl)}); };</script>`
    : '';
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Workbench</title>
<style>body{font:14px system-ui,sans-serif;margin:0;background:#f5f6f8;color:#0f172a;padding:40px}
button{padding:8px 16px;font-size:14px;cursor:pointer}</style>
<div role="alert"><h1>工作台加载失败 / Workbench unavailable</h1>
<p>${safeDetail}</p><p>${safeUrl}</p>
${retryButton}</div>${retryScript}</html>`;
}

/** 纯事件回放上限（避免一次推流过大）。 */
export const WORKBENCH_EVENT_REPLAY_MAX = 20;
