/**
 * R82：`StateError` 必须与 toast 走**同一条**错误码本地化链路。
 *
 * ## 缺陷（R81 真 UI 验收时发现）
 *
 * 同一份 SSRF 拒绝响应，**toast 是中文**（`client.ts` 走 `translateByErrorCode`），
 * 而**页面级错误面板显示服务端单语言兜底**（英文 "URL host is on the deny list"）——
 * 因为 `StateError` 只读 `error.message`，从不看 `errorCode`。全仓 24 处调用方
 * 都受影响：任何带 `errorCode` 的失败，在这些面板上显示的都是服务端那一刻写死的
 * 语言，而不是用户选的界面语言。
 *
 * ## 本文件钉住的三件事
 *
 * ① **本地化**：带 `errorCode` + `params.host` 的 error ⇒ 面板渲染**当前语言**的
 *    `err.<CODE>` 文案，且 `{{host}}` 被插值；**不得**出现服务端兜底 message。
 * ② **回退保护（防空白）**：无 `errorCode`、或码存在但字典没有该词条 ⇒ 仍然渲染
 *    `error.message`。绝不因为「取不到翻译」而把面板变空。
 * ③ **未知形态**：既不是 Error 也没有 message 的值 ⇒ 仍有兜底文案。
 *
 * ②③ 是这次修复最容易弄坏的地方：只加 `translateByErrorCode` 而删掉旧的回退，
 * 未知错误就会变成空白面板——比显示英文更糟。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import StateError from '../components/StateError';

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
import { setLanguage } from '../i18n';

/** 造一个「axios 拦截器 reject 出去」的对象形态：`err.response.data` 被原样抛出。 */
const apiErrBody = (data: Record<string, unknown>) => data;

/** 造一个真 axios Error（带 response.data）。 */
function axiosError(data: Record<string, unknown>): Error {
  const e = new Error('Request failed with status code 400');
  (e as unknown as { response: { data: unknown } }).response = { data };
  return e;
}

beforeEach(async () => {
  cleanup();
  await setLanguage('zh');
});

afterEach(() => {
  cleanup();
});

describe('R82 — StateError 按 errorCode 本地化（与 toast 同链路）', () => {
  it('【核心】带 errorCode 的对象形态：渲染本地化文案 + host 插值，不显示服务端 message', () => {
    render(
      <StateError
        error={apiErrBody({
          code: 400,
          errorCode: 'SSRF_HOST_DENIED',
          params: { host: '10.0.0.9' },
          message: 'URL host is on the deny list', // 服务端单语言兜底（英文）
        })}
      />,
    );

    const panel = screen.getByTestId('state-error');
    // ① 本地化文案（当前语言 = zh）
    expect(panel.textContent).toContain('URL host 10.0.0.9 在拒绝名单内');
    // ② 插值生效
    expect(panel.textContent).toContain('10.0.0.9');
    // ③ 不得再把服务端单语言兜底摆给用户
    expect(panel.textContent).not.toContain('URL host is on the deny list');
  });

  it('【核心】带 response.data.errorCode 的 axios Error 形态：同样本地化', () => {
    render(
      <StateError
        error={axiosError({
          code: 400,
          errorCode: 'SSRF_HOST_DENIED_PINNED',
          params: { host: '169.254.169.254' },
          message: 'URL host is on the deny list',
        })}
      />,
    );

    const panel = screen.getByTestId('state-error');
    expect(panel.textContent).toContain('169.254.169.254');
    expect(panel.textContent).toContain('在拒绝名单内');
    expect(panel.textContent).toContain('已拒绝对外请求');
    expect(panel.textContent).not.toContain('URL host is on the deny list');
  });

  it('【回退保护】无 errorCode ⇒ 仍渲染 error.message（不许空白）', () => {
    render(<StateError error={apiErrBody({ message: '普通失败原因' })} />);

    expect(screen.getByTestId('state-error').textContent).toContain('普通失败原因');
  });

  it('【回退保护】码存在但字典无词条（未知码）⇒ 回落 message，且不渲染裸 key', () => {
    render(
      <StateError
        error={apiErrBody({ errorCode: 'BRAND_NEW_CODE_FROM_BACKEND', message: '后端新码兜底文案' })}
      />,
    );

    const text = screen.getByTestId('state-error').textContent ?? '';
    expect(text).toContain('后端新码兜底文案');
    expect(text).not.toContain('err.BRAND_NEW_CODE_FROM_BACKEND');
  });

  it('【回退保护】Error 实例无 response ⇒ 仍渲染 error.message', () => {
    render(<StateError error={new Error('网络断了')} />);

    expect(screen.getByTestId('state-error').textContent).toContain('网络断了');
  });

  it('【回退保护】无 message 的未知形态 ⇒ 仍有兜底文案（非空白）', () => {
    render(<StateError error={{ weird: true }} />);

    const text = screen.getByTestId('state-error').textContent ?? '';
    expect(text.trim().length).toBeGreaterThan(0);
    // 兜底 key 的文案（zh）
    expect(text).toContain('请求失败');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R82 · 调用方抽查（页面级，验证修复对**真实调用方**生效，而不只是组件孤立可用）
// ─────────────────────────────────────────────────────────────────────────────
import { vi } from 'vitest';
import { render as rtlRender, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    list: vi.fn(),
    allExecutions: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    trigger: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    batchTrigger: vi.fn(),
    batchPause: vi.fn(),
    batchResume: vi.fn(),
    batchDelete: vi.fn(),
  },
}));

import { tasksApi } from '../api/tasks';
import TaskListPage from '../pages/TaskListPage';

describe('R82 — 真实调用方（TaskListPage）也把码翻成当前语言', () => {
  it('列表请求以 SSRF 错误码失败 ⇒ 页内错误块显示中文文案（与 toast 一致）', async () => {
    const mockedTasks = vi.mocked(tasksApi, true);
    mockedTasks.list.mockRejectedValue({
      code: 400,
      errorCode: 'SSRF_HOST_DENIED',
      params: { host: '10.0.0.9' },
      message: 'URL host is on the deny list',
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rtlRender(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <TaskListPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const panel = await waitFor(() => screen.getByTestId('state-error'));
    expect(panel.textContent).toContain('URL host 10.0.0.9 在拒绝名单内');
    expect(panel.textContent).not.toContain('URL host is on the deny list');
  });
});
