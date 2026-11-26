/**
 * ADR-044 步 2：前端防御性过滤（被中台 deny 的 provider 直接消失）。
 *
 * 覆盖四个契约点：三用途移除、deniedForUse 双保险、denied 缺席控制组、
 * id trim+lowercase 归一化。纯函数级（内存替身），不渲染页面。
 */
import { describe, expect, it } from 'vitest';
import type { AiProviderView, AiPurpose } from '../api/ai';
import { filterProvidersForPurpose } from '../pages/settings/ai-provider-filter';

/** 主控生成物尚未落盘时的本地兼容类型（字段缺席时行为不变）。 */
type DeniedCapableProvider = AiProviderView & { deniedForUse?: boolean };

const row = (id: string, over: Partial<DeniedCapableProvider> = {}): DeniedCapableProvider => ({
  id,
  label: id,
  transport: 'openai',
  baseUrl: 'https://example.invalid/v1',
  model: 'model-x',
  maxTokens: 1024,
  timeoutMs: 60_000,
  supportsVideo: true,
  enabled: true,
  hasApiKey: true,
  legacy: false,
  ...over,
});

const ids = (
  purpose: AiPurpose,
  providers: AiProviderView[],
  denied?: readonly string[],
): string[] => filterProvidersForPurpose(purpose, providers, denied).map((p) => p.id);

describe('filterProvidersForPurpose —— deny 的 provider 从下拉与表格消失', () => {
  it('denied=["X"]：analysis/agent/video 三种结果都不含 X（移除，不是置灰标记）', () => {
    const providers: AiProviderView[] = [row('x'), row('other')];
    for (const purpose of ['analysis', 'agent', 'video'] as const) {
      const result = filterProvidersForPurpose(purpose, providers, ['X']);
      expect(result.map((p) => p.id)).toEqual(['other']);
      expect(result.some((p) => p.id.trim().toLowerCase() === 'x')).toBe(false);
      expect(result.some((p) => (p as DeniedCapableProvider).deniedForUse === true)).toBe(false);
    }
  });

  it('deniedForUse=true 的条目也被移除（denied 名单缺席时同样生效）', () => {
    const providers: AiProviderView[] = [row('flag', { deniedForUse: true }), row('keep')];
    expect(ids('analysis', providers)).toEqual(['keep']);
    expect(ids('agent', providers)).toEqual(['keep']);
    expect(ids('video', providers)).toEqual(['keep']);
  });

  it('控制组：denied 缺席且 deniedForUse 字段缺席时，输出与既有用例逐字一致', () => {
    const qwenVl = row('qwen-vl');
    const cheap = row('cheap', { supportsVideo: false });
    const local = row('local', { transport: 'ollama', supportsVideo: false });
    const off = row('off', { enabled: false });
    const providers: AiProviderView[] = [qwenVl, cheap, local, off];

    // 与 sop-from-video.test.tsx 既有断言一致（顺序、对象内容、引用均不变）。
    expect(filterProvidersForPurpose('video', providers)).toEqual([qwenVl]);
    expect(filterProvidersForPurpose('agent', providers)).toEqual([qwenVl, cheap]);
    expect(filterProvidersForPurpose('analysis', providers)).toEqual([qwenVl, cheap, local]);
    expect(filterProvidersForPurpose('analysis', providers)[0]).toBe(qwenVl);
  });

  it('id 归一化：trim + lowercase 双向命中', () => {
    expect(ids('analysis', [row(' x '), row('keep')], ['X'])).toEqual(['keep']);
    expect(ids('analysis', [row('X'), row('keep')], [' x '])).toEqual(['keep']);
    expect(ids('analysis', [row('MiXeD'), row('keep')], ['mIxEd'])).toEqual(['keep']);
  });
});
