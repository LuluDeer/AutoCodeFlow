import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * SEC-NEW-4 at-rest hardening tests.
 *
 * These exercise the REAL config module (no vi.mock of '../config'): the module
 * is re-imported per test through `vi.resetModules()` with ACF_CONFIG_DIR pointed
 * at a throwaway directory, so no test touches the developer's real ~/.config.
 */

const ENV_KEYS = ['ACF_CONFIG_DIR', 'ACF_TOKEN', 'ACF_REFRESH_TOKEN', 'ACF_API_URL'];

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-cli-cfg-'));
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

const modeOf = (p: string): number => fs.statSync(p).mode & 0o777;

async function loadConfig() {
  process.env.ACF_CONFIG_DIR = dir;
  return import('../config');
}

// POSIX permission bits are meaningless on Windows CI; the chmod is best-effort
// there and the assertions below are skipped rather than faked.
const onPosix = process.platform !== 'win32';

describe('acf-cli config at-rest hardening (SEC-NEW-4)', () => {
  it('creates the config file owner-only (0600)', async () => {
    const cfg = await loadConfig();
    const p = cfg.getConfigPath();
    expect(path.dirname(p)).toBe(dir);
    expect(fs.existsSync(p)).toBe(true);
    if (onPosix) expect(modeOf(p)).toBe(0o600);
  });

  it.skipIf(!onPosix)('repairs a legacy group/world-readable file to 0600 without losing credentials', async () => {
    const p = path.join(dir, 'config.json');
    fs.writeFileSync(
      p,
      JSON.stringify({ apiUrl: 'http://disk', token: 'legacy', refreshToken: 'legacy-r' }),
      { mode: 0o644 },
    );
    expect(modeOf(p)).toBe(0o644);

    const cfg = await loadConfig();

    expect(modeOf(cfg.getConfigPath())).toBe(0o600);
    // the repair must only tighten the mode — stored credentials survive
    expect(cfg.getToken()).toBe('legacy');
    expect(cfg.getRefreshToken()).toBe('legacy-r');
  });

  it('env injection takes precedence over on-disk credentials (CI / cron path)', async () => {
    const p = path.join(dir, 'config.json');
    fs.writeFileSync(
      p,
      JSON.stringify({ apiUrl: 'http://disk', token: 'disk-token', refreshToken: 'disk-r' }),
      { mode: 0o600 },
    );
    process.env.ACF_TOKEN = 'env-token';
    process.env.ACF_REFRESH_TOKEN = 'env-r';
    process.env.ACF_API_URL = 'http://env';

    const cfg = await loadConfig();

    expect(cfg.getToken()).toBe('env-token');
    expect(cfg.getRefreshToken()).toBe('env-r');
    expect(cfg.getApiUrl()).toBe('http://env');
  });

  it('setToken/setRefreshToken persist and keep the file owner-only', async () => {
    const cfg = await loadConfig();
    cfg.setToken('jwt-1');
    cfg.setRefreshToken('r-1');

    expect(cfg.getToken()).toBe('jwt-1');
    expect(cfg.getRefreshToken()).toBe('r-1');
    if (onPosix) expect(modeOf(cfg.getConfigPath())).toBe(0o600);

    const raw = JSON.parse(fs.readFileSync(cfg.getConfigPath(), 'utf8'));
    expect(raw).toMatchObject({ token: 'jwt-1', refreshToken: 'r-1' });
  });

  it('clearAuth empties both tokens but keeps apiUrl', async () => {
    const cfg = await loadConfig();
    cfg.setApiUrl('http://keep');
    cfg.setToken('jwt-2');
    cfg.setRefreshToken('r-2');

    cfg.clearAuth();

    expect(cfg.getToken()).toBe('');
    expect(cfg.getRefreshToken()).toBe('');
    expect(cfg.getApiUrl()).toBe('http://keep');
  });
});
