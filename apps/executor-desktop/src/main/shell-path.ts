/**
 * macOS 登录 shell 的 PATH 解析与合并（Electron 桌面执行器的 spawn 前补丁）。
 *
 * 故障形态（与 Windows Microsoft Store python 桩同一「症状类」）：
 * 从 Finder/Dock 启动的 .app **不经过用户的登录 shell**，因此拿不到
 * `~/.zshrc` / `~/.zprofile` 里 `export PATH=...` 贡献的条目
 * （/usr/local/bin、/opt/homebrew/bin、pyenv、nvm 等）。executor-node 子进程
 * 继承的是这份「被 launchd 阉割过」的 PATH——机器上 python/git 明明装了，
 * 任务却一律 `command not found`。用户重装、加 PATH、重启都无效，因为问题
 * 不在 shell 配置，而在「谁启动了进程」。
 *
 * 本模块把「登录 shell 里的 PATH」取回来并**前置**合并进子进程 env：
 *   - 只读不写、不改用户配置，零依赖（只用 node 内建）；
 *   - 全链路 fail-open：任何失败返回 null/undefined，调用方保持原 env——
 *     解析 PATH 失败绝不能连累执行器启动；
 *   - exec 可注入（自检注入桩），生产默认走 execFile，不在测试里真起 shell。
 *
 * 为什么必须用哨兵包裹（而不是直接拿 stdout 当 PATH）：
 * `-ilc` 会真正 source 用户的 rc 文件，而 rc 文件是人写的——打印欢迎语、
 * 版本号、`nvm` 提示、even `echo` 调试信息都极常见。若把 stdout 原样当 PATH，
 * 这些横幅会被当成路径条目写进子进程环境，**静默**污染 PATH（比解析失败更
 * 糟：不报错、难排查，且会把真实路径挤到后面）。故用
 * `printf '__ACF_PATH_BEGIN__%s__ACF_PATH_END__' "$PATH"` 精确定位 PATH 区间，
 * 哨兵缺失即判定解析失败并返回 null。
 */
import { execFile } from 'node:child_process';

/** 解析 PATH 用的命令执行器签名（自检注入桩，生产用内置 execFile 实现）。 */
export type ShellExec = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ ok: boolean; stdout: string }>;

export interface ShellPathOptions {
  /** 目标平台；缺省取 process.platform。 */
  platform?: NodeJS.Platform;
  /** 登录 shell 可执行文件；缺省取 process.env.SHELL，darwin 再缺省 /bin/zsh。 */
  shell?: string;
  /** 现有 PATH（生产传 process.env.PATH）。 */
  currentPath?: string;
  /** 解析预算；缺省 3000ms。 */
  timeoutMs?: number;
  /** 注入的命令执行器（自检注入桩；生产缺省用内置 execFile 实现）。 */
  exec?: ShellExec;
}

/** PATH 区间哨兵：rc 文件横幅噪音靠它剥离（见文件头注）。 */
const PATH_BEGIN = '__ACF_PATH_BEGIN__';
const PATH_END = '__ACF_PATH_END__';

const DEFAULT_TIMEOUT_MS = 3000;

function pathDelimiter(platform: NodeJS.Platform): string {
  // win32 用 ';'，其余（含 darwin/linux）用 ':'。注意必须按**目标平台**取，
  // 不能按运行平台——自检在 Linux 上跑 win32 分支就靠这个参数化。
  return platform === 'win32' ? ';' : ':';
}

/** 拆分 PATH 串为条目（按平台分隔符），去空、保序去重。 */
export function parsePathList(raw: string, platform: NodeJS.Platform): string[] {
  // 运行时可能是 null/undefined（配置缺键、env 未设），TS 类型挡不住外部调用，
  // 故按非串处理成空表，而不是抛。
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const delimiter = pathDelimiter(platform);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(delimiter)) {
    const entry = part.trim();
    // 空条目（连续分隔符、首尾分隔符）必须丢弃：空串进 PATH 会被 shell/PATH
    // 查找解释为当前目录，是安全隐患，也是 uv/python 解析的噪声源。
    if (!entry) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/** preferred 条目在前、existing 中未出现过的条目随后；保序去重；绝不丢 existing。 */
export function mergePathLists(
  preferred: string | null | undefined,
  existing: string | null | undefined,
  platform: NodeJS.Platform,
): string {
  const delimiter = pathDelimiter(platform);
  const out: string[] = [];
  const seen = new Set<string>();
  // preferred 在前：登录 shell 的 PATH 反映用户真实意图（Homebrew/pyenv 优先），
  // 也让被 launchd 阉割的 /usr/bin/python3 不至于抢在用户选的解释器前面。
  for (const entry of [
    ...parsePathList(preferred as string, platform),
    ...parsePathList(existing as string, platform),
  ]) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.join(delimiter);
}

/**
 * 内置默认执行器：execFile（**绝不**用 `shell: true`）。
 *
 * 为什么不能用 shell:true：那等于把一个字符串交给 /bin/sh 解析，本模块的
 * 命令里带引号与 `$PATH`，一旦用户 shell 配置再插值就是命令注入面；execFile
 * 的 argv 数组形态没有这层解析。resolve 而非 reject：调用方只做 fail-open。
 */
const defaultShellExec: ShellExec = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        {
          timeout: timeoutMs,
          encoding: 'utf-8',
          // 上限 1MB：PATH 远小于此，给 rc 文件横幅留余量；超限按失败处理。
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (err, stdout) => {
          // 非零退出 / 超时（err.killed）/ spawn 失败（ENOENT）都走这里 → ok:false。
          resolve({
            ok: !err,
            stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          });
        },
      );
    } catch {
      // execFile 自身同步抛（极少数参数非法场景）也必须收敛成 ok:false。
      resolve({ ok: false, stdout: '' });
    }
  });

/** macOS 登录 shell 的 PATH；非 darwin 或任何失败一律返回 null（fail-open）。 */
export async function resolveLoginShellPath(
  opts: ShellPathOptions = {},
): Promise<string | null> {
  const platform = opts.platform ?? process.platform;

  // 平台守卫必须在最前：Linux/Windows 的进程本就继承完整 PATH（从终端、服务
  // 管理器或资源管理器启动都能拿到），在这里起 shell 是纯粹的浪费——更糟的是
  // 行为变化：`-ilc` 会 source 用户 rc，可能带来与 PATH 无关的副作用/耗时。
  // 自检断言这条路径下 exec 调用次数为 0，防止有人「顺手」把它扩到全平台。
  if (platform !== 'darwin') return null;

  const shell = opts.shell || process.env.SHELL || '/bin/zsh';
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const exec = opts.exec ?? defaultShellExec;

  try {
    // `-ilc`：i=交互（source ~/.zshrc）、l=登录（source ~/.zprofile）、
    // c=执行命令。少任一标志都会漏掉用户的一段 PATH 配置——这正是本缺陷的
    // 修复目标，故自检里把 '-ilc' 钉死。
    const { ok, stdout } = await exec(
      shell,
      ['-ilc', `printf '${PATH_BEGIN}%s${PATH_END}' "$PATH"`],
      timeoutMs,
    );
    if (!ok) return null;

    const raw = typeof stdout === 'string' ? stdout : '';
    // 哨兵定位：横幅在 BEGIN 之前、rc 里的后续输出在 END 之后，一律丢弃。
    const begin = raw.indexOf(PATH_BEGIN);
    // 哨兵缺失 = 拿不到可信的 PATH 区间。此时**必须**返回 null，绝不能退化成
    // 「把 raw 当 PATH」——rc 横幅会被当成路径写进子进程 env，静默污染且难查。
    if (begin < 0) return null;
    const end = raw.indexOf(PATH_END, begin + PATH_BEGIN.length);
    if (end < 0) return null;

    const extracted = raw.slice(begin + PATH_BEGIN.length, end);
    // 过一遍 parsePathList：去空、去重，也让「哨兵之间是空白」自然落到
    // 空表 → null（空 PATH 下发出去只会更糟）。
    const entries = parsePathList(extracted, platform);
    if (entries.length === 0) return null;
    return entries.join(pathDelimiter(platform));
  } catch {
    // 注入桩可能 reject、execFile 包装层也可能出意外：一律吞掉返回 null。
    // 绝不让「解析 PATH」这件事把执行器启动打断。
    return null;
  }
}

/** 便捷封装：返回合并后的 PATH；无需变更时返回 undefined。 */
export async function augmentedPath(
  opts: ShellPathOptions = {},
): Promise<string | undefined> {
  const platform = opts.platform ?? process.platform;
  const loginPath = await resolveLoginShellPath(opts);
  // 解析失败 → undefined：调用方不改 env（保持 launchd 给的原样 PATH，
  // 至少不比现状差）。
  if (loginPath === null) return undefined;

  const currentPath = typeof opts.currentPath === 'string' ? opts.currentPath : '';
  const merged = mergePathLists(loginPath, currentPath, platform);
  // 合并结果与现状逐字相同 → undefined，避免无谓的 env 变动：env 每次启动都
  // 重建，若这里下发一个等价值，等于让「PATH 是否变过」这个信号失去意义
  // （排查现场时无法从 env 判断补丁是否生效）。
  if (merged === currentPath) return undefined;
  return merged;
}
