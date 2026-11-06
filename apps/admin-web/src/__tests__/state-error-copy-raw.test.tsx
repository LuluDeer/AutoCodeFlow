/**
 * R83：`StateError` 的「复制」按钮必须**同时**给出本地化文案与服务端原文。
 *
 * ## 为什么不能二选一
 *
 * 受众不同：**用户**要读得懂（本地化），**排障的人**要对得上服务端日志/告警原文。
 * R82 只让面板显示本地化文案、复制也只复制本地化文案 ⇒ 排障时拿不到原文；
 * 反过来只复制原文又回到「英文用户拿到中文/英文混杂」的老问题。
 *
 * ## 本文件钉住的四条
 *
 * ① 有 `errorCode` 且原文与本地化**不同** ⇒ 复制内容**同时**含两段（各出现 1 次）；
 * ② **不重复**：无 `errorCode`（= 本来就只有一份文案）⇒ 该文案计数 **= 1**；
 * ③ **不重复**：原文与本地化相同 ⇒ 计数 **= 1**（不许因为拼接而出现两遍）；
 * ④ 反向验证：去掉「原文」那半 ⇒ ①必红（证明这条断言真的咬得住）。
 *
 * 标记语用 `errorCode`（如 `[SSRF_HOST_DENIED]`）而不是中文字面量「[原始]」：
 * 后者在英文界面下会露出中文，且新增 i18n key 需另行批准；errorCode 是**语言中立**
 * 的机器标识，排障时正是要 grep 的那个东西。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

import StateError from '../components/StateError';
import { setLanguage } from '../i18n';

// jsdom 缺失 antd 依赖的浏览器 API（既有先例 shim）
const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const writeText = vi.fn<(text: string) => Promise<void>>();

/** 统计子串出现次数（用于「不许重复」断言）。 */
const countOf = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

/** 点「复制」并返回写进剪贴板的文本。 */
async function clickCopyAndRead(): Promise<string> {
  writeText.mockClear();
  fireEvent.click(screen.getByRole('button', { name: /复制错误信息/ }));
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  return writeText.mock.calls[0][0];
}

beforeEach(async () => {
  cleanup();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  await setLanguage('zh');
});

afterEach(() => {
  cleanup();
});

describe('R83 — 复制内容 = 本地化文案 + 空行 + 服务端原文', () => {
  it('【核心】有 errorCode：复制内容同时含本地化片段与原文片段（各 1 次）', async () => {
    render(
      <StateError
        error={{
          code: 400,
          errorCode: 'SSRF_HOST_DENIED',
          params: { host: '10.0.0.9' },
          message: 'URL host is on the deny list',
        }}
      />,
    );

    const copied = await clickCopyAndRead();

    // ① 本地化片段在场
    expect(copied).toContain('URL host 10.0.0.9 在拒绝名单内');
    // ② 服务端原文片段在场（排障要的那半）
    expect(copied).toContain('URL host is on the deny list');
    // ③ 两段各出现一次（不许把同一段拼两遍）
    expect(countOf(copied, '在拒绝名单内')).toBe(1);
    expect(countOf(copied, 'URL host is on the deny list')).toBe(1);
    // ④ 两段之间有空行分隔
    expect(copied).toMatch(/在拒绝名单内[^\n]*\n\n/);
  });

  it('【不重复】无 errorCode（无原文可拼）：该文案只出现 1 次', async () => {
    render(<StateError error={{ message: '普通失败原因' }} />);

    const copied = await clickCopyAndRead();
    expect(countOf(copied, '普通失败原因')).toBe(1);
  });

  it('【不重复】原文与本地化相同：只出现 1 次', async () => {
    // 未知码 ⇒ 无翻译 ⇒ 面板文案 = 服务端 message ⇒ 两段相同，不许拼两遍
    render(<StateError error={{ errorCode: 'SOME_UNKNOWN_CODE', message: '服务端唯一文案' }} />);

    const copied = await clickCopyAndRead();
    expect(countOf(copied, '服务端唯一文案')).toBe(1);
  });

  it('【不重复】Error 实例无 response：只出现 1 次', async () => {
    render(<StateError error={new Error('网络断了')} />);

    const copied = await clickCopyAndRead();
    expect(countOf(copied, '网络断了')).toBe(1);
  });

  it('【稳定】同样输入复制两次，内容一致（纯函数、无隐藏状态）', async () => {
    render(
      <StateError
        error={{
          errorCode: 'SSRF_HOST_DENIED_PINNED',
          params: { host: '169.254.169.254' },
          message: 'URL host is on the deny list',
        }}
      />,
    );

    const first = await clickCopyAndRead();
    const second = await clickCopyAndRead();
    expect(second).toBe(first);
  });
});
