import fs from 'fs';
import path from 'path';

/**
 * 托盘「实时活动计数」的数据源（纯计数 + 容错 meta 扫描）。
 *
 * 数据源复用既有 meta 目录通道（与 history:get / notifier 同一批
 * executor-node 落盘的 `<workDir>/meta/<executionId>.json`），不新增 IPC、
 * 不轮询后端。running 判定口径与状态页 RunningTaskChip / 历史页一致：
 * 记录 `status === 'running'` 即计入。
 *
 * 纯计数 `countRunningTasks` 无 fs 依赖，裸 Node selftest 直接驱动；
 * `scanRunningCount` 是 fs 薄壳（目录缺失 / 单文件写入中途读坏一律容错
 * 不计入，对齐 meta-files.ts / notifier.ts 的逐条容错先例）。
 */

export interface RunningCountRecord {
  status?: unknown;
}

/** 统计 records 中状态为 running 的条数（null/undefined 条目安全跳过）。 */
export function countRunningTasks(records: readonly (RunningCountRecord | null | undefined)[]): number {
  let n = 0;
  for (const r of records) {
    if (r && r.status === 'running') n += 1;
  }
  return n;
}

/**
 * 扫描 meta 目录当前 running 记录数。
 *
 * 目录不存在 / readdir 失败 → 0（未配置 workDir 或目录尚未创建是常态）；
 * 单个 JSON 读坏（写入中途被扫到）跳过该文件，不击穿整批。
 */
export function scanRunningCount(metaDir: string | null | undefined): number {
  if (!metaDir) return 0;
  let names: string[];
  try {
    names = fs.readdirSync(metaDir).filter((f: string) => f.endsWith('.json'));
  } catch {
    return 0;
  }
  let running = 0;
  for (const name of names) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(metaDir, name), 'utf-8'));
      if (raw && typeof raw === 'object' && (raw as { status?: unknown }).status === 'running') {
        running += 1;
      }
    } catch {
      // 写入中途读坏的 meta：下轮重看，本轮不计入。
    }
  }
  return running;
}
