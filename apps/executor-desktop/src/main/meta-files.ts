import fs from 'fs';
import path from 'path';

/**
 * NETOPT-D P2-D7: 从 meta 目录选取"最近 N 个"终态文件（按 mtime 倒序）。
 * 单一事实源（history:get 面板）。NETOPT-F P3-1: 头注更新——notifier 自
 * 批次 E 起已改用自有增量水位线（knownFiles，见 notifier.ts），不再消费本
 * 函数；本函数现只有 history:get 一个调用方。此前 notifier 只对数量做
 * 500 上限、按 readdir 字典序取前 N 个（meta 名是 UUID，字典序与写入时间
 * 无关——超限时 recent 任务的 meta 落在窗口外，终态通知静默失效）；
 * history:get 自己按 mtime 排序但语义漂移。两处统一走本函数：
 *  - readdir → 分批并行 stat（fs.promises，libuv 线程池，主线程不卡）→
 *    mtime 倒序 → slice(limit)。
 *  - 单个 stat 失败（文件在 readdir 与 stat 间被删）按 mtime 0 兜底，不
 *    击穿整批（对齐 history:get 既有容错，并补上 notifier 缺失的逐条容错）。
 *  - NETOPT-E P2-1: 候选集没有数量上限——此前先 slice(2000) 再排序，在
 *    meta 名是 UUID（字典序与写入时间无关）的前提下，超 2000 后最近写入的
 *    终态 meta 落在 2001+ 区间永久不进候选（notifier 通知与 history 面板
 *    静默丢失）。分批只是控制并发 stat 的批大小（10 万文件场景不把 libuv
 *    线程池队列一次打爆），不是候选集截断。
 */
export async function pickRecentMetaFiles(
  metaDir: string,
  limit: number,
): Promise<string[]> {
  const names = fs.readdirSync(metaDir).filter((f: string) => f.endsWith('.json'));
  const stats: Array<{ f: string; mtime: number }> = [];
  const BATCH = 200;
  for (let i = 0; i < names.length; i += BATCH) {
    const chunk = names.slice(i, i + BATCH);
    const results = await Promise.all(
      chunk.map(async (f: string) => ({
        f,
        mtime: await fs.promises
          .stat(path.join(metaDir, f))
          .then((s) => s.mtimeMs)
          .catch(() => 0),
      })),
    );
    stats.push(...results);
  }
  return stats
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((x) => x.f);
}
