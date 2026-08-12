const ORIGINAL_ENV = process.env;

describe('configuration production secret validation', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'production',
      DB_PASSWORD: 'strong-database-password',
      JWT_SECRET: 'strong-jwt-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'strong-refresh-secret-at-least-32-characters',
      EXECUTOR_SECRET: 'strong-executor-secret',
      CORS_ORIGINS: 'https://admin.example.com',
      INITIAL_ADMIN_PASSWORD: 'changed-on-first-login',
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.resetModules();
  });

  it.each([
    ['JWT_SECRET', 'change_me_to_a_random_secret_32chars', /JWT_SECRET/],
    ['JWT_REFRESH_SECRET', 'change_me_to_another_random_secret_32chars', /JWT_REFRESH_SECRET/],
    ['EXECUTOR_SECRET', 'change_me_to_a_random_token_16chars', /EXECUTOR_SECRET/],
  ])('rejects the .env.example placeholder for %s in production', (name, value, expectedError) => {
    process.env[name] = value;

    expect(() => {
      jest.isolateModules(() => {
        require('./configuration');
      });
    }).toThrow(expectedError);
  });
});
