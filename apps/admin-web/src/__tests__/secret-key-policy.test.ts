/**
 * F-7（UIUX 审计 P2-6）：secrets 键名镜像校验单测。
 *
 * utils/secretKeyPolicy.ts 是后端 IsSecretKeyMapConstraint（secret-key-map.constraint.ts）
 * 三条规则的前端真值源。本文件按后端 describeSecretKeyProblem 的判定序逐类覆盖；
 * 双侧源码一致性由 secret-key-policy-source-guard.test.ts 钉住（改任一侧必须同步）。
 */
import { describe, it, expect } from 'vitest';
import {
  describeSecretKeyProblemKind,
  findInvalidSecretKeys,
  SECRET_KEY_NAME_RE,
  RESERVED_SECRET_NAMES,
  SECRET_KEY_PROBLEM_T_KEYS,
} from '../utils/secretKeyPolicy';

describe('describeSecretKeyProblemKind（与后端 describeSecretKeyProblem 同判定序）', () => {
  it('合法键名放行：字母/数字/下划线/首字符下划线', () => {
    expect(describeSecretKeyProblemKind('FEISHU_APP_ID')).toBeNull();
    expect(describeSecretKeyProblemKind('my_key_2')).toBeNull();
    expect(describeSecretKeyProblemKind('_PRIVATE')).toBeNull();
  });

  it('非法形状 → invalidName：连字符/点/空格/空串/首字符数字', () => {
    expect(describeSecretKeyProblemKind('my-key')).toBe('invalidName');
    expect(describeSecretKeyProblemKind('A.B')).toBe('invalidName');
    expect(describeSecretKeyProblemKind('HAS SPACE')).toBe('invalidName');
    expect(describeSecretKeyProblemKind('1PASSWORD')).toBe('invalidName');
    expect(describeSecretKeyProblemKind('')).toBe('invalidName');
  });

  it('保留名（大小写不敏感，镜像后端 upper 比对）→ reserved', () => {
    expect(describeSecretKeyProblemKind('PATH')).toBe('reserved');
    expect(describeSecretKeyProblemKind('Path')).toBe('reserved');
    expect(describeSecretKeyProblemKind('HOME')).toBe('reserved');
    expect(describeSecretKeyProblemKind('EXECUTOR_SHARED_TOKEN')).toBe('reserved');
    expect(describeSecretKeyProblemKind('TASK_ID')).toBe('reserved');
  });

  it('AUTOFLOW_ 前缀 → autoflowPrefix（params 命名空间）', () => {
    expect(describeSecretKeyProblemKind('AUTOFLOW_TOKEN')).toBe('autoflowPrefix');
    expect(describeSecretKeyProblemKind('autoflow_x')).toBe('autoflowPrefix');
  });

  it('PYTHON 前缀 → pythonPrefix（解释器行为开关）', () => {
    expect(describeSecretKeyProblemKind('PYTHON_TOKEN')).toBe('pythonPrefix');
    expect(describeSecretKeyProblemKind('PYTHONIOENCODING')).toBe('pythonPrefix');
    expect(describeSecretKeyProblemKind('pythonpath')).toBe('pythonPrefix');
  });

  it('判定序：先形状再保留名再前缀（与后端一致）', () => {
    // 非法形状优先于保留名（不会误报 reserved）
    expect(describeSecretKeyProblemKind('PA TH')).toBe('invalidName');
  });

  it('保留名清单非空且含执行器密钥三件套（防手滑清空）', () => {
    expect(RESERVED_SECRET_NAMES.size).toBeGreaterThanOrEqual(25);
    expect(RESERVED_SECRET_NAMES.has('EXECUTOR_SECRET')).toBe(true);
    expect(RESERVED_SECRET_NAMES.has('EXECUTION_CALLBACK_SECRET')).toBe(true);
    expect(SECRET_KEY_NAME_RE.source).toBe('^[A-Za-z_][A-Za-z0-9_]*$');
  });

  it('四类问题都映射到已登记的 i18n 键（双语词条存在性由 lint:i18n 守卫）', () => {
    for (const key of Object.values(SECRET_KEY_PROBLEM_T_KEYS)) {
      expect(key.startsWith('secretsEditor.keyError.')).toBe(true);
    }
  });
});

describe('findInvalidSecretKeys（提交载荷闸门，与后端同键集合口径）', () => {
  it('null/undefined/非对象 → 空列表（后端 @IsOptional 同语义）', () => {
    expect(findInvalidSecretKeys(null)).toEqual([]);
    expect(findInvalidSecretKeys(undefined)).toEqual([]);
    expect(findInvalidSecretKeys('oops' as never)).toEqual([]);
  });

  it('合法载荷 → 空列表', () => {
    expect(findInvalidSecretKeys({ FEISHU_APP_ID: 'v', OLD_KEY: null })).toEqual([]);
  });

  it('逐键判定：null 叶子（删除表达）的键同样参与校验（镜像后端 Object.keys 全扫）', () => {
    const problems = findInvalidSecretKeys({ GOOD: 'v', 'bad-key': 'v2', GONE: null });
    expect(problems).toEqual([{ key: 'bad-key', problem: 'invalidName' }]);
  });

  it('混合问题全数返回（一次保存可看到全部问题键）', () => {
    const problems = findInvalidSecretKeys({
      'my-key': 'a',
      PATH: 'b',
      AUTOFLOW_X: 'c',
      PYTHONPATH: 'd',
    });
    expect(problems.map((p) => p.problem)).toEqual([
      'invalidName',
      'reserved',
      'autoflowPrefix',
      'pythonPrefix',
    ]);
  });
});
