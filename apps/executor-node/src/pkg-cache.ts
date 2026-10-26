/**
 * R5b（部署模型评审 2026-10-23 §P2 / §九 9.4-5b）：任务执行链 zip 包**字节缓存**。
 *
 * 痛点：zip 渠道每次执行都把派发载荷里的 packageUrl 重新下载一遍——同一个包
 * 在 N 台设备 × M 次执行上重复 N×M 次传输。packageUrl 形如
 * `uploads/packages/<name>_<ts>.zip`：一次上传 URL 唯一且字节不变，因此 URL
 * 字符串的 sha256 可以直接充当缓存键。
 *
 * 布局：`<workDir>/.pkg-cache/<sha256(url)>.zip` + `<sha256(url)>.meta.json`
 * （{url,size,fetchedAt}）。点目录命名与 `.git_cache`/`.venvs` 同款，且**必须**
 * 登记进 file-logger 的 PROTECTED_WORKDIR_NAMES——workDir 清扫第 1 段按"顶层
 * 条目 mtime"删除一切非基础设施目录，不保护就会在 TTL 后被整棵删掉。
 *
 * 红线（docs/archive/reports/deployment-model-review-2026-10-23.md §六 4/5）：
 *   - 只缓存**完整下载成功**的字节：下载仍走既有 downloadFile 原样落
 *     `<workDir>/<executionId>/package.zip`（SSRF 闸/Bearer/绝对超时/体积上限/
 *     abort signal 全在 downloadFile 内），成功后才把成品字节复制进缓存；
 *     下载失败/中断的半成品由 downloadFile 自行清理，永远到不了这里。
 *   - 缓存命中路径**每次执行照常跑 safeExtractZip**（zip-guard 审查不可被缓存
 *     跳过——缓存只省下载，不做任何安全决策）。审查拒绝时由调用方经
 *     purgePkgCacheEntry 清除坏条目（覆盖"下载成功但内容恶意"的首次下载，
 *     与"缓存条目被外部替换"两种来源）。
 *   - 缓存损坏（size 不符/zip 缺失/读失败）→ 删除该条目并**回退网络下载**
 *     （fail-open 到网络，绝不 fail 任务）。
 *   - 回收 best-effort：字节预算（config.pkgCacheMaxBytes，默认 4GiB，0=关闭）
 *     超限按 mtime 淘汰最旧；任何缓存侧失败只降级为"本次不缓存"，不上抛。
 *
 * v1 边界：只做字节缓存，不做解压产物缓存（评审 §9.4-5b：下载是大头，解压
 * 便宜；硬链接写穿透会污染缓存，复制又比重新解压贵）。executor-python 的对等
 * 改造是后续项（本轮 node-only，评审 §五 影响面表已预留）。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { config } from './config';
import { logger } from './logger';
import { downloadFile, type DownloadFileOptions } from './lib/download';

/** 点目录名（file-logger.PROTECTED_WORKDIR_NAMES 同名登记，勿单独改）。 */
export const PKG_CACHE_DIR_NAME = '.pkg-cache';

export function pkgCacheDir(): string {
  return path.join(config.workDir, PKG_CACHE_DIR_NAME);
}

interface PkgCacheMeta {
  url: string;
  size: number;
  fetchedAt: string;
}

function cacheKeyFor(url: string): string {
  return crypto.createHash('sha256').update(url, 'utf8').digest('hex');
}

/** 陈年 .part 回收门龄：写盘中的 part 恒新鲜（下载预算 120s + 本地复制），
 *  超过该门龄的 part 只能是崩溃残留。与 ORPHAN_META_TTL_MS 同取 24h。 */
const STALE_PART_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 并发互斥：同 URL 首次下载进程内串行（与 execute.ts gitCacheQueues 同款模式）。
// 并发的同 URL 执行排队等待；队首下载完成后， follower 在队内复查缓存直接
// 复用——不会双下载。不同 URL 各自独立入队，互不阻塞。
// ---------------------------------------------------------------------------
const pkgFetchQueues = new Map<string, Promise<unknown>>();

function queuePkgFetch<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = pkgFetchQueues.get(key) ?? Promise.resolve();
  const run = prev.then(job, job);
  const tail = run.then(() => undefined, () => undefined);
  pkgFetchQueues.set(key, tail);
  tail.finally(() => {
    if (pkgFetchQueues.get(key) === tail) pkgFetchQueues.delete(key);
  });
  return run;
}

/** 测试隔离：清空进程内队列（生产代码不得调用）。 */
export function __resetPkgCacheQueuesForTests(): void {
  pkgFetchQueues.clear();
}

function removeEntryQuietly(zipPath: string): void {
  const metaPath = zipPath.replace(/\.zip$/, '.meta.json');
  try {
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(metaPath, { force: true });
  } catch {
    /* best-effort：残留坏条目只会让下次继续 miss + 重下，不破坏正确性 */
  }
}

/**
 * 命中校验 + 复制。命中条件：meta 存在且**可解析**，且 `.zip` 实际字节数与
 * meta.size 一致。任何不一致（缺 zip / size 不符 / JSON 损坏 / 复制失败）都
 * 删除该条目并返回 false（fail-open：调用方回退网络下载）。
 */
function tryCopyFromCache(key: string, dest: string): boolean {
  const dir = pkgCacheDir();
  const zipPath = path.join(dir, `${key}.zip`);
  const metaPath = path.join(dir, `${key}.meta.json`);
  try {
    if (!fs.existsSync(metaPath)) return false;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as PkgCacheMeta;
    const st = fs.statSync(zipPath); // zip 缺失 → throw → 清条目回网络
    if (!st.isFile() || st.size !== meta.size) {
      removeEntryQuietly(zipPath);
      logger.warn(
        `[pkg-cache] entry ${key.slice(0, 12)} corrupted (size mismatch) — dropped, refetching from network`,
      );
      return false;
    }
    fs.copyFileSync(zipPath, dest);
    // LRU 续期：命中即刷新 mtime，让"淘汰最旧"按最近使用而非首次下载排序。
    try {
      const now = new Date();
      fs.utimesSync(zipPath, now, now);
    } catch {
      /* 续期失败不影响命中语义 */
    }
    logger.info(`[pkg-cache] hit ${key.slice(0, 12)} (${meta.size} bytes)`);
    return true;
  } catch (err) {
    removeEntryQuietly(zipPath);
    logger.warn(
      `[pkg-cache] entry ${key.slice(0, 12)} unreadable (${err instanceof Error ? err.message : String(err)}) — dropped, refetching from network`,
    );
    return false;
  }
}

/**
 * 下载成功后写入缓存。两段原子发布（tmp→rename）：条目要么完整出现，要么
 * 不出现——崩溃在最坏情况下留下孤儿 .part/.zip（无 meta），下次按 miss 处理。
 * 全程 best-effort：任何失败只 warn（本次不缓存），绝不上抛影响执行。
 */
function storeInCache(key: string, url: string, srcZip: string, reportedSize: number): void {
  try {
    // meta.size 以**盘上实际字节数**为准（命中校验将来正是拿它与缓存条目比
    // 对）；downloadFile 回报值只作 stat 失败时的兜底——两侧不一致的条目会
    // 永远命中失败，等于白缓存。
    let size = reportedSize;
    try {
      size = fs.statSync(srcZip).size;
    } catch {
      /* stat 不可用（mock 环境/极竞态）→ 用回报值 */
    }
    const dir = pkgCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const zipPart = path.join(dir, `${key}.zip.part`);
    const zipFinal = path.join(dir, `${key}.zip`);
    // 同 key 由 pkgFetchQueues 串行，part 文件名固定不会互踩；copyFileSync
    // 本身整文件覆盖，无需预清理。
    fs.copyFileSync(srcZip, zipPart);
    fs.renameSync(zipPart, zipFinal);
    const meta: PkgCacheMeta = { url, size, fetchedAt: new Date().toISOString() };
    const metaPart = path.join(dir, `${key}.meta.json.part`);
    fs.writeFileSync(metaPart, JSON.stringify(meta));
    fs.renameSync(metaPart, path.join(dir, `${key}.meta.json`));
    logger.info(`[pkg-cache] stored ${key.slice(0, 12)} (${size} bytes)`);
    evictOverBudget(dir);
  } catch (err) {
    logger.warn(
      `[pkg-cache] store failed for ${key.slice(0, 12)} (${err instanceof Error ? err.message : String(err)}) — continuing without cache`,
    );
  }
}

/**
 * 字节预算回收：超限时按 `.zip` 的 mtime 升序（最旧优先）删除条目直到回到
 * 预算内；顺带回收超过门龄的崩溃残留 `.part`（活跃写者的 part 恒新鲜，不会
 * 被误删）。best-effort，任何异常只 warn。
 */
function evictOverBudget(dir: string): void {
  try {
    const maxBytes = config.pkgCacheMaxBytes;
    if (maxBytes <= 0) return;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return; // 目录不存在/不可读 → 无可回收
    }
    const items: Array<{ name: string; size: number; mtimeMs: number }> = [];
    let total = 0;
    for (const name of names) {
      if (!name.endsWith('.zip')) {
        // 陈年 part 回收（见函数头注）；非 zip/part 的未知文件不动。
        if (name.endsWith('.part')) {
          try {
            const st = fs.statSync(path.join(dir, name));
            if (Date.now() - st.mtimeMs > STALE_PART_TTL_MS) {
              fs.rmSync(path.join(dir, name), { force: true });
            }
          } catch {
            /* raced — skip */
          }
        }
        continue;
      }
      try {
        const st = fs.statSync(path.join(dir, name));
        if (st.isFile()) {
          items.push({ name, size: st.size, mtimeMs: st.mtimeMs });
          total += st.size;
        }
      } catch {
        /* raced — skip */
      }
    }
    if (total <= maxBytes) return;
    items.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let evicted = 0;
    for (const item of items) {
      if (total <= maxBytes) break;
      const zipPath = path.join(dir, item.name);
      removeEntryQuietly(zipPath);
      total -= item.size;
      evicted++;
    }
    if (evicted > 0) {
      logger.info(
        `[pkg-cache] evicted ${evicted} entr${evicted === 1 ? 'y' : 'ies'} to fit budget ${maxBytes} bytes`,
      );
    }
  } catch (err) {
    logger.warn(
      `[pkg-cache] eviction failed (${err instanceof Error ? err.message : String(err)}) — best effort, next store retries`,
    );
  }
}

/**
 * zip 渠道取件入口：缓存命中 → 复制到 dest；未命中 → **原样**走既有
 * downloadFile 下载到 dest（调用参数与无缓存时代逐字节一致），成功后写缓存。
 * 下载失败原样上抛（调用方维持既有错误包装）；缓存侧一切失败都 fail-open。
 */
export async function downloadZipWithCache(
  url: string,
  dest: string,
  options: DownloadFileOptions = {},
): Promise<void> {
  const key = cacheKeyFor(url);
  // 快路径：命中直接复制，不进队列。
  if (config.pkgCacheMaxBytes > 0 && tryCopyFromCache(key, dest)) return;
  if (config.pkgCacheMaxBytes <= 0) {
    // 缓存被显式关闭（PKG_CACHE_MAX_BYTES=0）：行为与无缓存时代完全一致。
    await downloadFile(url, dest, options);
    return;
  }
  await queuePkgFetch(key, async () => {
    // 复查：排队期间队首可能刚把同 URL 的条目写好，直接复用。
    if (tryCopyFromCache(key, dest)) return;
    const size = await downloadFile(url, dest, options);
    storeInCache(key, url, dest, size);
  });
}

/**
 * 审查拒绝后清除条目（best-effort，不掩盖原始 ZipSafetyError）：safeExtractZip
 * 在缓存命中路径照常把关，一旦拒绝——无论是首次下载的包本身恶意，还是缓存
 * 条目事后被替换——本次服务的字节都不可再留在缓存里。
 */
export function purgePkgCacheEntry(url: string): void {
  const zipPath = path.join(pkgCacheDir(), `${cacheKeyFor(url)}.zip`);
  try {
    if (fs.existsSync(zipPath)) {
      removeEntryQuietly(zipPath);
      logger.info(`[pkg-cache] purged entry rejected by zip-safety (${cacheKeyFor(url).slice(0, 12)})`);
    }
  } catch {
    /* best-effort：残留坏条目下次命中校验时仍会被丢弃 */
  }
}
