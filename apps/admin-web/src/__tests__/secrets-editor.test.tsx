/**
 * SEC-02 续（生产故障）：凭据提交的两道闸门。
 *
 * ① `applySecretsPayload`（纯函数）：掩码永不出浏览器；
 * ② `SecretsEditor` 的外发语义：只发"本次变更"，已保存的键缺省 = 后端保留。
 *
 * 为什么这两条必须一起钉住：后端读路径对每个凭据叶子回 `******`，而控制台要
 * 显示既有键就必然持有掩码。一旦掩码进请求体，后端会把字面量 `******` 当成
 * 真实凭据落库——真实值不可逆损毁，而界面上的键还在、任务却报「缺少凭据」。
 * 这正是本次生产故障最难查的形态（配置"明明存在"）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import SecretsEditor, { SECRET_MASK } from '../components/SecretsEditor';
import { applySecretsPayload } from '../pages/executor-mode';

afterEach(() => {
  cleanup();
});

// antd 在 jsdom 下的最小 polyfill（同 params-editor.test.tsx 惯例）
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
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe('applySecretsPayload（掩码闸门）', () => {
  it('未触碰（secrets 缺省）→ 整个键被删除（后端一个 secret 都不碰）', () => {
    const payload = applySecretsPayload({ name: 't' });
    expect('secrets' in payload).toBe(false);
  });

  it('显式 null → 原样保留（整体清空信号）', () => {
    expect(applySecretsPayload({ secrets: null }).secrets).toBeNull();
  });

  it('掩码叶子被剔除（永不发 ****** 给后端）', () => {
    const payload = applySecretsPayload({
      secrets: { FEISHU_APP_ID: SECRET_MASK, FEISHU_APP_SECRET: 'real-secret' },
    });
    expect(payload.secrets).toEqual({ FEISHU_APP_SECRET: 'real-secret' });
    expect(JSON.stringify(payload)).not.toContain(SECRET_MASK);
  });

  it('全部是掩码 → 提交空对象（合并语义下 = 不改任何键，而不是清空）', () => {
    const payload = applySecretsPayload({
      secrets: { A: SECRET_MASK, B: SECRET_MASK },
    });
    expect(payload.secrets).toEqual({});
  });

  it('null 叶子保留（显式删除某个键的表达）', () => {
    const payload = applySecretsPayload({ secrets: { OLD: null, NEW: 'v' } });
    expect(payload.secrets).toEqual({ OLD: null, NEW: 'v' });
  });

  it('非对象形状不发出去（后端 @IsObject 会 400，属凭据无关的噪声）', () => {
    expect('secrets' in applySecretsPayload({ secrets: 'oops' })).toBe(false);
    expect('secrets' in applySecretsPayload({ secrets: ['a'] })).toBe(false);
  });

  it('不触碰其它字段（纯减法：只动 secrets）', () => {
    const payload = applySecretsPayload({
      name: 't',
      params: { a: 1 },
      secrets: { A: SECRET_MASK },
    });
    expect(payload.name).toBe('t');
    expect(payload.params).toEqual({ a: 1 });
  });
});

/** 受控 harness：捕获组件外发值。 */
function Harness({
  value,
  existing,
  onEmit,
}: {
  value?: Record<string, string | null> | null;
  existing?: Record<string, string> | null;
  onEmit: (v: unknown) => void;
}) {
  return <SecretsEditor value={value} onChange={onEmit} existing={existing} />;
}

const keyInputs = () =>
  Array.from(document.querySelectorAll('input.ant-input')).filter(
    i => !(i as HTMLInputElement).type || (i as HTMLInputElement).type === 'text',
  ) as HTMLInputElement[];

describe('SecretsEditor 外发语义（与后端逐键合并契约对齐）', () => {
  it('显示既有凭据的键名（用户必须看得见已配了什么）', () => {
    render(
      <Harness existing={{ FEISHU_APP_ID: SECRET_MASK }} onEmit={() => undefined} />,
    );
    expect(screen.getByDisplayValue('FEISHU_APP_ID')).toBeTruthy();
  });

  it('用户没动任何行 → 不外发（onChange 收 undefined，调用方省略键）', () => {
    const onEmit = vi.fn();
    render(
      <Harness existing={{ FEISHU_APP_ID: SECRET_MASK }} onEmit={onEmit} />,
    );
    // 没有交互 → 一次都不该外发
    expect(onEmit).not.toHaveBeenCalled();
  });

  it('新增一个键 → 只发新键，既有键不出现在载荷里（后端保留它）', () => {
    const onEmit = vi.fn();
    render(
      <Harness existing={{ FEISHU_APP_ID: SECRET_MASK }} onEmit={onEmit} />,
    );
    fireEvent.click(screen.getByText(/添加凭据|Add credential/));
    // 最后一行（新增行）填键与值
    const keys = keyInputs();
    const newKey = keys[keys.length - 1];
    fireEvent.change(newKey, { target: { value: 'NEW_TOKEN' } });
    const passwords = Array.from(
      document.querySelectorAll('input[type="password"]'),
    ) as HTMLInputElement[];
    fireEvent.change(passwords[passwords.length - 1], {
      target: { value: 'tok-123' },
    });

    const emitted = onEmit.mock.calls[onEmit.mock.calls.length - 1][0] as Record<
      string,
      string | null
    >;
    expect(emitted).toEqual({ NEW_TOKEN: 'tok-123' });
    // 既有键既不是掩码也不是 null —— 缺省即"保留"
    expect('FEISHU_APP_ID' in emitted).toBe(false);
  });

  it('删掉既有键 → 显式发 null（合并语义下"删除"必须显式表达）', () => {
    const onEmit = vi.fn();
    render(
      <Harness existing={{ FEISHU_APP_ID: SECRET_MASK }} onEmit={onEmit} />,
    );
    fireEvent.click(screen.getByLabelText(/删除该凭据|Remove this credential/));
    const emitted = onEmit.mock.calls[onEmit.mock.calls.length - 1][0] as Record<
      string,
      string | null
    >;
    expect(emitted).toEqual({ FEISHU_APP_ID: null });
  });

  it('清空全部 → 发 null（不是 {}：空对象在合并语义下什么都不改）', () => {
    const onEmit = vi.fn();
    render(
      <Harness existing={{ FEISHU_APP_ID: SECRET_MASK }} onEmit={onEmit} />,
    );
    fireEvent.click(screen.getByText(/清空全部凭据|Clear all credentials/));
    expect(onEmit).toHaveBeenCalledWith(null);
  });

  it('既有键重新输入 → 该键发新值，且不再带掩码', () => {
    const onEmit = vi.fn();
    render(
      <Harness existing={{ FEISHU_APP_ID: SECRET_MASK }} onEmit={onEmit} />,
    );
    const pw = document.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    fireEvent.change(pw, { target: { value: 'cli_rotated' } });
    const emitted = onEmit.mock.calls[onEmit.mock.calls.length - 1][0] as Record<
      string,
      string | null
    >;
    expect(emitted).toEqual({ FEISHU_APP_ID: 'cli_rotated' });
    expect(JSON.stringify(emitted)).not.toContain(SECRET_MASK);
  });

  it('既有键改名 → 原键发 null + 新键发值（不留下一把仍有效的旧凭据）', () => {
    const onEmit = vi.fn();
    render(
      <Harness existing={{ FEISHU_APP_ID: SECRET_MASK }} onEmit={onEmit} />,
    );
    const keyInput = screen.getByDisplayValue('FEISHU_APP_ID');
    fireEvent.change(keyInput, { target: { value: 'FEISHU_APP_ID_V2' } });
    const pw = document.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    fireEvent.change(pw, { target: { value: 'cli_v2' } });
    const emitted = onEmit.mock.calls[onEmit.mock.calls.length - 1][0] as Record<
      string,
      string | null
    >;
    expect(emitted.FEISHU_APP_ID).toBeNull();
    expect(emitted.FEISHU_APP_ID_V2).toBe('cli_v2');
  });
});
