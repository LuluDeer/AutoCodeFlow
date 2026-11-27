/**
 * Agent runtime 的纯辅助函数（域名白名单交集、截图 inline data URL 对称化、
 * 诊断结果封装），拆出以保持 runtime.ts 精简清晰且不突破 size-caps 基线。
 */

import * as fs from 'fs';
import * as path from 'path';
import { filterAllowlistDomains } from './domain-allowlist';
import type { AgentLiveEventType, ClarificationMediaRef } from './agent-events';
import type { CollabClient } from './collab-client';
import type { DiagnoseResult, LoopNextAction } from './loop';

/** 内联 data URL 原始字节上限（1.5MB 原始 PNG ≈ 2MB base64，低于中台 3MB 闸）。 */
export const INLINE_SCREENSHOT_MAX_BYTES = 1.5 * 1024 * 1024;

/** 判断域名 a 是否落在域名 b 覆盖范围内（精确匹配或子域）。 */
function isDomainCoveredBy(candidate: string, allowed: string): boolean {
  return candidate === allowed || candidate.endsWith(`.${allowed}`);
}

/**
 * 两个已消毒域名白名单的集合交集（支持子域层级收窄）：
 *  - 若 SOP 指定 `erp.corp.com`、本机允许 `corp.com` → 交集保留 `erp.corp.com`；
 *  - 若 SOP 指定 `corp.com`、本机仅允许 `erp.corp.com` → 交集保留 `erp.corp.com`；
 *  - 若 SOP 指定 `evil.com`、本机仅允许 `corp.com` → 交集为空（彻底拒掉）。
 */
export function intersectDomainAllowlists(
  sopDomains: readonly string[],
  localDomains: readonly string[],
): string[] {
  const out: string[] = [];
  for (const s of sopDomains) {
    if (localDomains.some((l) => isDomainCoveredBy(s, l)) && !out.includes(s)) {
      out.push(s);
    }
  }
  for (const l of localDomains) {
    if (sopDomains.some((s) => isDomainCoveredBy(l, s)) && !out.includes(l)) {
      out.push(l);
    }
  }
  return out;
}

/**
 * 计算浏览器生效域名白名单（安全边界）：
 *  - 当本机 `localAllowedDomains` 非空时，绝不允许不可信 SOP frontmatter
 *    通过并集拓宽本机白名单：
 *      · 若 SOP 也声明了 `allowedDomains` → 取交集 `sopDomains ∩ localDomains`；
 *      · 若 SOP 未声明 → 沿用 `localDomains`；
 *      · 若本机配置全是非法单标签等条目 → fail-closed 返回空集。
 *  - 当本机 `localAllowedDomains` 为空时，沿用已消毒的 SOP `allowedDomains`。
 */
export function computeBrowserAllowedDomains(
  sopConstraints: Record<string, unknown> | undefined,
  localAllowedDomains: readonly string[],
): string[] {
  const rawSop = (sopConstraints as { allowedDomains?: unknown } | undefined)?.allowedDomains;
  const sopStrings = Array.isArray(rawSop) ? rawSop.filter((d): d is string => typeof d === 'string') : [];
  const sopFiltered = filterAllowlistDomains(sopStrings);
  const localFiltered = filterAllowlistDomains(localAllowedDomains);

  for (const bad of [...sopFiltered.invalid, ...localFiltered.invalid]) {
    console.warn(`[agent] allowedDomains 非法条目已剔除（不进入浏览器白名单）: ${bad.slice(0, 120)}`);
  }

  if (localAllowedDomains.length > 0) {
    if (localFiltered.valid.length === 0) return [];
    if (sopStrings.length === 0) return localFiltered.valid;
    return intersectDomainAllowlists(sopFiltered.valid, localFiltered.valid);
  }
  return sopFiltered.valid;
}

export function mimeForMedia(name: string): string {
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webm')) return 'video/webm';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

/**
 * GUI / 浏览器截图统一转 LLM image_url：
 *  - 原始体积 ≤ 1.5MB 时优先内联 `data:<mime>;base64,...`（不依赖公网 mediaBaseUrl，
 *    使私有化部署和本地开发下 LLM 同样能看到浏览器与 GUI 截图）；
 *  - 超出 1.5MB 时回退到已配置的 `mediaBaseUrl + mediaPath`。
 */
export function buildScreenshotImageUrl(
  buf: Buffer | null,
  mime: string,
  mediaPath: string | undefined,
  mediaBaseUrl: string | undefined,
): string | null {
  if (buf && buf.length > 0 && buf.length <= INLINE_SCREENSHOT_MAX_BYTES) {
    const imageMime = mime.startsWith('image/') ? mime : 'image/png';
    return `data:${imageMime};base64,${buf.toString('base64')}`;
  }
  if (mediaPath) {
    const base = mediaBaseUrl?.replace(/\/+$/, '');
    if (base && /^https?:\/\//i.test(base)) {
      return `${base}${mediaPath}`;
    }
  }
  return null;
}

export function appendRecentImageUrl(current: readonly string[], nextUrl: string | null): string[] {
  if (!nextUrl) return [...current];
  return [...current, nextUrl].slice(-2);
}

export function appendRecentMediaRef(
  current: readonly ClarificationMediaRef[],
  ref: ClarificationMediaRef,
): ClarificationMediaRef[] {
  return [...current, ref].slice(-6);
}

/** 组装 diagnose 的结构化返回（透传 LLM 真实澄清问题、上下文与已上传截图引用）。 */
export function buildDiagnoseOutcome(
  action: LoopNextAction,
  rawQuestion: unknown,
  state: {
    lastBrowserOutputs: string;
    lastGuiOutputs: string;
    lastTrialStderr: string;
    uploadedMediaRefs: readonly ClarificationMediaRef[];
  },
): DiagnoseResult {
  const question = typeof rawQuestion === 'string' && rawQuestion.trim() !== ''
    ? rawQuestion.trim()
    : undefined;
  const context: Record<string, unknown> = {};
  if (state.lastBrowserOutputs) context.lastBrowserOutputs = state.lastBrowserOutputs;
  if (state.lastGuiOutputs) context.lastGuiOutputs = state.lastGuiOutputs;
  if (state.lastTrialStderr) context.lastTrialStderr = state.lastTrialStderr;
  return {
    action,
    ...(question !== undefined ? { question } : {}),
    ...(Object.keys(context).length > 0 ? { context } : {}),
    ...(state.uploadedMediaRefs.length > 0 ? { mediaRefs: [...state.uploadedMediaRefs] } : {}),
  };
}

/** 可中断退避睡眠：signal 触发立即返回（不继续空等）。 */
export function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 统一处理 GUI 与浏览器截图并产出可追加到观察行的文本片段。
 * 媒体引用/内联图片通过回调回流，使 runtime 侧不再重复条件分支。
 */
export async function captureScreenshotObservation(input: {
  workspaceRoot: string;
  screenshotRelPath: string;
  address: string;
  assignmentId: string;
  client: CollabClient;
  mediaBaseUrl?: string;
  onEvent?: (type: AgentLiveEventType, summary: string, detail?: string) => void;
  onMediaRef?: (ref: ClarificationMediaRef) => void;
  onImageUrl?: (url: string) => void;
}): Promise<string[]> {
  const shot = await processCapturedScreenshot(input);
  const bits: string[] = [];
  if (shot.mediaPath) bits.push(`mediaPath=${shot.mediaPath}`);
  if (shot.mediaRef) input.onMediaRef?.(shot.mediaRef);
  if (shot.imageUrl) input.onImageUrl?.(shot.imageUrl);
  return bits;
}

/**
 * 统一处理 GUI 与浏览器截图：单次读取文件、尽力上传中台、
 * 并按 ≤1.5MB 优先 inline data URL / 超大回退 mediaBaseUrl 的对称规则更新图片列表。
 */
export async function processCapturedScreenshot(input: {
  workspaceRoot: string;
  screenshotRelPath: string;
  address: string;
  assignmentId: string;
  client: CollabClient;
  mediaBaseUrl?: string;
  onEvent?: (type: AgentLiveEventType, summary: string, detail?: string) => void;
}): Promise<{ mediaPath?: string; imageUrl: string | null; mediaRef?: ClarificationMediaRef }> {
  const mime = mimeForMedia(input.screenshotRelPath);
  const name = path.basename(input.screenshotRelPath);
  let buf: Buffer | null = null;
  try {
    buf = fs.readFileSync(path.join(input.workspaceRoot, input.screenshotRelPath));
  } catch {
    return { imageUrl: null };
  }
  let mediaPath: string | undefined;
  let mediaRef: ClarificationMediaRef | undefined;
  try {
    const up = await input.client.uploadMedia(input.address, input.assignmentId, { name, mime, buf });
    if (up.ok && up.mediaPath) {
      mediaPath = up.mediaPath;
      mediaRef = { kind: 'image', url: up.mediaPath, note: name };
    }
  } catch {
    /* 上传失败不抹掉本地截图与 inline 观察能力 */
  }
  const imageUrl = buildScreenshotImageUrl(buf, mime, mediaPath, input.mediaBaseUrl);
  input.onEvent?.('screenshot', `已捕获截图 ${name}`, mediaPath ?? input.screenshotRelPath);
  return { mediaPath, imageUrl, mediaRef };
}
