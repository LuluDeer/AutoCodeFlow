import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import { logger } from './logger';
import { getAllAdminUrls, getCurrentAdminUrl, failover } from './admin-client';
import { getCurrentToken, forceTokenRefresh } from './middleware/auth';

/**
 * FEAT-05: 执行产物（artifacts）收集与上传 —— executor-node 侧。
 *
 * 与 executor-python/artifacts.py 对等：任务把交付物写进工作目录下的
 * `artifacts/`，任务结束时收集清单 [{name,size,sha256}]，逐文件 multipart PUT
 * 上传到 admin `/api/executions/:execId/artifacts/:name`（机器鉴权，复用回调
 * 同一 token），清单随终态回调上报。artifacts 永远 best-effort —— 任何异常只
 * 记日志，绝不抛出、绝不阻塞任务终态。
 *
 * 上传体走 `createReadStream` + `Readable.toWeb` 的流式 multipart：旧实现
 * `fs.readFileSync` + `new Blob([buf])` 在 100MB 上限的单个产物上制造约
 * 2×文件大小的同步内存尖峰（Buffer + Blob 副本 + FormData 序列化），多产物
 * 并发时足以打爆桌面端渲染进程。现在整条链是常量内存的 stream。
 */

export const MAX_ARTIFACT_COUNT = 20;
export const MAX_ARTIFACT_SIZE = 100 * 1024 * 1024; // 100 MB
const ART_DIR_NAME = 'artifacts';
// 与 admin SAFE_ARTIFACT_NAME_RE 对齐：裸文件名、字母数字开头、仅 [A-Za-z0-9._-]。
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
// 与 python artifacts.py SAFE_EXECUTION_ID_RE / admin executionId 生成口径对齐。
// `#` / `?` / `/` 会让 URL 静默错位，必须在拼路径段之前拒绝。
export const SAFE_EXECUTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeExecutionId(id: string): boolean {
  return typeof id === 'string' && SAFE_EXECUTION_ID_RE.test(id);
}

export interface CollectedArtifact {
  name: string;
  size: number;
  sha256: string;
  absPath: string;
}

export interface ArtifactManifestEntry {
  name: string;
  size: number;
  sha256: string;
}

export function artifactsDirFor(workDir: string): string {
  return path.join(workDir, ART_DIR_NAME);
}

function sha256OfFile(file: string): string {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** 扫描 <workDir>/artifacts/（仅顶层普通文件），返回待上传项（best-effort）。 */
export function collectArtifacts(workDir: string): CollectedArtifact[] {
  const dir = artifactsDirFor(workDir);
  let entries: string[];
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    entries = fs.readdirSync(dir);
  } catch (err) {
    logger.warn(`artifacts: 无法读取 ${dir}: ${String(err)}`);
    return [];
  }

  const items: CollectedArtifact[] = [];
  for (const name of entries.sort()) {
    if (items.length >= MAX_ARTIFACT_COUNT) {
      logger.warn(`artifacts: 超过 ${MAX_ARTIFACT_COUNT} 上限，跳过其余文件`);
      break;
    }
    const abs = path.join(dir, name);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      if (st.size > MAX_ARTIFACT_SIZE) {
        logger.warn(`artifacts: 跳过超限文件 ${name} (${st.size} bytes)`);
        continue;
      }
      if (!SAFE_NAME_RE.test(name)) {
        logger.warn(`artifacts: 跳过非法文件名 ${JSON.stringify(name)}`);
        continue;
      }
      items.push({ name, size: st.size, sha256: sha256OfFile(abs), absPath: abs });
    } catch (err) {
      logger.warn(`artifacts: 处理 ${name} 失败: ${String(err)}`);
    }
  }
  return items;
}

function apiBase(adminBaseUrl: string): string {
  const base = adminBaseUrl.replace(/\/+$/, '');
  return base.endsWith('/api') ? base : `${base}/api`;
}

/** 生成 multipart 边界（只含 RFC 2046 允许的字符）。 */
function makeBoundary(): string {
  return `----AutoFlowArtifact${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * 构造常量内存的 multipart/form-data 请求体。文件句柄在 stream 结束时
 * 由 createReadStream 自己释放；fetch 抛错时 cancel() 触发 destroy。
 */
function multipartStream(
  filePath: string,
  name: string,
  boundary: string,
): ReadableStream<Uint8Array> {
  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const file = fs.createReadStream(filePath);
  const body = new Readable({
    read() { /* pushed from the async iterator below */ },
  });
  void (async () => {
    try {
      body.push(header);
      for await (const chunk of file) {
        body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      body.push(footer);
      body.push(null);
    } catch (err) {
      body.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();
  body.on('destroy', () => file.destroy());
  return Readable.toWeb(body) as ReadableStream<Uint8Array>;
}

/** 候选 admin 地址：当前 + 全部（去重，保序），用于自愈失败后的 failover。 */
function candidateAdminUrls(primary: string): string[] {
  const all = [...new Set([primary, ...getAllAdminUrls()].filter(Boolean))];
  return all.length ? all : [primary];
}

async function putArtifact(
  base: string,
  executionId: string,
  item: CollectedArtifact,
  token: string | null,
  boundary: string,
): Promise<{ ok: boolean; status: number; authFailed: boolean }> {
  const url =
    `${apiBase(base)}/executions/${encodeURIComponent(executionId)}` +
    `/artifacts/${encodeURIComponent(item.name)}?sha256=${item.sha256}`;
  const headers: Record<string, string> = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const resp = await fetch(url, {
      method: 'PUT',
      headers,
      body: multipartStream(item.absPath, item.name, boundary) as any,
      // Node fetch 要求带流式 body 时显式声明 duplex。
      duplex: 'half',
      signal: AbortSignal.timeout(60_000),
    } as RequestInit);
    return { ok: resp.ok, status: resp.status, authFailed: resp.status === 401 };
  } catch (err) {
    logger.warn(`artifacts: 上传 ${item.name} 失败: ${String(err)}`);
    return { ok: false, status: 0, authFailed: false };
  }
}

async function uploadOne(
  primaryAdminUrl: string,
  executionId: string,
  item: CollectedArtifact,
  token: string | null,
): Promise<boolean> {
  try {
    let currentToken = token;
    const urls = candidateAdminUrls(primaryAdminUrl);
    for (let i = 0; i < urls.length; i++) {
      // 每次尝试都重建 boundary + stream —— fetch 失败后原 stream 不可复用。
      const boundary = makeBoundary();
      const result = await putArtifact(urls[i], executionId, item, currentToken, boundary);
      if (result.ok) return true;

      if (result.authFailed) {
        // 401 = per-executor token 被中台轮换：强制刷新一次并原地址重试
        // （与 admin-client.request 的 401 自愈同语义）。
        const fresh = await forceTokenRefresh();
        if (fresh && fresh !== currentToken) {
          currentToken = fresh;
          const healed = await putArtifact(urls[i], executionId, item, currentToken, boundary);
          if (healed.ok) return true;
        }
      }
      // 确定性 4xx（非法名/id、sha 不符）failover 无意义。
      if (result.status >= 400 && result.status < 500 && result.status !== 401) {
        logger.warn(`artifacts: 上传 ${item.name} 返回 HTTP ${result.status}（跳过）`);
        return false;
      }
      if (i < urls.length - 1) {
        failover();
      }
    }
    return false;
  } catch (err) {
    logger.warn(`artifacts: 上传 ${item.name} 失败: ${String(err)}`);
    return false;
  }
}

/** 收集 + 上传，返回入库清单（仅上传成功项）；adminBaseUrl 缺省则返回 []。 */
export async function gatherArtifacts(
  executionId: string,
  workDir: string,
  adminBaseUrl: string | null | undefined,
  token: string | null,
): Promise<ArtifactManifestEntry[]> {
  if (!adminBaseUrl) return [];
  if (!isSafeExecutionId(executionId)) {
    logger.warn(`artifacts: 拒绝为非法 executionId ${JSON.stringify(executionId)} 上传`);
    return [];
  }
  let items: CollectedArtifact[];
  try {
    items = collectArtifacts(workDir);
  } catch (err) {
    logger.warn(`artifacts: 收集异常: ${String(err)}`);
    return [];
  }
  // 优选 admin-client 当前地址（failover 状态）；调用方传入的地址作兜底。
  const primary = getCurrentAdminUrl() || adminBaseUrl;
  const effectiveToken = token ?? (await getCurrentToken());
  const manifest: ArtifactManifestEntry[] = [];
  for (const item of items) {
    const ok = await uploadOne(primary, executionId, item, effectiveToken);
    if (ok) manifest.push({ name: item.name, size: item.size, sha256: item.sha256 });
  }
  if (manifest.length) {
    logger.info(`artifacts: 已上传 ${manifest.length} 个产物 for ${executionId}`);
  }
  return manifest;
}
