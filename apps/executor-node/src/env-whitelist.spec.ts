import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { ENV_WHITELIST, buildChildEnv } from './env-whitelist';

/** R-04 (windows-findings): the Windows forward set is a security boundary
 *  with two failure directions — a var missing from the whitelist breaks
 *  user tasks on win32 (home dir resolves to '~', getpass raises), a var
 *  wrongly present could leak state. Pin both directions here, host-
 *  independently, by injecting the vars into process.env ourselves. */
describe('env whitelist — Windows parity surface (R-04)', () => {
  const WIN_VARS = [
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
    'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  ];

  it('whitelist contains the full Windows system + home/identity set', () => {
    for (const v of WIN_VARS) {
      expect(ENV_WHITELIST.has(v)).toBe(true);
    }
  });

  it('forwards Windows vars when present in the parent env', () => {
    const saved: Record<string, string | undefined> = {};
    for (const v of WIN_VARS) {
      saved[v] = process.env[v];
      process.env[v] = `test-value-${v}`;
    }
    try {
      const env = buildChildEnv();
      for (const v of WIN_VARS) {
        expect(env[v]).toBe(`test-value-${v}`);
      }
    } finally {
      for (const v of WIN_VARS) process.env[v] = saved[v];
    }
  });

  it('secret denylist still beats the whitelist and still blocks extra overrides', () => {
    process.env.EXECUTOR_SHARED_TOKEN = 'leak-me';
    try {
      expect(ENV_WHITELIST.has('EXECUTOR_SHARED_TOKEN')).toBe(false);
      const env = buildChildEnv({ EXECUTOR_SHARED_TOKEN: 'from-task-params' } as Record<string, string>);
      expect(env.EXECUTOR_SHARED_TOKEN).toBeUndefined();
    } finally {
      delete process.env.EXECUTOR_SHARED_TOKEN;
    }
  });

  /** 改动3: NPM_REGISTRY_TOKEN 只供执行器写任务 .npmrc，绝不进入任务子进程
   *  env——既不在白名单，也不得被额外参数以外的任何途径带出。 */
  it('NPM_REGISTRY_TOKEN is never forwarded to task children', () => {
    expect(ENV_WHITELIST.has('NPM_REGISTRY_TOKEN')).toBe(false);
    process.env.NPM_REGISTRY_TOKEN = 'verdaccio-secret';
    try {
      const env = buildChildEnv();
      expect(env.NPM_REGISTRY_TOKEN).toBeUndefined();
      const win32Style = buildChildEnv({ npm_registry_token: 'x' } as Record<string, string>);
      expect(win32Style.NPM_REGISTRY_TOKEN).toBeUndefined();
    } finally {
      delete process.env.NPM_REGISTRY_TOKEN;
    }
  });

  /** W-20 (windows CI first run): GH windows runners spell these `Path`/
   *  `Temp` (mixed case, OS convention) — exact-key matching dropped them
   *  and every PATH-dependent task started failing on real Windows.
   *  win32 must forward case-insensitively under the canonical key; POSIX
   *  envs are case-sensitive: a wrong-case var is a DIFFERENT variable and
   *  must neither match the whitelist nor leak into the child under the
   *  canonical name. (Note: on win32 `process.env.Path = x` is itself a
   *  case-insensitive write — that's precisely the OS semantics we mirror.) */
  it('win32 matches env keys case-insensitively (POSIX stays case-sensitive)', () => {
    process.env.Path = '/mixed/case/path';
    try {
      const env = buildChildEnv();
      if (process.platform === 'win32') {
        expect(env.PATH).toBe('/mixed/case/path');
        expect(env.Path).toBeUndefined();
      } else {
        // POSIX: real PATH (whatever the shell had) is forwarded untouched;
        // the mixed-case Path must not masquerade as it nor ride along.
        expect(env.PATH).not.toBe('/mixed/case/path');
        expect(env.Path).toBeUndefined();
      }
    } finally {
      delete process.env.Path;
    }
  });

  /**
   * WS5（python_task_upload_and_multiversion）：uv 子进程环境的加固开关必须
   * **穿过白名单**到达 uv。
   *
   * 为什么值得单独钉一条：`UV_PYTHON_DOWNLOADS=manual` 不是"锦上添花"的配置，
   * 而是 D8 的**执行层不变量**——它让"venv 阶段绝不隐式下载解释器"由 uv 自身
   * 强制，而不是依赖我们每次都记得传绝对路径。白名单是本仓库最容易在后续
   * 重构中被收紧的地方（它按设计只放行 ENV_WHITELIST），一旦有人把 `extra`
   * 也改成"必须先在白名单里"，这条加固会**静默失效**：uv 会重新获得自动下载
   * 能力，绕过 D13 的全局单下载队列。所以这里直接断言它活下来。
   */
  it('WS5: uv hardening vars survive the whitelist via the extra channel', () => {
    const env = buildChildEnv({
      UV_PYTHON_DOWNLOADS: 'manual',
      UV_PYTHON_INSTALL_DIR: '/data/interpreters',
      UV_CACHE_DIR: '/data/interpreters/.cache',
      UV_NO_PROGRESS: '1',
      UV_PYTHON_INSTALL_MIRROR: 'https://mirror.internal/python',
    });
    expect(env.UV_PYTHON_DOWNLOADS).toBe('manual');
    expect(env.UV_PYTHON_INSTALL_DIR).toBe('/data/interpreters');
    expect(env.UV_CACHE_DIR).toBe('/data/interpreters/.cache');
    expect(env.UV_NO_PROGRESS).toBe('1');
    expect(env.UV_PYTHON_INSTALL_MIRROR).toBe('https://mirror.internal/python');
    // 加固归加固，密钥隔离不变：uv 子进程绝不能看到执行器凭据。
    expect(env.EXECUTOR_SHARED_TOKEN).toBeUndefined();
    expect(env.EXECUTOR_SECRET).toBeUndefined();
    expect(env.EXECUTION_CALLBACK_SECRET).toBeUndefined();
  });

  it('WS5: a denylisted name cannot be smuggled back through extra', () => {
    // extra 通道是"显式覆盖"语义，但 denylist 优先级更高（既有契约）。
    process.env.EXECUTOR_SHARED_TOKEN = 'leak-me';
    try {
      const env = buildChildEnv({ EXECUTOR_SHARED_TOKEN: 'leak-me-too' });
      expect(env.EXECUTOR_SHARED_TOKEN).toBeUndefined();
    } finally {
      delete process.env.EXECUTOR_SHARED_TOKEN;
    }
  });
});

// ---------------------------------------------------------------------------
// EXEC-05（P3，2026-10-29 执行器域审计）：两端**转发集合**的协议级守卫
//
// 背景：node 与 python 各有一份 SEC-01 白名单，此前只靠注释互指「parity」。
// 实测两份转发集合**并不相同**（python 多 PYTHONPATH/PYTHONHASHSEED/VIRTUAL_ENV，
// node 多 npm_config_cache/npm_config_prefix），而既有对等守卫
// （admin-api secret-key-map.parity.spec.ts）只比对**保留名集合**——那正好是
// 两端交集，差异侧完全无信号：任一端日后静默增删一个转发变量，CI 全绿。
//
// 这里的判据不是「强行统一」（语言运行时专属变量本来就不该统一），而是：
//   ① 清单（protocol.json `envForward`）自己自洽：三桶互斥、每条专属差异
//      都有非空 reason；
//   ② 本端白名单 == common ∪ 本端专属（既不许少登记，也不许凭空多转发）；
//   ③ 与**另一端真实源码**解析出的集合逐项相等——common 必须完全一致，
//      差异只能落在已登记的 runtimeOnly 里。
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PROTOCOL_PATH = path.join(REPO_ROOT, 'packages', 'executor-protocol', 'protocol.json');
const PY_EXECUTE_PATH = path.join(REPO_ROOT, 'apps', 'executor-python', 'routers', 'execute.py');

interface EnvForwardManifest {
  common: string[];
  runtimeOnly: Record<string, Array<{ name: string; reason: string }>>;
  neverForward: string[];
  sources: Record<string, string>;
}

/** 统一按大写归一后比对：名单按各端源码原始拼写登记（node 的 npm_config_cache
 *  是小写），而历史上正因集合未归一，大写形态能绕过判定（见 admin parity spec
 *  的 npm_config_cache 教训）。归一后比对只问「转发哪个变量」，不问拼写。 */
function upperSet(names: Iterable<string>): Set<string> {
  return new Set([...names].map((n) => n.toUpperCase()));
}

/** 解析 python 侧真实白名单：`_ENV_WHITELIST = { ... }` 字面量里的字符串条目。
 *  先剥掉 `#` 行尾注释——python 注释里有 `os.path.expanduser('~')` 这种带引号
 *  的散文，不剥就会把 `~` 当成转发变量。 */
function pythonForwardSet(): Set<string> {
  const src = readFileSync(PY_EXECUTE_PATH, 'utf-8');
  const start = src.indexOf('_ENV_WHITELIST = {');
  expect(start).toBeGreaterThanOrEqual(0); // 源码结构改了就把守卫显式修掉，别静默失效
  const end = src.indexOf('}', start);
  expect(end).toBeGreaterThan(start);
  const block = src
    .slice(start, end)
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
  const names = [...block.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
  expect(names.length).toBeGreaterThan(15);
  return upperSet(names);
}

describe('EXEC-05 · 子进程环境转发清单（protocol.json envForward = 单一事实源）', () => {
  const manifest = JSON.parse(readFileSync(PROTOCOL_PATH, 'utf-8'))
    .envForward as EnvForwardManifest;
  const nodeOnlyEntries = manifest.runtimeOnly['executor-node'];
  const pyOnlyEntries = manifest.runtimeOnly['executor-python'];
  const common = upperSet(manifest.common);
  const nodeOnly = upperSet(nodeOnlyEntries.map((e) => e.name));
  const pyOnly = upperSet(pyOnlyEntries.map((e) => e.name));
  const nodeActual = upperSet(ENV_WHITELIST);

  it('清单自洽：三桶非空、两两互斥（归一后）、专享条目每条都有非空 reason', () => {
    expect(manifest.common.length).toBeGreaterThanOrEqual(20);
    expect(nodeOnly.size).toBeGreaterThan(0);
    expect(pyOnly.size).toBeGreaterThan(0);
    const buckets: Array<[string, Set<string>]> = [
      ['common', common],
      ['executor-node', nodeOnly],
      ['executor-python', pyOnly],
    ];
    for (let i = 0; i < buckets.length; i += 1) {
      for (let j = i + 1; j < buckets.length; j += 1) {
        const overlap = [...buckets[i][1]].filter((n) => buckets[j][1].has(n));
        expect([buckets[i][0], buckets[j][0], overlap]).toEqual([buckets[i][0], buckets[j][0], []]);
      }
    }
    for (const entry of [...nodeOnlyEntries, ...pyOnlyEntries]) {
      // 「按运行时区分的允许差异」必须写明理由——没有理由的差异就是待修的漂移。
      expect([entry.name, entry.reason.length > 10]).toEqual([entry.name, true]);
    }
  });

  it('本端白名单 == common ∪ node 专属（不多转发、也不少登记）', () => {
    const expected = new Set([...common, ...nodeOnly]);
    expect([...nodeActual].sort()).toEqual([...expected].sort());
    // 差异方向显式化：node 专属项真的在转发集合里，python 专属项真的不在。
    for (const n of nodeOnly) expect(nodeActual.has(n)).toBe(true);
    for (const n of pyOnly) expect(nodeActual.has(n)).toBe(false);
  });

  it('与 python 真实源码对账：common 完全一致，差异只落在已登记的两侧专属集合', () => {
    const pyActual = pythonForwardSet();
    // ① common 必须与另一端的解析结果逐项相等（这就是「共同转发集合完全一致」）。
    const pyCommon = [...pyActual].filter((n) => !pyOnly.has(n));
    expect(pyCommon.sort()).toEqual([...common].sort());
    // ② 两端的转发集合差异，恰好等于清单登记的两侧专属集合（对称差判据）。
    const nodeSideDiff = [...nodeActual].filter((n) => !pyActual.has(n)).sort();
    const pySideDiff = [...pyActual].filter((n) => !nodeActual.has(n)).sort();
    expect(nodeSideDiff).toEqual([...nodeOnly].sort());
    expect(pySideDiff).toEqual([...pyOnly].sort());
  });

  it('执行器凭据永不在任何一端的转发集合里（防御纵深，与协议清单同名）', () => {
    const pyActual = pythonForwardSet();
    for (const secret of manifest.neverForward) {
      expect(ENV_WHITELIST.has(secret)).toBe(false);
      expect(nodeActual.has(secret.toUpperCase())).toBe(false);
      expect(pyActual.has(secret.toUpperCase())).toBe(false);
    }
    // 行为侧兜底：即便宿主 env 里真的有，也不会被 buildChildEnv 带出去。
    process.env.EXECUTOR_SHARED_TOKEN = 'leak-me';
    try {
      expect(buildChildEnv().EXECUTOR_SHARED_TOKEN).toBeUndefined();
    } finally {
      delete process.env.EXECUTOR_SHARED_TOKEN;
    }
  });

  it('清单与实际转发行为一致：登记的 node 专属变量真的会到达子进程', () => {
    // 反证方向：如果有人把 npm_config_cache 从白名单里删掉却留下清单条目，
    // 上一条集合断言会红；这里再钉一次「清单里说转发 → 行为上确实转发」。
    const saved = process.env.npm_config_cache;
    process.env.npm_config_cache = '/tmp/npm-cache-test';
    try {
      expect(buildChildEnv().npm_config_cache).toBe('/tmp/npm-cache-test');
    } finally {
      if (saved === undefined) delete process.env.npm_config_cache;
      else process.env.npm_config_cache = saved;
    }
  });
});
