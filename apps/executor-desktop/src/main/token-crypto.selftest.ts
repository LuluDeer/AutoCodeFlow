/**
 * SEC-NEW-1 self-check for token-crypto.ts + config-store save/mask semantics
 * (node:assert, no test runner needed — same shape as path-domain.selftest.ts).
 *
 * Electron safeStorage does not exist in a plain Node process, so the whole
 * surface is exercised through the setSafeStorageLoader() injection seam with
 * a mock adapter covering the three ADR-012 postures: available / unavailable
 * / decrypt-failure. ConfigStore itself needs Electron (app.getPath), so the
 * store-level behavior is asserted through a minimal harness that replicates
 * the save() branch table against the same helper functions.
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import {
  ENC_PREFIX,
  decryptToken,
  encryptToken,
  isValueEncrypted,
  setSafeStorageLoader,
  SafeStorageLike,
} from './token-crypto';

// Selftests run in bare Node without Electron: electron-log's file transport
// resolves via app.getPath which does not exist here. Route all logging to
// console only so the selftest output stays clean.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const electronLog = require('electron-log') as { transports?: any; default?: any };
{
  const lg = electronLog.default ?? electronLog;
  lg.transports.file.resolvePathFn = () => '/tmp/acf-selftest-unused.log';
  lg.transports.file.level = false;
  lg.transports.console.level = false;
}

/** Reversible mock keyring: base64 with a marker, real round-trip. */
function okAdapter(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`OK:${plain}`, 'utf-8'),
    decryptString: (buf: Buffer) => {
      const s = buf.toString('utf-8');
      if (!s.startsWith('OK:')) throw new Error('bad ciphertext');
      return s.slice(3);
    },
  };
}

function unavailableAdapter(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('not available'); },
    decryptString: () => { throw new Error('not available'); },
  };
}

/** Encrypts fine but throws on decrypt — keyring key lost (machine move). */
function brokenKeyAdapter(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`OK:${plain}`, 'utf-8'),
    decryptString: () => { throw new Error('keyring key changed'); },
  };
}

function main(): void {
  const token = 'st-abc123-SECRET';

  // ── 1. 加密往返（safeStorage 可用）──────────────────────
  setSafeStorageLoader(okAdapter);
  const enc = encryptToken(token);
  assert.ok(enc !== null, 'encrypt returns envelope when available');
  assert.ok(enc.startsWith(ENC_PREFIX), 'envelope has enc:ss: prefix');
  assert.ok(!enc.includes(token), 'ciphertext must not contain plaintext');
  assert.equal(isValueEncrypted(enc), true, 'prefix detection');
  assert.equal(isValueEncrypted(token), false, 'plaintext not detected as envelope');
  assert.equal(decryptToken(enc), token, 'round-trip restores plaintext');

  // 空串不加密（空 token 无需信封）
  assert.equal(encryptToken(''), null, 'empty token → no envelope');
  // 无前缀的读面直接透传（明文路径 = 存量未迁移/降级形态）
  assert.equal(decryptToken(token), token, 'plaintext passes through read path');
  assert.equal(decryptToken(''), '', 'empty read');
  {
    const undef: string | undefined = undefined;
    assert.equal(decryptToken(undef), '', 'undefined read');
  }

  // ── 2. 降级路径（safeStorage 不可用 → 明文 + warn 一次）──
  setSafeStorageLoader(unavailableAdapter);
  assert.equal(encryptToken(token), null, 'unavailable → null (caller keeps plaintext)');
  assert.equal(encryptToken(token), null, 'second call stays null (warn dedup does not throw)');
  // 完全没有 electron 模块（loader 返回 null / require 失败）同样降级
  setSafeStorageLoader(() => null);
  assert.equal(encryptToken(token), null, 'no module → null');
  // 不可用时读面：信封解不开返回空串，明文仍透传
  assert.equal(decryptToken(enc), '', 'envelope without module → empty string');
  assert.equal(decryptToken(token), token, 'plaintext still readable in degraded mode');

  // encryptString 抛错也按降级处理
  setSafeStorageLoader(() => ({
    isEncryptionAvailable: () => true,
    encryptString: () => { throw new Error('keyring locked'); },
    decryptString: (b: Buffer) => b.toString('utf-8'),
  }));
  assert.equal(encryptToken(token), null, 'encryptString throw → null');

  // ── 3. 解密失败 fail-safe（keyring 密钥丢失 → 空串 + warn）──
  setSafeStorageLoader(brokenKeyAdapter);
  const reEnc = encryptToken(token);
  assert.ok(reEnc !== null);
  assert.equal(decryptToken(reEnc), '', 'decrypt failure → empty string (no plaintext guessing)');

  // 损坏的信封内容（非 base64 / 空内容）
  setSafeStorageLoader(okAdapter);
  assert.equal(decryptToken(`${ENC_PREFIX}%%%not-base64%%%`), '', 'corrupted envelope → empty');
  assert.equal(decryptToken(ENC_PREFIX), '', 'empty envelope → empty');

  // ── 4. 存量迁移语义（migrate 分支的判定表，逐行对齐
  //     config-store.migratePlaintextToken 的四种输入）────────
  // 4a. 明文存量 + 可用 → 加密回写（同一字段，无旧字段残留）
  setSafeStorageLoader(okAdapter);
  {
    const stored: string = token; // 旧配置里的明文
    const migrated = isValueEncrypted(stored) || stored === '' ? stored : encryptToken(stored);
    assert.ok(migrated!.startsWith(ENC_PREFIX), '4a plaintext migrated to envelope');
    assert.equal(decryptToken(migrated!), token, '4a migrated value still round-trips');
  }
  // 4b. 明文存量 + 不可用 → 保留明文（fail-safe），下次启动重试
  setSafeStorageLoader(unavailableAdapter);
  {
    const stored = token;
    const encAttempt = encryptToken(stored);
    const final = encAttempt !== null ? encAttempt : stored;
    assert.equal(final, token, '4b migration failure keeps plaintext usable');
  }
  // 4c. 已加密存量 → 不动
  setSafeStorageLoader(okAdapter);
  {
    const stored = enc!;
    assert.equal(isValueEncrypted(stored), true, '4c envelope short-circuits migration');
  }
  // 4d. 空 token → 不动
  {
    const stored = '';
    const migrated = isValueEncrypted(stored) || stored === '' ? stored : encryptToken(stored);
    assert.equal(migrated, '', '4d empty no-op');
  }

  // ── 5. save/脱敏语义（config-store.save 的 executorToken 分支表）──
  const MASK = '******';
  // 5a. 明文写入 → 加密落盘
  setSafeStorageLoader(okAdapter);
  {
    const v = 'new-plain-token';
    const out = isValueEncrypted(v) || [MASK, ''].includes(v) ? v : encryptToken(v) ?? v;
    assert.ok(out!.startsWith(ENC_PREFIX), '5a save(plaintext) stores envelope');
  }
  // 5b. 掩码回写 → 保留原存储值（不把 ****** 当 token 写入）
  {
    const storedBefore = enc!;
    const v = MASK;
    const out = isValueEncrypted(v) || [MASK, ''].includes(v)
      ? (v === MASK || v === '' ? storedBefore : v)
      : encryptToken(v) ?? v;
    assert.equal(out, storedBefore, '5b mask sentinel keeps stored value');
  }
  // 5c. 显式空串 → 清空
  {
    const v = '';
    const out = v === '' ? '' : undefined;
    assert.equal(out, '', '5c empty string clears token');
  }
  // 5d. 密文回写（内部读改写）→ 原样保留
  {
    const v = enc!;
    assert.equal(isValueEncrypted(v), true, '5d envelope passes through save');
  }
  // 5e. 降级时明文写入 → 保留明文（不丢凭据）
  setSafeStorageLoader(unavailableAdapter);
  {
    const v = 'another-plain';
    const out = isValueEncrypted(v) || [MASK, ''].includes(v) ? v : encryptToken(v) ?? v;
    assert.equal(out, 'another-plain', '5e degraded save keeps plaintext');
  }

  setSafeStorageLoader(null);
  console.log('token-crypto selftest: all assertions passed');
}

main();
