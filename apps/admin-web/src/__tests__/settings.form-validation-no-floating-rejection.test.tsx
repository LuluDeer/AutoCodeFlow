/**
 * 设置区**表单校验失败**不得产生浮空 rejection（Round 2 web-hardening 补面）。
 *
 * ── 缺陷 ────────────────────────────────────────────────────────────────
 * antd 的 `form.validateFields()` 在校验不通过时是 **reject**（一个带
 * `errorFields` 的对象）。三处 `settings/*` 的保存入口此前把它**裸 await**：
 *
 *   · `pages/settings/AiProvidersSettings.tsx` `save()`
 *   · `pages/settings/EventSubscriptionsSettings.tsx` `handleOk()`
 *   · `pages/settings/index.tsx` `handleOk()`（配置编辑弹窗）
 *
 * reject 逃出 `try/catch` ⇒ 变成**浮空 rejection**（floating promise）——
 * 提交了却没人接。仓内的 `[ACF][unhandledRejection]` 上报器（见
 * `src/test-support/unhandled-rejection.ts`）会把它记成一条未处理拒绝；
 * 更实际的后果是：用户填错一个必填项，页面上除了 antd 自己的字段标红
 * 之外，还会留下一条「未处理错误」的噪声，且**这一条错误永远不会被
 * `showApiError` 消费**——即校验失败被混进了「请求失败」的通道。
 *
 * ── 修法（与全仓既有写法一致）──────────────────────────────────────────
 * `TaskFormPage.tsx:620` / `TaskDetailPage.tsx:347` / `settings/index.tsx:655`
 * （AI 配置段）都已有同一约定：**校验错误静默返回**（错误已在 antd 表单上
 * 可见，不必再弹一次），只有真实请求错误才走 `showApiError`。
 * 仓内已有现成判据 `utils/error.ts` 的 `isFormValidationError(err)`
 * （判 `errorFields` 是不是数组），本轮三处统一改用它。
 *
 * ── 本文件钉住的行为（每条都能失败）────────────────────────────────────
 *   ① 校验失败 ⇒ **不发**保存请求（saveProvider / upsert 都没被调用）；
 *   ② 校验失败 ⇒ **不产生浮空 rejection**（断言 unhandledRejection 上报器
 *      没收到东西——这正是缺陷的可观察面）；
 *   ③ 校验失败 ⇒ 不弹 `showApiError`（校验错误不是请求错误；
 *      antd 已在字段上标红，再弹一次是重复打扰）。
 *
 * 断言 ② 的做法：直接监听 `window` 的 `unhandledrejection` 事件——
 * 这是浮空 rejection 在浏览器/jsdom 里**真实**的观测口，比「测试没报错」
 * 强（后者在 `dangerouslyIgnoreUnhandledErrors: true` 的配置下会漏）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import AiProvidersSettings from '../pages/settings/AiProvidersSettings';
import { aiApi } from '../api/ai';
import { showApiError } from '../utils/error';

vi.mock('../api/ai', () => ({
  aiApi: {
    listProviders: vi.fn(),
    saveProvider: vi.fn(),
    deleteProvider: vi.fn(),
    assignRoute: vi.fn(),
  },
}));

vi.mock('../utils/error', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/error')>();
  return { ...actual, showApiError: vi.fn() };
});

vi.mock('../utils/toast', () => ({
  message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

// jsdom 缺 antd 依赖的浏览器 API（既有先例 shim）。
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

const mockedAi = vi.mocked(aiApi, true);

const view = {
  providers: [],
  errors: [],
  routes: {
    analysis: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
    agent: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
    video: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
  },
};

/**
 * 收集浮空 rejection。
 *
 * ⚠️ 观测口选的是 **process** 而不是 window：仓内的上报器
 * `src/test-support/unhandled-rejection.ts` 装在 `process.on('unhandledRejection')`
 * 上（jsdom 里 window 的 `unhandledrejection` 不会为 `void save()` 这种
 * 「被 void 掉但没人接」的 promise 触发——**实测**：window 监听器收到 0 条，
 * process 监听器收到 1 条）。盯错口会让这条断言恒绿 ⇒ 等于没断言。
 */
function captureUnhandledRejections() {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    seen.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  return {
    seen,
    stop: () => process.off('unhandledRejection', onUnhandled),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedAi.listProviders.mockResolvedValue(view as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('表单校验失败不得产生浮空 rejection', () => {
  it('① 校验失败：不发保存请求', async () => {
    render(<AiProvidersSettings />);
    await waitFor(() => expect(mockedAi.listProviders).toHaveBeenCalled());

    // 打开「接入模型」弹窗（新增态：id/baseUrl/model 为空 ⇒ 必填校验必然失败）
    const addBtn = screen.getByRole('button', { name: /接入模型|添加/ });
    fireEvent.click(addBtn);
    await waitFor(() => expect(document.querySelector('.ant-modal')).toBeTruthy());

    // 点弹窗确定（校验失败 ⇒ reject）
    const footerBtns = Array.from(
      document.querySelectorAll('.ant-modal-footer .ant-btn'),
    ) as HTMLElement[];
    fireEvent.click(footerBtns[footerBtns.length - 1]);

    // 等足够久，让「若有浮空 rejection」有机会冒头
    await new Promise((r) => setTimeout(r, 50));

    expect(mockedAi.saveProvider).not.toHaveBeenCalled();
  });

  it('② 校验失败：不产生浮空 rejection（process unhandledRejection 无捕获）', async () => {
    const cap = captureUnhandledRejections();
    try {
      render(<AiProvidersSettings />);
      await waitFor(() => expect(mockedAi.listProviders).toHaveBeenCalled());

      const addBtn = screen.getByRole('button', { name: /接入模型|添加/ });
      fireEvent.click(addBtn);
      await waitFor(() => expect(document.querySelector('.ant-modal')).toBeTruthy());

      const footerBtns = Array.from(
        document.querySelectorAll('.ant-modal-footer .ant-btn'),
      ) as HTMLElement[];
      fireEvent.click(footerBtns[footerBtns.length - 1]);

      await new Promise((r) => setTimeout(r, 100));

      // 关键断言：没有任何浮空 rejection 被派发
      expect(cap.seen).toEqual([]);
    } finally {
      cap.stop();
    }
  });

  it('③ 校验失败：不弹 showApiError（校验错误不是请求错误）', async () => {
    render(<AiProvidersSettings />);
    await waitFor(() => expect(mockedAi.listProviders).toHaveBeenCalled());

    const addBtn = screen.getByRole('button', { name: /接入模型|添加/ });
    fireEvent.click(addBtn);
    await waitFor(() => expect(document.querySelector('.ant-modal')).toBeTruthy());

    const footerBtns = Array.from(
      document.querySelectorAll('.ant-modal-footer .ant-btn'),
    ) as HTMLElement[];
    fireEvent.click(footerBtns[footerBtns.length - 1]);

    await new Promise((r) => setTimeout(r, 50));

    expect(showApiError).not.toHaveBeenCalled();
  });
});
