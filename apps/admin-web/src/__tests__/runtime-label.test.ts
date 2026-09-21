/**
 * D-P2-02a（设计审计 2026-09-22 分片A）：runtimeLabel 纯函数。
 *
 * 任务列表「运行时」列此前直出 `python / node / shell` 裸值。此处收敛为
 * 唯一事实源 utils/runtime-label.ts，与 trigger-label.ts / failure-reason-label.ts
 * 同范式：已知取值查表走 i18n key，未知值回退原始 token（保留可诊断信息）。
 */
import { describe, expect, it } from 'vitest';
import zh from '../locales/zh';
import en from '../locales/en';
import { runtimeLabel, RUNTIME_T_KEYS } from '../utils/runtime-label';

/** 恒等 t：断言「查表命中了哪个 key」，而不是文案本身。 */
const identity = (k: string) => k;

describe('D-P2-02a: runtimeLabel 已知取值查表、未知取值回退原始 token', () => {
  it('三个已知 runtime 都映射到 i18n key', () => {
    for (const v of ['python', 'node', 'shell']) {
      expect(runtimeLabel(v, identity)).toBe(RUNTIME_T_KEYS[v]);
      expect(RUNTIME_T_KEYS[v]).toBeTruthy();
    }
  });

  it('未知 runtime 回退原始 token（不显示「未知」，保留可诊断信息）', () => {
    expect(runtimeLabel('java', identity)).toBe('java');
    expect(runtimeLabel('some_new_runtime', identity)).toBe('some_new_runtime');
  });

  it('空值返回空串，交由调用方决定占位符', () => {
    expect(runtimeLabel(null, identity)).toBe('');
    expect(runtimeLabel(undefined, identity)).toBe('');
    expect(runtimeLabel('', identity)).toBe('');
  });

  it('每个映射到的 i18n key 在 zh/en 两套词条里都真实存在', () => {
    const zhDict = zh as Record<string, string>;
    const enDict = en as Record<string, string>;
    const keys = Object.values(RUNTIME_T_KEYS);
    expect(keys.length).toBeGreaterThanOrEqual(3); // 有齿：映射表不能被清空
    for (const k of keys) {
      expect(zhDict[k], `${k} 缺 zh 词条`).toBeTruthy();
      expect(enDict[k], `${k} 缺 en 词条`).toBeTruthy();
    }
  });
});
