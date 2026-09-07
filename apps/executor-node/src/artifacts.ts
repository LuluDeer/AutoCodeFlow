import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from './logger';

/**
 * FEAT-05: 执行产物（artifacts）收集与上传 —— executor-node 侧。
 *
 * 与 executor-python/artifacts.py 对等：任务把交付物写进工作目录下的
 * `artifacts/`，任务结束时收集清单 [{name,size,sha256}]，逐文件 multipart PUT
 * 上传到 admin `/api/executions/:execId/artifacts/:name`（机器鉴权，复用回调
 * 同一 token），清单随终态回调上报。artifacts 永远 best-effort —— 任何异常只
 * 记日志，绝不抛出、绝不阻塞任务终态。
 */

export const MAX_ARTIFACT_COUNT = 20;
export const MAX_ARTIFACT_SIZE = 100 * 1024 * 1024; // 100 MB
const ART_DIR_NAME = 'artifacts';
// 与 admin SAFE_ARTIFACT_NAME_RE 对齐：裸文件名、字母数字开头、仅 [A-Za-z0-9._-]。
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

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

async function uploadOne(
  adminBaseUrl: string,
  executionId: string,
  item: CollectedArtifact,
  token: string | null,
): Promise<boolean> {
  try {
    const url =
      `${apiBase(adminBaseUrl)}/executions/${encodeURIComponent(executionId)}` +
      `/artifacts/${encodeURIComponent(item.name)}?sha256=${item.sha256}`;
    const buf = fs.readFileSync(item.absPath);
    const form = new FormData();
    form.append('file', new Blob([buf]), item.name);
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const resp = await fetch(url, { method: 'PUT', headers, body: form });
    if (resp.ok) return true;
    logger.warn(`artifacts: 上传 ${item.name} 返回 HTTP ${resp.status}（跳过）`);
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
  let items: CollectedArtifact[];
  try {
    items = collectArtifacts(workDir);
  } catch (err) {
    logger.warn(`artifacts: 收集异常: ${String(err)}`);
    return [];
  }
  const manifest: ArtifactManifestEntry[] = [];
  for (const item of items) {
    const ok = await uploadOne(adminBaseUrl, executionId, item, token);
    if (ok) manifest.push({ name: item.name, size: item.size, sha256: item.sha256 });
  }
  if (manifest.length) {
    logger.info(`artifacts: 已上传 ${manifest.length} 个产物 for ${executionId}`);
  }
  return manifest;
}
