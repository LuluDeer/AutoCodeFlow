/**
 * R110：出参凭据剥除的行为矩阵。
 *
 * 这一层是**防御纵深**，不是替代上游：admin-api 当前对 `webhookSecret` / `tokenHash` / `env` 都是干净的
 * （`select:false` + 响应 DTO 排除 + `maskReadSurface`，R107-A1 逐项核过）。但那三处是彼此独立的约定，
 * 任何一处新增面时漏一次，凭据就会经 `JSON_CONTENT` **直接进 LLM 上下文**。
 */
import { describe, expect, it } from 'vitest';
import { DEPTH_LIMIT, REDACTED, redactSensitive } from '../redact.js';

/** 把含敏感叶子的对象包 levels 层：敏感对象恰好落在 depth = levels。 */
function nestSecrets(levels: number, value: string): Record<string, unknown> {
  let node: Record<string, unknown> = { token: value, password: value, secret: value };
  for (let i = 0; i < levels; i += 1) node = { child: node };
  return node;
}

/** 沿 child 链下钻 levels 层。 */
function walkChild(root: any, levels: number): Record<string, unknown> {
  let node = root;
  for (let i = 0; i < levels; i += 1) node = node.child;
  return node;
}

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

  it('深度超限 13 层：整枝 [depth-limit]，敏感叶子无明文（fail-closed）', () => {
    const secret = 'SUPER_SECRET_13';
    const out = redactSensitive(nestSecrets(13, secret)) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toContain(secret);
    expect(text).toContain(DEPTH_LIMIT);
  });

  it('边界 12 层：不误截断，敏感键仍按 [redacted] 脱敏', () => {
    const secret = 'BOUNDARY_SECRET_12';
    const out = redactSensitive(nestSecrets(12, secret)) as Record<string, any>;
    const leaf = walkChild(out, 12);
    const text = JSON.stringify(out);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(DEPTH_LIMIT);
    for (const key of ['token', 'password', 'secret']) expect(leaf[key]).toBe(REDACTED);
  });

  it('环引用 + 深度超限：不崩溃、无明文，[circular] 与 [depth-limit] 不冲突', () => {
    const secret = 'CIRCULAR_DEEP_SECRET';
    const cycleRoot: Record<string, unknown> = { payload: nestSecrets(12, secret) };
    cycleRoot.self = cycleRoot;
    const out = redactSensitive(cycleRoot) as Record<string, unknown>;
    let text = '';
    expect(() => { text = JSON.stringify(out); }).not.toThrow();
    expect(text).not.toContain(secret);
    expect(text).toContain(DEPTH_LIMIT);
    expect(out.self).toBe('[circular]');
  });
});
