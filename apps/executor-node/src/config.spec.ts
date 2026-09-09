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
