/**
 * SEC-NEW-1 (ADR-012): executorToken at-rest encryption via Electron safeStorage.
 *
 * Envelope: encrypted values are stored as `enc:ss:<base64>` — the prefix makes
 * ciphertext/plaintext distinguishable on read without extra metadata fields,
 * so migration (plaintext → envelope) and degradation (plaintext kept + warn)
 * are both lossless.
 *
 * This module is pure Node except for the injected adapter — the Electron
 * `safeStorage` surface is passed in by the caller (ConfigStore wires the real
 * one; selftests inject a mock), keeping the crypto logic testable without
 * Electron. The adapter is resolved lazily so the module never touches
 * `require('electron')` at import time (selftest would crash).
 */
import log from './logger';

/** Envelope prefix: values starting with this are safeStorage ciphertext. */
export const ENC_PREFIX = 'enc:ss:';

/**
 * Minimal structural type of Electron's safeStorage — the real module
 * satisfies this structurally; selftests provide a mock.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Where the real safeStorage module comes from (lazy — Electron main only). */
export type SafeStorageLoader = () => SafeStorageLike | null;

let loader: SafeStorageLoader | null = null;
let warnedUnavailable = false;
let warnedDecryptFailed = false;

/** Test seam: replace the safeStorage loader (null = behave like no electron). */
export function setSafeStorageLoader(fn: SafeStorageLoader | null): void {
  loader = fn;
  warnedUnavailable = false;
  warnedDecryptFailed = false;
}

function getSafeStorage(): SafeStorageLike | null {
  if (loader) return loader();
  try {
    // Lazy require so importing this module never loads Electron.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { safeStorage?: SafeStorageLike };
    return electron.safeStorage ?? null;
  } catch {
    return null;
  }
}

export function isValueEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/**
 * Encrypt a plaintext token into the `enc:ss:` envelope. Returns null when
 * safeStorage is unavailable or fails (caller decides the degraded posture —
 * per ADR-012: keep plaintext + warn once, never drop a usable credential).
 */
export function encryptToken(plain: string): string | null {
  if (plain === '') return null;
  const ss = getSafeStorage();
  if (!ss) {
    warnUnavailable('no safeStorage module');
    return null;
  }
  let available = false;
  try {
    available = ss.isEncryptionAvailable();
  } catch {
    available = false;
  }
  if (!available) {
    warnUnavailable('OS-level credential encryption is not available');
    return null;
  }
  try {
    return ENC_PREFIX + ss.encryptString(plain).toString('base64');
  } catch (err: any) {
    warnUnavailable(`encryptString failed: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Decrypt an `enc:ss:` envelope back to plaintext. Returns '' on any failure
 * (missing/broken envelope content, keyring key lost) with a warn — per
 * ADR-012 never guesses plaintext; the user re-enters the token in the
 * config UI. Values without the prefix are returned as-is (plaintext path).
 */
export function decryptToken(value: string | undefined | null): string {
  if (!value) return '';
  if (!isValueEncrypted(value)) return value;
  const raw = value.slice(ENC_PREFIX.length);
  const ss = getSafeStorage();
  if (!ss) {
    warnDecryptFailed('no safeStorage module to decrypt with');
    return '';
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    warnDecryptFailed('corrupted envelope (not base64)');
    return '';
  }
  try {
    return ss.decryptString(buf);
  } catch (err: any) {
    // Typical cause: OS keyring key lost (reinstall / machine move) — the
    // stored ciphertext is unrecoverable by design (ADR-012 多用户边界).
    warnDecryptFailed(`decryptString failed: ${err?.message ?? err}`);
    return '';
  }
}

/**
 * ADR-012 posture: when encryption is unavailable, plaintext is kept and a
 * warn is logged ONCE per process (not per write) — same shape as the SEC-02
 * secrets-at-rest degradation notice.
 */
function warnUnavailable(reason: string): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  log.warn(
    `[SEC-NEW-1] executorToken will be stored in PLAINTEXT (${reason}). ` +
      'On Linux install/started a keyring service (gnome-keyring / kwallet) to enable ' +
      'encrypted storage; macOS/Windows always provide one (Keychain / DPAPI). ' +
      'This warning is shown once per launch.',
  );
}

function warnDecryptFailed(reason: string): void {
  if (warnedDecryptFailed) return;
  warnedDecryptFailed = true;
  log.warn(
    `[SEC-NEW-1] stored executorToken could not be decrypted (${reason}). ` +
      'The OS keyring key may have changed (reinstall / machine move). ' +
      'Re-enter the executor token in the config page. This warning is shown once per launch.',
  );
}
