/**
 * 跨端共享缓存的**锁命名规则**（H-4b）。
 *
 * ## 为什么需要它
 *
 * executor-node 与 executor-python 是**两个独立进程**，但在同机部署时可能
 * **共享同一批目录**：
 *
 *   · `.git_cache/<repo>` —— 两端都用 `<cleaned>-<sha256(repoUrl)[:12]>` 命名
 *     （python `routers/execute.py::_repo_dir_name` ↔ node `routes/execute.ts::repoDirName`，
 *     **逐字同式**）；
 *   · `.pkg-cache/<sha256(url)>` —— 两端都用 URL 的 sha256 全量 hex 作键
 *     （python `pkg_cache.py::_cache_key` ↔ node `pkg-cache.ts::cacheKeyFor`，
 *     **逐字同式**）。
 *
 * ⇒ 两端对**同一个资源**算出的键**完全相同**。若两端各自实现一套锁命名
 * 规则，某一端改了前缀/后缀/字符白名单，另一端就锁不到同一把锁 ⇒
 * 「看起来加了跨进程锁」，实际上两端各锁各的 ⇒ 互斥**静默失效**。
 *
 * 这就是本文件存在的理由：**把命名规则钉成两端逐字一致的一份**，
 * 并由 `scripts/check-shared-cache-lock.mjs` 机械核对。
 *
 * ## 🔴 本文件**只钉命名规则，不提供任何实际加锁**（D-20，2026-11-03）
 *
 * **node ↔ python 的跨语言互斥目前未闭环。** 本文件导出的是**键与文件名规则**，
 * 不是锁的实现——executor-node 侧**没有**接 flock 或任何等价的跨进程互斥。
 *
 * 为什么没接（三条都是硬约束，不是省事）：
 *   1. **Node 24 core 没有 flock API**；引入 `fs-ext` / `proper-lockfile` 之类原生依赖
 *      违反本仓「离线私有化 + 零新增依赖」的部署前提（执行器要能在无网环境装）。
 *   2. **`O_EXCL` 与 `flock` 不可互操作**：python 侧持的是 flock，node 侧就算用
 *      「原子创建 + 存在即跳过」，两者也**看不见对方**的区域 ⇒ 互斥**静默失效**
 *      （比没有锁更糟：会让人以为有保护）。
 *   3. **跨容器 pid 存活检测不可靠**（PID namespace 隔离，pid 会复用）⇒
 *      软锁（pid 文件 + TTL）在 SIGKILL 后残留，无法安全回收。
 *
 * ⇒ 实际后果：**当前只有 python 侧持 flock**。同机混布且两端共享
 * `.git_cache` / `.pkg-cache` 时，python↔python 互斥**成立**，python↔node
 * **不成立**。缓解措施与边界：
 *   · compose 默认形态下两端 `.git_cache` / `.pkg-cache` 是**不同卷**
 *     （`executor_python_data` vs `executor_node_data`）⇒ 默认部署**不受影响**；
 *     仅**裸机共享 WORK_DIR** 时才有该窗口。
 *   · 解释器池**是共享卷**，但两端 libc 不同（musl vs gnu）⇒ 写不同子目录，
 *     且 uv 自身有池级 `.lock` 兜底。
 *
 * **本文件的价值**：让「将来 node 侧接入跨进程锁」时，两端**锁的是同一个名字**。
 * 在那之前 —— **不要**把 `check-shared-cache-lock.mjs` 全绿读成「互斥已就绪」。
 *
 * ## 本文件与 python 侧的对应
 *
 * | 概念 | node（本文件） | python（`apps/executor-python/lib/file_lock.py`） |
 * |---|---|---|
 * | 锁文件后缀 | `LOCK_SUFFIX` | `LOCK_SUFFIX` |
 * | 锁文件名前缀 | `LOCK_FILE_PREFIX` | `LOCK_FILE_PREFIX` |
 * | 锁目录名 | `CACHE_LOCK_DIR_NAME` | `CACHE_LOCK_DIR_NAME` |
 * | 安全字符白名单 | `SAFE_CHARS` | `SAFE_CHARS` |
 * | git 锁键 | `gitLockKey()` | `git_lock_key()` |
 * | pkg 锁键 | `pkgLockKey()` | `pkg_lock_key()` |
 * | 解释器锁键 | `interpreterLockKey()` | `interpreter_lock_key()` |
 *
 * ## ⚠ `SAFE_CHARS` 的坑（两端必须都用 ASCII 白名单）
 *
 * python 的 `str.isalnum()` 对 `'中'` 返回 **True**，而 JS 的
 * `/[^A-Za-z0-9._-]/g` 会把它替换成 `'_'` ⇒ 若 python 侧用 `isalnum()`，
 * 两端会算出**不同的文件名** ⇒ 互斥失效。故两侧都固定为
 * `A-Za-z0-9._-` 这套**显式 ASCII 白名单**。
 */

/** 锁文件后缀。 */
export const LOCK_SUFFIX = '.lock';

/**
 * 锁文件名前缀（点开头 ⇒ 隐藏文件；且不会与 `<sha256>.zip` /
 * `<sha256>.meta.json` / `<sha256>.zip.part` / `cpython-*` 目录撞名）。
 */
export const LOCK_FILE_PREFIX = '.acf-';

/**
 * 锁目录名（放在 `<workDir>` 下）。
 *
 * **必须**登记进两端的工作目录保护名单
 * （node `file-logger.ts::PROTECTED_WORKDIR_NAMES` /
 * python `maintenance.py::_PROTECTED_WORKDIR_NAMES`）——
 * 否则 TTL 清扫会在持有者还在持锁时把锁文件删掉 ⇒ 下一个进程创建一个
 * **新 inode** ⇒ 互斥失效。
 */
export const CACHE_LOCK_DIR_NAME = '.cache-locks';

/** 三类共享资源的锁键前缀。 */
export const GIT_LOCK_KEY_PREFIX = 'git-';
export const PKG_LOCK_KEY_PREFIX = 'pkg-';
export const INTERPRETER_LOCK_KEY_PREFIX = 'interp-';

/**
 * 允许出现在锁键里的字符（**ASCII 白名单**，两端逐字一致）。
 *
 * 不能用 JS 的 `\w`（它只含 ASCII，但语义不直观），也不能用 python 的
 * `isalnum()`（它含非 ASCII 字母数字）—— 必须是**这份显式清单**。
 */
export const SAFE_CHARS = /^[A-Za-z0-9._-]$/;

/**
 * 共享资源键 → 锁文件名（**两端命名规则的唯一入口**）。
 *
 * 不安全字符（路径分隔符、URL 里的 `:` `/` 等）一律替换成 `'_'`。
 */
export function lockFileName(key: string): string {
  const safe = String(key)
    .split('')
    .map((ch) => (SAFE_CHARS.test(ch) ? ch : '_'))
    .join('');
  return `${LOCK_FILE_PREFIX}${safe}${LOCK_SUFFIX}`;
}

/** git 缓存锁键（`git-<repoDirName>`）。 */
export function gitLockKey(repoDirName: string): string {
  return `${GIT_LOCK_KEY_PREFIX}${repoDirName}`;
}

/** pkg 缓存锁键（`pkg-<sha256(url)>`）。 */
export function pkgLockKey(cacheKey: string): string {
  return `${PKG_LOCK_KEY_PREFIX}${cacheKey}`;
}

/**
 * 解释器池锁键（`interp-<version>-<platform>`）。
 *
 * 平台段参与键：共享卷里不同平台（musl/gnu）的条目互不干扰，不必互相等待。
 */
export function interpreterLockKey(version: string, platformToken: string | null): string {
  return `${INTERPRETER_LOCK_KEY_PREFIX}${version}-${platformToken || 'any'}`;
}
