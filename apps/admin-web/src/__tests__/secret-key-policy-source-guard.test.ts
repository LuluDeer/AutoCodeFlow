/**
 * F-7（UIUX 审计 P2-6）：secrets 键名规则**双侧源码守卫**。
 *
 * utils/secretKeyPolicy.ts（前端真值源）逐字镜像后端
 * apps/admin-api/src/modules/task/dto/secret-key-map.constraint.ts 的
 * SAFE_SECRET_NAME_RE / RESERVED_SECRET_NAMES / 前缀禁用三件套。
 *
 * 与 time-format-source-guard / check-password-policy-sync.mjs 同思路：
 * 一致性纪律不靠肉眼比对字面量——直接从两侧源码抽出正则与保留名清单逐项
 * 核验（落在 vitest 门禁内），任一侧漂移（加保留名、改正则、改前缀）立即变红，
 * 而不是让前后端校验在运行时悄悄分叉（用户被「前端放行、后端 400」打脸）。
 *
 * admin-api 不在 admin-web 的依赖图里，故只做**源码级**比对（不 import）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RESERVED_SECRET_NAMES,
  SECRET_KEY_NAME_RE,
  SECRET_KEY_PROBLEM_T_KEYS,
  describeSecretKeyProblemKind,
} from '../utils/secretKeyPolicy';

/** 后端约束源（admin-web/src → admin-api/src 的仓库相对路径） */
const BACKEND_CONSTRAINT = join(
  __dirname,
  '../../../admin-api/src/modules/task/dto/secret-key-map.constraint.ts',
);

/** 从后端源码抽出 SAFE_SECRET_NAME_RE 的字面量体（去斜杠定界符与旗标） */
function extractBackendRegexBody(source: string): string {
  const m = /const SAFE_SECRET_NAME_RE = \/(.+?)\/[a-z]*;/.exec(source);
  if (!m) throw new Error('后端源码中找不到 SAFE_SECRET_NAME_RE（约束文件被重构？）');
  return m[1];
}

/** 从后端源码抽出 RESERVED_SECRET_NAMES 数组的字符串项 */
function extractBackendReservedNames(source: string): string[] {
  const m = /const RESERVED_SECRET_NAMES = new Set<string>\(\s*\[([\s\S]*?)\]\.map/.exec(source);
  if (!m) throw new Error('后端源码中找不到 RESERVED_SECRET_NAMES（约束文件被重构？）');
  return Array.from(m[1].matchAll(/"([^"]+)"/g), (x) => x[1].toUpperCase()).sort();
}

describe('secret 键名规则双侧源码守卫（admin-web ↔ admin-api）', () => {
  const backend = readFileSync(BACKEND_CONSTRAINT, 'utf-8');

  it('守卫自证：后端约束文件与前端真值源都在预期位置（反永真）', () => {
    expect(backend).toContain('describeSecretKeyProblem');
    expect(backend).toContain('RESERVED_SECRET_NAMES');
  });

  it('命名正则逐字一致（前端镜像 vs 后端 SAFE_SECRET_NAME_RE）', () => {
    expect(SECRET_KEY_NAME_RE.source).toBe(extractBackendRegexBody(backend));
  });

  it('保留名清单同集（大小写归一后逐项比对）', () => {
    const backendNames = extractBackendReservedNames(backend);
    const frontendNames = Array.from(RESERVED_SECRET_NAMES).sort();
    expect(frontendNames).toEqual(backendNames);
  });

  it('前缀禁用两侧一致：AUTOFLOW_ 与 PYTHON（后端 startsWith / 前端同款判定）', () => {
    // 后端源码里的两条 startsWith 判据必须仍然存在
    expect(backend).toContain('startsWith("AUTOFLOW_")');
    expect(backend).toContain('startsWith("PYTHON")');
    // 前端对同一输入给出同分类（AUTOFLOW_ 优先于 PYTHON 的判定序也在后端源码中）
    expect(describeSecretKeyProblemKind('AUTOFLOW_X')).toBe('autoflowPrefix');
    expect(describeSecretKeyProblemKind('PYTHON_X')).toBe('pythonPrefix');
  });

  it('四类问题键 → i18n 词条键映射完整（缺键会渲染裸 key，双语存在性由 lint:i18n 守卫）', () => {
    expect(Object.keys(SECRET_KEY_PROBLEM_T_KEYS).sort()).toEqual(
      ['autoflowPrefix', 'invalidName', 'pythonPrefix', 'reserved'].sort(),
    );
  });
});
