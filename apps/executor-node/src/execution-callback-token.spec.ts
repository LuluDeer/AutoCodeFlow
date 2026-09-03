/**
 * N23: per-execution callback token — executor-node side.
 * Pins the HMAC algorithm against admin-api via a shared test vector and
 * guards the SEC-01 boundary (secret resolution never exposes the raw
 * shared token to children — injection itself is covered in execute.spec).
 */
jest.mock('./config', () => ({
  config: {
    token: 'test-shared-secret',
    executionCallbackSecret: '',
    // N26 (round-8): per-executor tokenHash adopted from the register response
    executorTokenHash: '',
  },
}));

import { config } from './config';
import {
  signExecutionCallbackToken,
  createExecutionCallbackToken,
  resolveCallbackSecret,
  EXECUTION_CALLBACK_TOKEN_PREFIX,
  CALLBACK_TOKEN_GRACE_SECONDS,
} from './execution-callback-token';

const mockConfig = config as {
  token: string;
  executionCallbackSecret: string;
  executorTokenHash: string;
};

const EXEC_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

// Pinned cross-component vector — admin-api's
// execution-callback-token.util.spec.ts verifies this EXACT token for the
// same (secret, executionId, exp). Algorithm drift on one side fails here.
const PINNED_EXP = 2000000000;
const PINNED_TOKEN =
  'v1.f47ac10b-58cc-4372-a567-0e02b2c3d479.2000000000.' +
  '29f7b55965d77d10204409c0146d78628d5d06b86f4c32d8a2778cc2fb84e56b';

describe('execution-callback-token (N23)', () => {
  beforeEach(() => {
    mockConfig.token = 'test-shared-secret';
    mockConfig.executionCallbackSecret = '';
    mockConfig.executorTokenHash = '';
  });

  describe('pinned test vector', () => {
    it('produces byte-for-byte the token admin-api verifies', () => {
      expect(signExecutionCallbackToken('test-secret-vector', EXEC_UUID, PINNED_EXP)).toBe(
        PINNED_TOKEN,
      );
    });
  });

  describe('resolveCallbackSecret', () => {
    it('prefers the dedicated EXECUTION_CALLBACK_SECRET over the shared token', () => {
      mockConfig.executionCallbackSecret = 'dedicated';
      expect(resolveCallbackSecret()).toBe('dedicated');
    });

    it('falls back to the executor shared token', () => {
      expect(resolveCallbackSecret()).toBe('test-shared-secret');
    });

    it('returns empty string when nothing is configured', () => {
      mockConfig.token = '';
      expect(resolveCallbackSecret()).toBe('');
    });

    // N26 (round-8): the per-executor tokenHash received at register time
    // outranks the local shared token but not the dedicated env secret.
    it('uses the register-adopted tokenHash ahead of the shared token', () => {
      mockConfig.executorTokenHash = '$2b$12$perexecutorhash';
      expect(resolveCallbackSecret()).toBe('$2b$12$perexecutorhash');
    });

    it('EXECUTION_CALLBACK_SECRET still outranks the tokenHash', () => {
      mockConfig.executorTokenHash = '$2b$12$perexecutorhash';
      mockConfig.executionCallbackSecret = 'dedicated';
      expect(resolveCallbackSecret()).toBe('dedicated');
    });

    it('falls through to the shared token when no tokenHash was adopted yet', () => {
      mockConfig.executorTokenHash = '';
      expect(resolveCallbackSecret()).toBe('test-shared-secret');
    });

    it('createExecutionCallbackToken signs with the adopted tokenHash', () => {
      mockConfig.executorTokenHash = '$2b$12$perexecutorhash';
      const token = createExecutionCallbackToken(EXEC_UUID, 600)!;
      const expected = signExecutionCallbackToken(
        '$2b$12$perexecutorhash',
        EXEC_UUID,
        Number(token.split('.')[2]),
      );
      expect(token).toBe(expected);
    });
  });

  describe('createExecutionCallbackToken', () => {
    it('mints a v1 token bound to the executionId with the requested TTL', () => {
      const before = Math.floor(Date.now() / 1000);
      const token = createExecutionCallbackToken(EXEC_UUID, 600);
      const after = Math.floor(Date.now() / 1000);
      expect(token).not.toBeNull();
      expect(token!.startsWith(EXECUTION_CALLBACK_TOKEN_PREFIX)).toBe(true);
      const parts = token!.split('.');
      expect(parts[1]).toBe(EXEC_UUID);
      const exp = Number(parts[2]);
      // Rollover-safe: exp = floor(t_create)+600 with before ≤ t_create ≤ after
      expect(exp).toBeGreaterThanOrEqual(before + 600);
      expect(exp).toBeLessThanOrEqual(after + 600);
      expect(parts[3]).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns null when no secret is configured (dev executor → SDK stays disabled)', () => {
      mockConfig.token = '';
      expect(createExecutionCallbackToken(EXEC_UUID, 600)).toBeNull();
    });

    it('returns null for an empty executionId', () => {
      expect(createExecutionCallbackToken('', 600)).toBeNull();
    });

    it('clamps non-positive TTLs to at least 1 second', () => {
      const token = createExecutionCallbackToken(EXEC_UUID, -5)!;
      const exp = Number(token.split('.')[2]);
      expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000) - 1);
    });

    it('two tokens for different executions differ (no cross-execution reuse)', () => {
      const a = createExecutionCallbackToken(EXEC_UUID, 600);
      const b = createExecutionCallbackToken('6b4adba5-a2f8-4fe7-bf4f-5277d0d7f2b7', 600);
      expect(a).not.toBe(b);
    });

    it('grace constant is 15 minutes', () => {
      expect(CALLBACK_TOKEN_GRACE_SECONDS).toBe(900);
    });
  });
});
