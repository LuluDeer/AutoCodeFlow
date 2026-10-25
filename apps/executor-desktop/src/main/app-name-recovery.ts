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
 *
 * ## P2-3：缓存被持续写穿的问题（增量尾读 + 全量回溯节流）
 *
 * 旧的缓存只按「目录签名」（全部文件的 size/mtime 拼串）失效——而**任务运行
 * 期主进程自己就在往今天的日志文件里追加**，签名恒变 → 缓存恒失效 → 每次
 * apps:list 轮询（ipc-handlers，10s 一轮）都对最多 30 个文件/32MB 预算做
 * 同步 readFileSync 全文逐行扫描，全在主线程，UI 周期性卡顿。
 *
 * 修法（两层）：
 *  · **增量尾读**：每个文件记住「已消费到的字节偏移」，映射行只增不减
 *    （electron-log 的按日文件是追加写），签名变化时只读自上次偏移起的尾部，
 *    且只消费到最后一个换行符（半行留到下次，与 readLogIncremental 同纪律）；
 *    文件变小（轮转/截断）→ 该文件状态重置、退回全量读。
 *  · **全量回溯节流**：没有任何状态的文件（首装首次扫描 / 新一天的分片）的
 *    全量读以 FULL_RESCAN_INTERVAL_MS（60s）为间隔——两次全量回溯至少隔
 *    60s；间隔内的全量请求直接跳过该文件（缓存的既有映射照常返回，新文件
 *    的名字最迟 60s 后补上）。
 */

/** 单行格式：`[deploy] Current release for <appName> now points to <releaseKey>` */
const RELEASE_NAME_LINE_RE =
  /\[deploy\]\s+Current release for\s+(.+?)\s+now points to\s+(\S+)\s*$/;

/** 最多回溯的文件数（按文件名倒序取最新）与总字节预算——防止历史日志拖慢列表。 */
const MAX_LOG_FILES = 30;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** 两次全量回溯（对无状态文件的全量读）的最小间隔。 */
const FULL_RESCAN_INTERVAL_MS = 60_000;

export interface ReleaseAppNameHit {
  releaseKey: string;
  appName: string;
}

/**
 * 可注入的 I/O 面：selftest 以计数包装驱动「第二次调用不触发全文件读」的
 * 断言；生产路径用默认实现（fs）。
 */
export interface ReleaseScanIo {
  /** 全量读一个日志文件（UTF-8 文本）。 */
  readFile: (filePath: string) => string;
  /** 从 fromOffset（上次已消费的字节偏移）读到当前 EOF 的增量文本。 */
  readSlice: (filePath: string, fromOffset: number) => string;
  /** 文件大小；stat 失败返回 null（轮转中被删等）。 */
  sizeOf: (filePath: string) => number | null;
  /** 当前时间（全量回溯节流判定；selftest 注入固定时钟）。 */
  now: () => number;
}

const defaultIo: ReleaseScanIo = {
  readFile: (filePath) => fs.readFileSync(filePath, 'utf-8'),
  readSlice: (filePath, fromOffset) => {
    const fd = fs.openSync(filePath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = size - fromOffset;
      if (length <= 0) return '';
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, fromOffset);
      return buf.subarray(0, read).toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  },
  sizeOf: (filePath) => {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
};

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

/** 单个日志文件的增量扫描状态：已消费偏移 + 该文件内累计的映射（只增）。 */
interface LogFileScanState {
  /** 已解析到的字节偏移（停在最后一个完整行的换行符之后）。 */
  consumedBytes: number;
  /** 该文件内累计的 `releaseKey → appName`（同一键后出现的覆盖先出现的）。 */
  names: Map<string, string>;
}

const fileStates = new Map<string, LogFileScanState>();
let cachedSignature: string | null = null;
let cachedNames: Map<string, string> = new Map();
let lastFullScanAt = 0;
/**
 * 存在「被节流跳过、还没补全量读」的无状态文件时，指向节流窗口打开的时刻。
 * 非null 且时钟越过它 → 即使签名没变也不走快路径（否则新分片里部署发生在
 * 窗口内、之后日志彻底静默时，它的映射会永远捡不回来）。
 */
let retryFullScanAt: number | null = null;

/** 测试用：清空缓存（真实运行时不需要）。 */
export function resetReleaseAppNameCache(): void {
  fileStates.clear();
  cachedSignature = null;
  cachedNames = new Map();
  lastFullScanAt = 0;
  retryFullScanAt = null;
}

/**
 * 扫描执行器日志目录，返回 `releaseKey → appName`。
 *
 * 带签名缓存：`apps:list` 每 10s 被轮询一次。签名不变时直接复用上次结果
 * （零文件读，只有 readdir/stat）；签名变化（运行期日志追加是常态）时走
 * **增量尾读**——每个文件只读自上次偏移起的新增字节，不再全文重扫（P2-3，
 * 头注「缓存被持续写穿」）。
 */
export function collectReleaseAppNames(
  logDir: string | undefined,
  io: ReleaseScanIo = defaultIo,
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

  // 状态修剪：已不在文件清单里的（保留期删除/轮转出 MAX_LOG_FILES）丢掉
  // 其增量状态，防止长跑进程的 fileStates 无界增长。
  const listed = new Set(files);
  for (const key of fileStates.keys()) {
    if (!listed.has(key)) fileStates.delete(key);
  }

  const signature = buildSignature(files);
  // constant-time-exempt: signature 是**文件列表的缓存键**（路径/mtime/size 派生），不是凭据。
  // 快路径让位：还有欠着的全量补扫且节流窗口已开时，必须重建（见 retryFullScanAt 注）。
  if (
    cachedSignature === signature &&
    (retryFullScanAt === null || io.now() < retryFullScanAt)
  ) {
    return cachedNames;
  }

  // ── 签名已变（或欠着补扫）：逐文件增量/全量重建 ─────────────────────
  const now = io.now();
  retryFullScanAt = null;
  // 全量读预算与节流窗口（本次调用内是否发生过全量读决定窗口推进）。
  let fullBudget = MAX_TOTAL_BYTES;
  let didFullScan = false;
  // 有任何一次全量/增量回溯发生，最终映射都从各文件状态重新合并——
  // 文件删除/轮转后旧映射不能凭空残留。
  const perFileNames: Array<Map<string, string>> = [];

  for (const file of files) {
    let size = io.sizeOf(file);
    if (size === null) {
      // stat 失败（轮转中被删）：无状态可复用，该文件本轮不参与。
      continue;
    }
    let state = fileStates.get(file);
    // 文件被截断/轮转（大小回退到已消费偏移之前）→ 增量前提失效，重置。
    // 截断重置**不受节流约束**（下方 resetByTruncation）：这是该文件已专名
    // 字的一致性重建，不是冷启动扫描——节流的本意只是管住"新文件首扫"。
    let resetByTruncation = false;
    if (state && size < state.consumedBytes) {
      fileStates.delete(file);
      state = undefined;
      resetByTruncation = true;
    }
    if (!state) {
      // 无状态文件：需要全量读——受节流窗口约束（首扫不受限，lastFullScanAt
      // = 0；截断重置不受限）。窗口内的全量请求跳过该文件：既有缓存映射照常
      // 返回，它的名字最迟 60s 后的下一次回溯补上（apps:list 10s 一轮）。
      if (
        !resetByTruncation &&
        lastFullScanAt !== 0 &&
        now - lastFullScanAt < FULL_RESCAN_INTERVAL_MS
      ) {
        // 欠一次补扫：窗口打开的时刻记录下来，快路径据此让位（见其注释）。
        retryFullScanAt = lastFullScanAt + FULL_RESCAN_INTERVAL_MS;
        continue;
      }
      if (size > fullBudget) continue; // 预算不足（超大盘历史日志）：跳过，与旧实现同口径
      try {
        const text = io.readFile(file);
        const names = new Map<string, string>();
        for (const hit of parseReleaseAppNames(text)) {
          names.set(hit.releaseKey, hit.appName);
        }
        state = { consumedBytes: size, names };
        fileStates.set(file, state);
        fullBudget -= size;
        didFullScan = true;
      } catch {
        continue; // 单文件读失败（轮转竞争等）不影响其余
      }
    } else if (size > state.consumedBytes) {
      // 增量尾读：只读上次偏移之后的新增字节。极端情况（两次调用间追加了
      // 超过整个预算的量）退回全量重读该文件，维持与旧实现相同的读入上限。
      const appended = size - state.consumedBytes;
      try {
        let names = state.names;
        let consumed = size;
        if (appended > MAX_TOTAL_BYTES) {
          const text = io.readFile(file);
          names = new Map<string, string>();
          for (const hit of parseReleaseAppNames(text)) {
            names.set(hit.releaseKey, hit.appName);
          }
          didFullScan = true;
        } else {
          // 只消费到最后一个换行符：尾部半行尚未写完，留到下次（否则会把
          // 被截断的映射行漏解析一次）。偏移停在完整行尾，半行字节下次重读。
          const chunk = io.readSlice(file, state.consumedBytes);
          const lastNl = chunk.lastIndexOf('\n');
          if (lastNl !== -1) {
            for (const hit of parseReleaseAppNames(chunk.slice(0, lastNl))) {
              names.set(hit.releaseKey, hit.appName);
            }
            consumed = state.consumedBytes + Buffer.byteLength(chunk.slice(0, lastNl + 1), 'utf-8');
          } else {
            consumed = state.consumedBytes; // 整段无完整行：偏移不动
          }
        }
        state.consumedBytes = consumed;
      } catch {
        continue; // 增量读失败：保留旧状态，下轮重试
      }
    }
    perFileNames.push(state.names);
  }
  if (didFullScan) lastFullScanAt = now;

  // 合并：files 已按日期倒序（最新在前）。与旧实现同语义——从最新日志往回
  // 读，后读到的（更旧的）不覆盖已确认的（更新的）名字。每个文件的映射随
  // 增量尾读单调生长，合并顺序稳定。
  const names = new Map<string, string>();
  for (const fileNames of perFileNames) {
    for (const [releaseKey, appName] of fileNames) {
      if (!names.has(releaseKey)) names.set(releaseKey, appName);
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
