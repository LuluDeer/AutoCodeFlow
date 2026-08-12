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
