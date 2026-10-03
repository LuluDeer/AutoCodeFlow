/**
 * B-13：已部署应用 releases 的**保留期自动清扫**。
 *
 * ## 为什么需要（审计 B-13）
 *
 * apps:delete-release 只有用户手动删除一条路，`<workDir>/apps/<appId>/releases/`
 * 下的版本目录无界增长（每次部署一个 `<version>-<deploymentId>` 目录，含完整
 * 依赖与应用日志）。桌面端补一个保守的自动清扫：每个应用按 mtime 新→旧保留
 * N 个 release，超出的在**通过 canDeleteRelease 闸门**时删除——与手动删除
 * 同一语义：current 指向的、daemon 正在跑的绝不删。
 *
 * ## 保守姿态（与 apps:delete-release 的取舍说明同源）
 *
 *  - 执行器不可达 / app-status 拿不到应答 → **本轮放弃清扫**：无法确认"哪些
 *    daemon 在跑"时，误删会留下孤儿进程 + 半删目录，代价不对称，宁可不清；
 *  - 仅当执行器明确登记了 running 的 deploymentId 才跳过该版本；executor
 *    未登记即视为可删（与手动删除的 /api/app-status 回环判定同一真值源）；
 *  - 单个删除失败只记录，不中断其余条目（目录竞争属常态）。
 *
 * ## 触发点（桌面端没有"部署成功"事件的现实约束）
 *
 * 桌面端不参与部署（部署由 admin → executor-node 直接完成），能观察到的
 * 部署成功信号是执行器日志里的 release 切换行（app-name-recovery 采集的
 * `Current release for <app> now points to <key>`）。因此触发点为：
 *   1) 应用启动后（index.ts whenReady）；
 *   2) executor-process 的 onDeploySwitch 钩子（上述日志行，见 index.ts 接线）。
 *
 * 纯 Node、无 electron 依赖（app-uninstall/app-inventory 同为先例），
 * release-retention.selftest.ts 用真实临时目录逐条驱动。
 */
import * as fs from 'fs';
import * as path from 'path';
import { canDeleteRelease, readCurrentReleaseKey, deleteReleaseDir } from './app-uninstall';
import { splitReleaseKey } from './app-inventory';

/** 每应用保留的 release 数（含 current 指向的那个）。 */
export const RELEASE_RETENTION_KEEP = 5;

/** 单应用清扫结果（releaseKey 维度）。 */
export interface AppSweepOutcome {
  appId: string;
  /** 已删除的 releaseKey（mtime 新→旧保留 keep 个之外、且通过闸门的）。 */
  deleted: string[];
  /** 因闸门（current/running）或删除失败而保留下来的 releaseKey。 */
  skipped: string[];
}

export interface SweepOutcome {
  apps: AppSweepOutcome[];
  errors: string[];
}

/** 列出 releases/ 下的 release 目录名（按 mtime 新→旧；读失败返回 null）。 */
function listReleaseKeysNewestFirst(releasesDir: string): string[] | null {
  try {
    return fs
      .readdirSync(releasesDir)
      .filter((d: string) => {
        try {
          return fs.statSync(path.join(releasesDir, d)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a: string, b: string) => {
        const mt = (n: string) => {
          try {
            return fs.statSync(path.join(releasesDir, n)).mtimeMs;
          } catch {
            return 0;
          }
        };
        return mt(b) - mt(a);
      });
  } catch {
    return null;
  }
}

/**
 * 对单个应用执行保留期清扫。`runningDeploymentIds === null` 表示执行器状态
 * 未知（不可达/超时）——**保守跳过整个应用**（宁可不清，不冒险误删）。
 */
function sweepOneApp(
  appId: string,
  appRoot: string,
  runningDeploymentIds: ReadonlySet<string> | null,
  keep: number,
): AppSweepOutcome {
  const outcome: AppSweepOutcome = { appId, deleted: [], skipped: [] };
  const releasesDir = path.join(appRoot, 'releases');
  if (!fs.existsSync(releasesDir)) return outcome;

  const keys = listReleaseKeysNewestFirst(releasesDir);
  if (keys === null) {
    outcome.skipped.push('(releases 目录不可读)');
    return outcome;
  }
  if (keys.length <= keep) return outcome; // 未超保留数，无事可做

  const currentKey = readCurrentReleaseKey(appRoot);
  // mtime 新→旧排序后的 keep 个之外是候选；每个候选仍过 canDeleteRelease 闸门
  // （current/运行中绝不删——与手动删除完全同一语义）。
  for (const releaseKey of keys.slice(keep)) {
    const { deploymentId } = splitReleaseKey(releaseKey);
    const gate = canDeleteRelease({
      releaseKey,
      currentKey,
      runningDeploymentId:
        runningDeploymentIds !== null && runningDeploymentIds.has(deploymentId)
          ? deploymentId
          : null,
      deploymentId,
    });
    if (!gate.ok) {
      outcome.skipped.push(`${releaseKey}（${gate.reason}）`);
      continue;
    }
    const dir = path.join(releasesDir, releaseKey);
    if (!fs.existsSync(dir)) continue; // 已不在（并发删除等），无需记录
    const del = deleteReleaseDir(dir);
    if (del.ok) {
      outcome.deleted.push(releaseKey);
    } else {
      outcome.skipped.push(`${releaseKey}（删除失败：${del.error ?? 'unknown'}）`);
    }
  }
  return outcome;
}

/**
 * 全量保留期清扫：遍历 `<workDir>/apps/*`，对每个应用执行 sweepOneApp。
 *
 * `fetchRunningDeploymentIds` 注入执行器的运行登记（/api/app-status 的
 * `{deploymentId: {running}}` 视图）；返回 null = 状态未知 → 本轮放弃清扫。
 */
export async function sweepAppReleases(input: {
  workDir: string | undefined;
  fetchRunningDeploymentIds: () => Promise<ReadonlySet<string> | null>;
  keep?: number;
}): Promise<SweepOutcome> {
  const outcome: SweepOutcome = { apps: [], errors: [] };
  if (!input.workDir) return outcome;
  const keep = input.keep ?? RELEASE_RETENTION_KEEP;
  const appsDir = path.join(input.workDir, 'apps');
  if (!fs.existsSync(appsDir)) return outcome;

  let appIds: string[];
  try {
    appIds = fs.readdirSync(appsDir).filter((d: string) => {
      try {
        return fs.statSync(path.join(appsDir, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch (err) {
    outcome.errors.push(`apps 目录不可读：${err instanceof Error ? err.message : String(err)}`);
    return outcome;
  }
  if (appIds.length === 0) return outcome;

  // 运行登记**一次**取得、全应用共享（回环请求不应随应用数放大）。
  let running: ReadonlySet<string> | null;
  try {
    running = await input.fetchRunningDeploymentIds();
  } catch (err) {
    outcome.errors.push(`获取执行器运行状态失败：${err instanceof Error ? err.message : String(err)}`);
    return outcome;
  }
  if (running === null) {
    // 状态未知 → 保守放弃（与 apps:delete-release 的"拿不到答案按在运行处理"同姿态）。
    outcome.errors.push('执行器状态未知（未响应），本轮保留期清扫已跳过');
    return outcome;
  }

  for (const appId of appIds) {
    try {
      outcome.apps.push(sweepOneApp(appId, path.join(appsDir, appId), running, keep));
    } catch (err) {
      // 单应用失败不拖垮其余应用
      outcome.errors.push(`${appId}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return outcome;
}
