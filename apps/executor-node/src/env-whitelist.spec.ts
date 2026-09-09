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
});
