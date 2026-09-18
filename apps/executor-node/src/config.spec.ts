describe('executor-node config admin API URLs', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.ADMIN_API_URLS;
    delete process.env.ADMIN_API_URL_INTERNAL;
    delete process.env.ADMIN_API_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('uses ADMIN_API_URLS when explicitly configured', async () => {
    process.env.ADMIN_API_URL = 'http://admin-public:3105';
    process.env.ADMIN_API_URL_INTERNAL = 'http://admin-internal:3105';
    process.env.ADMIN_API_URLS = ' http://admin-a:3105, http://admin-b:3105 ';

    const { config } = await import('./config');

    expect(config.adminApiUrls).toEqual([
      'http://admin-a:3105',
      'http://admin-b:3105',
    ]);
  });

  it('falls back to ADMIN_API_URL_INTERNAL before ADMIN_API_URL', async () => {
    process.env.ADMIN_API_URL = 'http://admin-public:3105';
    process.env.ADMIN_API_URL_INTERNAL = 'http://admin-internal:3105';

    const { config } = await import('./config');

    expect(config.adminApiUrl).toBe('http://admin-public:3105');
    expect(config.adminApiUrlInternal).toBe('http://admin-internal:3105');
    expect(config.adminApiUrls).toEqual(['http://admin-internal:3105']);
  });

  it('falls back to ADMIN_API_URL when no internal URL is configured', async () => {
    process.env.ADMIN_API_URL = 'http://admin-public:3105';

    const { config } = await import('./config');

    expect(config.adminApiUrlInternal).toBe('http://admin-public:3105');
    expect(config.adminApiUrls).toEqual(['http://admin-public:3105']);
  });
});

describe('executor-node config workDir (WORK_DIR)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.WORK_DIR;
    delete process.env.Work_Dir;
    delete process.env.work_dir;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('defaults when unset', async () => {
    const { config } = await import('./config');
    expect(config.workDir).toBe('/tmp/autocodeflow/tasks');
  });

  it('uses exact WORK_DIR', async () => {
    process.env.WORK_DIR = 'D:/exact-workdir';
    const { config } = await import('./config');
    expect(config.workDir).toBe('D:/exact-workdir');
  });

  it('falls back to case variants (Work_Dir / work_dir) — Windows env 误配', async () => {
    process.env.Work_Dir = 'D:/mis-spelled';
    const { config } = await import('./config');
    expect(config.workDir).toBe('D:/mis-spelled');

    delete process.env.Work_Dir;
    process.env.work_dir = 'D:/lower';
    jest.resetModules();
    const { config: config2 } = await import('./config');
    expect(config2.workDir).toBe('D:/lower');
  });

  it('exact WORK_DIR wins over a case variant', async () => {
    process.env.WORK_DIR = 'D:/exact';
    process.env.work_dir = 'D:/variant';
    const { config } = await import('./config');
    expect(config.workDir).toBe('D:/exact');
  });

  it('reads process.env lazily (hot-reload via env mutation)', async () => {
    const { config } = await import('./config');
    expect(config.workDir).toBe('/tmp/autocodeflow/tasks');
    process.env.WORK_DIR = 'D:/reloaded';
    expect(config.workDir).toBe('D:/reloaded');
  });
});

describe('executor-node config npmRegistryToken (改动3)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.NPM_REGISTRY_TOKEN;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('optional, defaults to empty string', async () => {
    const { config } = await import('./config');
    expect(config.npmRegistryToken).toBe('');
  });

  it('reads NPM_REGISTRY_TOKEN when set', async () => {
    process.env.NPM_REGISTRY_TOKEN = 'verdaccio-token';
    const { config } = await import('./config');
    expect(config.npmRegistryToken).toBe('verdaccio-token');
  });
});

// E-37（DEEP_REVIEW 0ef3bbe）：版本号双事实源收敛——EXECUTOR_VERSION 不再是
// 手写常量，而是运行时从本包清单读取。本测试把「上报值 == package.json version」
// 钉成不变量：任何一处单独改版都会在这里红。
describe('executor-node EXECUTOR_VERSION single source (E-37)', () => {
  it('equals package.json version (no second hand-maintained copy)', async () => {
    const { EXECUTOR_VERSION } = await import('./config');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../package.json') as { version?: string };

    expect(pkg.version).toBeTruthy();
    expect(EXECUTOR_VERSION).toBe(pkg.version);
    expect(EXECUTOR_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('is read from the manifest, not hardcoded — the module has no version literal', async () => {
    // 反证：把清单换成另一个版本时上报值必须跟着变。直接改文件不现实，因此
    // 用 jest 的模块注册表把 ../package.json 替换成桩，再重新 require config。
    jest.resetModules();
    jest.doMock('../package.json', () => ({ version: '9.9.9' }));
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { EXECUTOR_VERSION } = require('./config') as { EXECUTOR_VERSION: string };
      expect(EXECUTOR_VERSION).toBe('9.9.9');
    } finally {
      jest.dontMock('../package.json');
      jest.resetModules();
    }
  });
});

// E-04：SSRF 逃生阀的取值兼容性。历史注释与 SSRF 报错文案都写 `=1`，而实现
// 只认 'true'——照报错提示设置却不生效是个真陷阱（rollout selftest 首跑即因
// 缺该开关、部署被判 failed 而暴露）。两种写法都必须放行。
describe('executor-node config allowPrivateNetwork (E-04 escape hatch)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('defaults to false (fail-closed) when unset', async () => {
    const { config } = await import('./config');
    expect(config.allowPrivateNetwork).toBe(false);
  });

  it.each(['true', '1'])('accepts %s as enabled', async (value) => {
    process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = value;
    const { config } = await import('./config');
    expect(config.allowPrivateNetwork).toBe(true);
  });

  it.each(['false', '0', 'yes', ''])(
    'treats %s as disabled',
    async (value) => {
      process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = value;
      const { config } = await import('./config');
      expect(config.allowPrivateNetwork).toBe(false);
    },
  );
});

// AUTOFLOW-API-URL-01：任务 env 注入的 admin 基址优先级必须与 executor-python
// 的 `admin_api.get_admin_api_base_url()` 逐条对齐（external > internal > default），
// 也与本仓 `middleware/auth.ts::getAdminApiUrl` 同序——同一进程对"admin 在哪"
// 不能给出两个答案。
describe('resolveAdminApiBaseUrl priority (AUTOFLOW-API-URL-01)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.ADMIN_API_URL;
    delete process.env.ADMIN_API_URL_INTERNAL;
    delete process.env.ADMIN_API_URL_EXTERNAL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  async function resolve(): Promise<{ fromConfig: string; fromHelper: string }> {
    const { config } = await import('./config');
    const { resolveAdminApiBaseUrl } = await import('./admin-api-url');
    return {
      fromConfig: resolveAdminApiBaseUrl(config),
      fromHelper: resolveAdminApiBaseUrl(config),
    };
  }

  it('external 优先于 internal 与 default（python 同序）', async () => {
    // 反证：把 resolveAdminApiBaseUrl 改回 `internal || default`，
    // 本例立即转红（会得到 internal）。
    process.env.ADMIN_API_URL = 'http://admin-default:3105';
    process.env.ADMIN_API_URL_INTERNAL = 'http://admin-internal:3105';
    process.env.ADMIN_API_URL_EXTERNAL = 'https://admin.example.com/api';
    const { fromConfig } = await resolve();
    expect(fromConfig).toBe('https://admin.example.com/api');
  });

  it('无 external 时用 internal', async () => {
    process.env.ADMIN_API_URL = 'http://admin-default:3105';
    process.env.ADMIN_API_URL_INTERNAL = 'http://admin-internal:3105';
    const { fromConfig } = await resolve();
    expect(fromConfig).toBe('http://admin-internal:3105');
  });

  it('两者都缺时回落到 default（既有行为不变）', async () => {
    process.env.ADMIN_API_URL = 'http://admin-default:3105';
    const { fromConfig } = await resolve();
    expect(fromConfig).toBe('http://admin-default:3105');
  });

  it('纯函数判定与 config 解耦（可直接喂形状相同的最小对象）', async () => {
    const { resolveAdminApiBaseUrl } = await import('./admin-api-url');
    expect(resolveAdminApiBaseUrl({})).toBe('');
    expect(
      resolveAdminApiBaseUrl({ adminApiUrlInternal: 'http://internal:3105' }),
    ).toBe('http://internal:3105');
    expect(
      resolveAdminApiBaseUrl({
        adminApiUrl: 'http://default:3105',
        adminApiUrlInternal: 'http://internal:3105',
        adminApiUrlExternal: 'https://public.example.com/api',
      }),
    ).toBe('https://public.example.com/api');
  });
});
// `_SECONDS`。此前只读 `_SECONDS`，于是桌面端用户填的值**完全不生效**
// （设置页承诺了、执行器不读）——而若真按秒解析，300000 会被钳成 86400 秒。
describe('executor-node config interpreterDownloadTimeoutMs', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.INTERPRETER_DOWNLOAD_TIMEOUT_MS;
    delete process.env.INTERPRETER_DOWNLOAD_TIMEOUT_SECONDS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('缺省 300s', async () => {
    const { config } = await import('./config');
    expect(config.interpreterDownloadTimeoutMs).toBe(300_000);
  });

  it('_SECONDS 键按秒解析（compose 既有语义不变）', async () => {
    process.env.INTERPRETER_DOWNLOAD_TIMEOUT_SECONDS = '120';
    const { config } = await import('./config');
    expect(config.interpreterDownloadTimeoutMs).toBe(120_000);
  });

  it('_MS 键按毫秒解析（桌面端设置页下发的键）', async () => {
    // 反证：删掉 config.ts 里读 `_MS` 的那一段，本例立即转红（会回落到 300s）。
    process.env.INTERPRETER_DOWNLOAD_TIMEOUT_MS = '300000';
    const { config } = await import('./config');
    expect(config.interpreterDownloadTimeoutMs).toBe(300_000);
  });

  it('_MS 优先于 _SECONDS（更具体的键赢）', async () => {
    process.env.INTERPRETER_DOWNLOAD_TIMEOUT_MS = '5000';
    process.env.INTERPRETER_DOWNLOAD_TIMEOUT_SECONDS = '120';
    const { config } = await import('./config');
    expect(config.interpreterDownloadTimeoutMs).toBe(5_000);
  });

  it('_MS 越界钳到 [1s, 24h]，不会变成 24 小时', async () => {
    // 用户把"毫秒"当"秒"填（300000 想表达 5 分钟）在 _SECONDS 下会变成
    // 24 小时——_MS 键下必须得到 5 分钟。
    process.env.INTERPRETER_DOWNLOAD_TIMEOUT_MS = '300000';
    const { config } = await import('./config');
    expect(config.interpreterDownloadTimeoutMs).toBe(5 * 60 * 1000);

    process.env.INTERPRETER_DOWNLOAD_TIMEOUT_MS = '1';
    const { config: c2 } = await import('./config');
    expect(c2.interpreterDownloadTimeoutMs).toBe(1_000);

    process.env.INTERPRETER_DOWNLOAD_TIMEOUT_MS = '999999999';
    const { config: c3 } = await import('./config');
    expect(c3.interpreterDownloadTimeoutMs).toBe(86_400_000);
  });
});
