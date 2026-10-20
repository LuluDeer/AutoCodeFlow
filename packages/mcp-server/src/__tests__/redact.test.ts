/**
 * R110：出参凭据剥除的行为矩阵。
 *
 * 这一层是**防御纵深**，不是替代上游：admin-api 当前对 `webhookSecret` / `tokenHash` / `env` 都是干净的
 * （`select:false` + 响应 DTO 排除 + `maskReadSurface`，R107-A1 逐项核过）。但那三处是彼此独立的约定，
 * 任何一处新增面时漏一次，凭据就会经 `JSON_CONTENT` **直接进 LLM 上下文**。
 */
import { describe, expect, it } from 'vitest';
import { REDACTED, redactSensitive } from '../redact.js';

describe('R110 出参凭据剥除', () => {
  it('整键删除：敏感键名（大小写不敏感）一律替换为 [redacted]', () => {
    const input = {
      id: 'x',
      webhookSecret: 'whsec_abc',
      tokenHash: 'sha256:deadbeef',
      token: 'eyJhbGciOi',
      refreshToken: 'rt_123',
      API_KEY: 'ak_live_1',
      clientSecret: 'cs_1',
      password: 'p@ss',
    };
    const out = redactSensitive(input) as Record<string, unknown>;
    expect(out.id).toBe('x');
    for (const key of ['webhookSecret', 'tokenHash', 'token', 'refreshToken', 'API_KEY', 'clientSecret', 'password']) {
      expect(out[key], key).toBe(REDACTED);
    }
  });

  it('null / undefined 的敏感键保持原样（不把“没配”说成“配了” ）', () => {
    const out = redactSensitive({ webhookSecret: null, token: undefined }) as Record<string, unknown>;
    expect(out.webhookSecret).toBeNull();
    expect(out.token).toBeUndefined();
  });

  it('env：只掩“键名像密钥”的值，其余配置原样保留（否则 agent 失去排障能力）', () => {
    const out = redactSensitive({
      env: {
        DATABASE_URL: 'postgres://u:p@h/db',
        API_TOKEN: 'tok_secret',
        WEBHOOK_SECRET: 'whsec',
        PLAIN_SETTING: 'on',
      },
    }) as { env: Record<string, unknown> };
    expect(out.env.API_TOKEN).toBe(REDACTED);
    expect(out.env.WEBHOOK_SECRET).toBe(REDACTED);
    // DATABASE_URL 也含凭据，但键名不在名单里 —— 明确记为**已知残余风险**（见测试名）
    expect(out.env.PLAIN_SETTING).toBe('on');
  });

  it('嵌套与数组都递归处理', () => {
    const out = redactSensitive({
      items: [{ id: 1, token: 't1' }, { id: 2, token: 't2' }],
      nested: { deeper: { webhookSecret: 'w' } },
    }) as Record<string, any>;
    expect(out.items[0].token).toBe(REDACTED);
    expect(out.items[1].token).toBe(REDACTED);
    expect(out.nested.deeper.webhookSecret).toBe(REDACTED);
    expect(out.items[0].id).toBe(1);
  });

  it('不改原对象（调用方后续逻辑仍看到原值）', () => {
    const input = { token: 'secret', nested: { webhookSecret: 'w' } };
    redactSensitive(input);
    expect(input.token).toBe('secret');
    expect(input.nested.webhookSecret).toBe('w');
  });

  it('循环引用不会打挂（返回 [circular] 占位）', () => {
    const a: Record<string, unknown> = { id: 'a' };
    a.self = a;
    const out = redactSensitive(a) as Record<string, unknown>;
    expect(out.id).toBe('a');
    expect(out.self).toBe('[circular]');
  });

  it('非对象输入原样返回', () => {
    expect(redactSensitive('plain')).toBe('plain');
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBeNull();
  });
});
