import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import {
  PARAMS_JSON_ENV_KEY,
  PARAM_ENV_KEY_COLLISION_REASON,
  describeParamEnvKeyCollisions,
  findParamEnvKeyCollisions,
  isInjectableParamEnvKey,
  paramEnvKey,
  serializeParamEnvValue,
} from './param-env';

/**
 * EXEC-07（P3，2026-10-29 执行器域审计）：params 键名闸是**大小写敏感**的，
 * 而注入通道把键名 `toUpperCase()` 折叠成 `AUTOFLOW_<KEY>` ——
 * `{"limit":1,"LIMIT":2}` 两个键都过闸、都注入成 AUTOFLOW_LIMIT，后者静默
 * 覆盖前者且**零 warn**（旧实现在此处没有任何判定，见下方第一条用例：折叠
 * 本身就是既成事实，缺的是冲突判定）。
 *
 * 本文件的断言分三层：
 *   ① 「为什么」——折叠确实是既成事实（paramEnvKey 大小写不敏感）、且两个键
 *      都能通过键名闸（所以键名闸单独存在时无法拦住这个形态）；
 *   ② 判定与文案对真实实现逐条断言 protocol.json 的 `params.keyUniqueness`
 *      向量（含 expectCollisions 与**逐字节**的 expectError）；
 *   ③ 不扩大拒绝面：折叠后不冲突的大小写不同键照旧全部合法。
 *
 * 端到端闸门（accept 阶段 400）在 routes/execute.spec.ts 的 EXEC-07 用例里。
 */
const PROTOCOL = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../../packages/executor-protocol/protocol.json'),
    'utf-8',
  ),
) as {
  params: {
    keyUniqueness: {
      rule: string;
      onCollision: string;
      statusCode: number;
      reasonCode: string;
      collisionScope: string;
      messageTemplate: string;
      vectors: Array<{
        name: string;
        params: Record<string, unknown>;
        expectCollisions: Array<{ envKey: string; keys: string[] }>;
        expectError: string | null;
      }>;
    };
  };
};

const SECTION = PROTOCOL.params.keyUniqueness;

describe('EXEC-07 · params 键名折叠冲突（判定 + 文案）', () => {
  it('① 折叠是既成事实：大小写不同的同名键共用一个 env 名，且都能过键名闸', () => {
    // 这两条一起构成缺陷的成因：键名闸只看字符集（大小写敏感），注入却折叠。
    expect(paramEnvKey('limit')).toBe('AUTOFLOW_LIMIT');
    expect(paramEnvKey('LIMIT')).toBe('AUTOFLOW_LIMIT');
    expect(isInjectableParamEnvKey('limit')).toBe(true);
    expect(isInjectableParamEnvKey('LIMIT')).toBe(true);
    // 反证：旧实现里这就是「后者静默覆盖前者」——判定必须独立存在。
    expect(findParamEnvKeyCollisions({ limit: 1, LIMIT: 2 })).toEqual([
      { envKey: 'AUTOFLOW_LIMIT', keys: ['LIMIT', 'limit'] },
    ]);
  });

  it('② 协议段自述的规则与实现同形（rule/statusCode/reasonCode 逐项对账）', () => {
    expect(SECTION.rule).toBe('reject-case-fold-collision');
    expect(SECTION.onCollision).toBe('reject');
    expect(SECTION.statusCode).toBe(400);
    expect(SECTION.collisionScope).toBe('injectable-keys-only');
    expect(SECTION.reasonCode).toBe(PARAM_ENV_KEY_COLLISION_REASON);
    // 文案模板里的占位符必须在真实文案里出现（防止有人改了函数却忘了协议段，
    // 或反之——模板是两端「同一条文案」的书面声明）。
    expect(SECTION.messageTemplate).toContain(`reason=${PARAM_ENV_KEY_COLLISION_REASON}`);
    expect(SECTION.messageTemplate).toContain('<ENV_KEY> ← ');
  });

  it('② 向量扫描面非空，且拒绝/放行两侧都有样本（防永真）', () => {
    expect(SECTION.vectors.length).toBeGreaterThanOrEqual(8);
    expect(SECTION.vectors.filter((v) => v.expectError !== null).length).toBeGreaterThanOrEqual(3);
    expect(SECTION.vectors.filter((v) => v.expectError === null).length).toBeGreaterThanOrEqual(3);
  });

  it.each(SECTION.vectors.map((v) => [v.name, v] as const))(
    '② 向量「%s」对真实实现逐条成立',
    (_name, vec) => {
      const collisions = findParamEnvKeyCollisions(vec.params);
      expect(collisions).toEqual(vec.expectCollisions);
      if (vec.expectError === null) {
        expect(collisions).toEqual([]);
        return;
      }
      // 逐字节相等：python 侧的同一向量断言的是同一串（两端文案不许漂移）。
      expect(describeParamEnvKeyCollisions(collisions)).toBe(vec.expectError);
      // 可读性硬要求：文案必须点名冲突的两个键与最终 env 名（否则运维只知道
      // 「有冲突」却不知道该删哪个）。
      for (const c of collisions) {
        expect(vec.expectError).toContain(c.envKey);
        for (const k of c.keys) expect(vec.expectError).toContain(k);
      }
    },
  );

  it('③ 不扩大拒绝面：折叠后不冲突的大小写不同键仍全部合法', () => {
    // 混合大小写、数字开头、下划线——只要折叠后不同名就不该被这条规则拦。
    const params = {
      Mode: 'a',
      mode_id: 'b',
      '1ST': 'c',
      REGION: 'eu',
      region2: 'us',
    };
    expect(findParamEnvKeyCollisions(params)).toEqual([]);
    // 逐个键的注入形态仍然合法（与 P2-2 键名闸一致）。
    for (const k of Object.keys(params)) {
      expect(isInjectableParamEnvKey(k)).toBe(true);
      expect(paramEnvKey(k)).toMatch(/^AUTOFLOW_[A-Z0-9_]{1,64}$/);
    }
  });

  it('③ 键名闸与冲突判定分工：非法键 skip-and-warn，不参与冲突分析', () => {
    // 两个非法键折叠成同一个名字也不该拒——它们本来就不会被注入。
    expect(findParamEnvKeyCollisions({ 'A=B': 1, 'a=b': 2 })).toEqual([]);
    // 混进非法键不得掩盖真实冲突，也不得把非法键写进文案。
    const mixed = findParamEnvKeyCollisions({ limit: 1, LIMIT: 2, 'A=B': 3 });
    expect(mixed).toEqual([{ envKey: 'AUTOFLOW_LIMIT', keys: ['LIMIT', 'limit'] }]);
    expect(describeParamEnvKeyCollisions(mixed)).not.toContain('A=B');
  });

  it('③ 末尾换行不得绕过键名闸（与 python fullmatch 口径对齐）', () => {
    // Python 的 `$` 会在末尾换行前匹配，node 的 JS `$` 不会——若两端不统一，
    // 同一载荷会一边接受一边拒绝（EXEC-07 残差 3）。这里钉住 node 侧更严格的
    // 判定，且带换行的键不参与折叠冲突分析（它本来就不会被注入）。
    expect(isInjectableParamEnvKey('LIMIT\n')).toBe(false);
    expect(isInjectableParamEnvKey('LIMIT')).toBe(true);
    expect(findParamEnvKeyCollisions({ 'LIMIT\n': 1, limit: 2 })).toEqual([]);
  });

  it('兜底：非对象/空/null 一律无冲突（不因畸形载荷抛错）', () => {
    expect(findParamEnvKeyCollisions(null)).toEqual([]);
    expect(findParamEnvKeyCollisions(undefined)).toEqual([]);
    expect(findParamEnvKeyCollisions({})).toEqual([]);
    expect(findParamEnvKeyCollisions([] as unknown as Record<string, unknown>)).toEqual([]);
  });

  it('排序口径确定（按最终 env 名 + 组内 ASCII 序），两端文案才可能逐字节相等', () => {
    const collisions = findParamEnvKeyCollisions({
      token: 'a',
      TOKEN: 'b',
      limit: 1,
      LIMIT: 2,
    });
    expect(collisions.map((c) => c.envKey)).toEqual(['AUTOFLOW_LIMIT', 'AUTOFLOW_TOKEN']);
    expect(collisions[1].keys).toEqual(['TOKEN', 'token']);
  });

  it('既有注入口径不受影响（串/非串序列化与类型化通道原样）', () => {
    // 防回归：本轮只加冲突判定，不动 A-11R 的注入口径。
    expect(serializeParamEnvValue('欧盟')).toBe('欧盟');
    expect(serializeParamEnvValue(true)).toBe('true');
    expect(PARAMS_JSON_ENV_KEY).toBe('AUTOFLOW_PARAMS_JSON');
  });
});
