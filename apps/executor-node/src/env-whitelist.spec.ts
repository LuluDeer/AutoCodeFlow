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
