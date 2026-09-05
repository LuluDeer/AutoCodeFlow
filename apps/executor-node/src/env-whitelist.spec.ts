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
});
