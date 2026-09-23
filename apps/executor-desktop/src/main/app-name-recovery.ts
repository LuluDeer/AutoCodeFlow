import fs from 'fs';
import path from 'path';

/**
 * 旧部署的「应用名」回溯（用户报障：列表里全是 UUID，看不出是哪个应用）。
 *
 * ## 为什么需要这个模块
 *
 * executor-node 从 commit `20a0b841` 起才在部署成功时把 `<appRoot>/app.json`
 * 落盘（含 appName）。**在此之前部署的应用，本地磁盘上没有任何地方记录应用名**：
 *
 *   <workDir>/apps/<appId>/                     ← 目录名只有 UUID
 *     ├─ app.json                               ← 旧部署：不存在
 *     └─ releases/<version>-<deploymentId>/     ← 目录名只有版本+部署 ID
 *          ├─ manifest.yaml                      ← 只有 runtime/entrypoint/timeout
 *          ├─ VERSION                            ← 只有版本号
 *          └─ app.log
 *
 * 于是桌面端只能显示 `7ff282b0-a763-45ee-945f-72e4c30f7159` 这种 ID。
 * 本机实测：5 个 release 全部没有 app.json（部署时间 2026-09-21/23，早于
 * `20a0b841` 的 2026-09-23 09:55）。
 *
 * ## 唯一可用的本地线索：执行器自己的日志
 *
 * deploy.ts 在切 current 时固定打印一行（同一 releaseKey 与应用名同现）：
 *
 *   [deploy] Current release for refund-sync now points to 1.0.1-dae29737-…-muczolhj-8t4-1
 *
 * 本机 `userData/logs/executor-2026-09-2*.log` 里实测可完整还原全部 5 个
 * releaseKey 的应用名（`refund-sync`）。releaseKey 含 deploymentId（全局唯一
 * UUID），故这个映射不会跨应用串味。
 *
 * ## 边界（如实告知，不猜）
 *
 * · 桌面端日志保留 7 天（logger.ts::LOG_RETENTION_DAYS）——比这更早的部署
 *   回溯不到名字。这是**只读尽力而为**，回溯不到就如实显示「未知应用名」，
 *   绝不用 appId 冒充名字。
 * · 不做「只有一个应用所以名字就是它」这类推断：那会在多应用机器上张冠李戴。
 */

/** 单行格式：`[deploy] Current release for <appName> now points to <releaseKey>` */
const RELEASE_NAME_LINE_RE =
  /\[deploy\]\s+Current release for\s+(.+?)\s+now points to\s+(\S+)\s*$/;

/** 最多回溯的文件数（按文件名倒序取最新）与总字节预算——防止历史日志拖慢列表。 */
const MAX_LOG_FILES = 30;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export interface ReleaseAppNameHit {
  releaseKey: string;
  appName: string;
}

/**
 * 纯函数：从一段日志文本里抽取 `releaseKey → appName`。
 *
 * 后出现的同名 releaseKey 覆盖先出现的——同一 releaseKey 被重复部署时
 * （resolveReleasePaths 会另起带后缀的新目录，故正常不会重名）以最后一次为准。
 */
export function parseReleaseAppNames(text: string): ReleaseAppNameHit[] {
  const hits: ReleaseAppNameHit[] = [];
  for (const line of text.split(/\r?\n/)) {
    // 快速跳过：绝大多数行不含关键字，避免对 1MB 日志逐行跑正则。
    if (!line.includes('Current release for')) continue;
    const m = RELEASE_NAME_LINE_RE.exec(line);
    if (!m) continue;
    const appName = m[1].trim();
    const releaseKey = m[2].trim();
    if (!appName || !releaseKey) continue;
    hits.push({ releaseKey, appName });
  }
  return hits;
}

/** 日志目录签名：任一文件的 size/mtime 变化都会改变它（缓存失效判据）。 */
function buildSignature(files: string[]): string {
  return files
    .map((name) => {
      try {
        const st = fs.statSync(name);
        return `${path.basename(name)}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${path.basename(name)}:?`;
      }
    })
    .join('|');
}

let cachedSignature: string | null = null;
let cachedNames: Map<string, string> = new Map();

/** 测试用：清空缓存（真实运行时不需要）。 */
export function resetReleaseAppNameCache(): void {
  cachedSignature = null;
  cachedNames = new Map();
}

/**
 * 扫描执行器日志目录，返回 `releaseKey → appName`。
 *
 * 带签名缓存：`apps:list` 每 5s 被轮询一次，而日志是 1MB 级的文件——
 * 无缓存会把「读几 MB 日志」变成每 5s 一次的常态 I/O（PERF-DSK-01 的同类
 * 问题：轮询接口不该做全量重读）。签名不变时直接复用上次结果。
 */
export function collectReleaseAppNames(
  logDir: string | undefined,
): Map<string, string> {
  if (!logDir) return new Map();

  let files: string[] = [];
  try {
    files = fs
      .readdirSync(logDir)
      .filter((f: string) => /^executor-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort()
      .reverse()
      .slice(0, MAX_LOG_FILES)
      .map((f: string) => path.join(logDir, f));
  } catch {
    return new Map(); // 目录不存在/不可读：回溯不可用，不是错误
  }

  const signature = buildSignature(files);
  if (cachedSignature === signature) return cachedNames;

  const names = new Map<string, string>();
  let budget = MAX_TOTAL_BYTES;
  // 从最新日志往回读；后读到的（更旧的）不覆盖已确认的（更新的）名字。
  for (const file of files) {
    if (budget <= 0) break;
    let text: string;
    try {
      const st = fs.statSync(file);
      if (st.size > budget) continue;
      text = fs.readFileSync(file, 'utf-8');
      budget -= st.size;
    } catch {
      continue; // 单文件读失败（轮转中被删等）不影响其余
    }
    for (const hit of parseReleaseAppNames(text)) {
      if (!names.has(hit.releaseKey)) names.set(hit.releaseKey, hit.appName);
    }
  }

  cachedSignature = signature;
  cachedNames = names;
  return names;
}

/**
 * 纯函数：把回溯到的应用名合并进清单条目。
 *
 * 只填 `appName === null` 的条目——app.json 是**权威**来源（部署时由
 * executor-node 直接写入，不受日志保留期限制），绝不被日志推断覆盖。
 */
export function applyRecoveredAppNames<
  T extends { appName: string | null; releaseKey: string },
>(entries: T[], names: Map<string, string>): T[] {
  if (names.size === 0) return entries;
  return entries.map((entry) => {
    if (entry.appName !== null) return entry;
    const recovered = entry.releaseKey ? names.get(entry.releaseKey) : undefined;
    return recovered ? { ...entry, appName: recovered } : entry;
  });
}
