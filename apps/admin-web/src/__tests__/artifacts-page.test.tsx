/**
 * P1-3「产物库」页面回归：列表渲染 / 空态 / 错误态重试 / URL 预填筛选。
 *
 * 数据源走 queries 层 hooks（mock），不打真实后端；契约口径：
 * GET /artifacts 返回 paginate 信封（items/total/...），支持 applicationId /
 * taskId / q / from / to / ext 过滤，total 为过滤后真实总数。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ArtifactsPage from '../pages/ArtifactsPage';
import { useAllTasksForNames, useArtifactsIndex, useApplicationsList } from '../api/queries';
import { artifactsApi } from '../api/artifacts';
import { message } from '../utils/toast';
import '../i18n';

vi.mock('../api/queries', () => ({
  useArtifactsIndex: vi.fn(),
  useApplicationsList: vi.fn(),
  useAllTasksForNames: vi.fn(),
}));
vi.mock('../api/artifacts', () => ({
  artifactsApi: {
    listArtifacts: vi.fn(),
    downloadArtifact: vi.fn(),
    fetchBlob: vi.fn(),
  },
}));

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

const ROW = {
  id: 'row-1',
  executionId: 'exec-1234567890abcdef',
  taskId: 't-1',
  applicationId: 'app-1',
  name: 'report.csv',
  size: 2048,
  sha256: 'a'.repeat(64),
  createdAt: '2026-11-15T10:00:00.000Z',
};
const APP = { id: 'app-1', name: '订单应用' };
const TASK = { id: 't-1', name: '订单同步任务' };

const refetch = vi.fn();

/** 后端 paginate 信封（与 PageResult 同形；total 为过滤后真实总数）。 */
const envelope = (rows: typeof ROW[], total = rows.length) => ({
  items: rows,
  total,
  page: 1,
  pageSize: 20,
  totalPages: Math.max(1, Math.ceil(total / 20)),
});

beforeEach(() => {
  refetch.mockReset();
  vi.mocked(useApplicationsList).mockReturnValue({ data: [APP] } as never);
  vi.mocked(useAllTasksForNames).mockReturnValue({ data: { items: [TASK] } } as never);
  vi.mocked(useArtifactsIndex).mockReturnValue({
    data: envelope([ROW]),
    isLoading: false,
    isError: false,
    error: null,
    refetch,
  } as never);
  vi.mocked(artifactsApi.downloadArtifact).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ArtifactsPage 列表渲染', () => {
  it('展示文件名 / 任务 / 应用 / 来源执行链接与大小', async () => {
    render(
      <MemoryRouter initialEntries={['/artifacts']}>
        <ArtifactsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('report.csv')).toBeTruthy();
    expect(screen.getByText('订单同步任务')).toBeTruthy();
    expect(screen.getByText('订单应用')).toBeTruthy();
    // 来源执行短链（前 8 位）
    expect(screen.getByText('#exec-123')).toBeTruthy();
    // 大小格式化
    expect(screen.getByText('2.0 KB')).toBeTruthy();
  });

  it('筛选口径说明可见：已支持关键字/时间范围/类型筛选', async () => {
    render(
      <MemoryRouter initialEntries={['/artifacts']}>
        <ArtifactsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/文件名关键字/)).toBeTruthy();
  });
});

describe('ArtifactsPage 任务名字典全量口径', () => {
  it('名称解析走共享 useAllTasksForNames，不再拉首页 100 条任务', async () => {
    render(
      <MemoryRouter initialEntries={['/artifacts']}>
        <ArtifactsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('订单同步任务')).toBeTruthy();
    expect(useAllTasksForNames).toHaveBeenCalledTimes(1);
  });

  it('跨页任务在任务名聚合口径下显示名称，不回退 UUID', async () => {
    const BEYOND_TASK = { id: 't-beyond-100', name: '跨页任务' };
    const BEYOND_ROW = { ...ROW, id: 'row-2', taskId: BEYOND_TASK.id };
    vi.mocked(useAllTasksForNames).mockReturnValue({
      data: { items: [TASK, BEYOND_TASK] },
    } as never);
    vi.mocked(useArtifactsIndex).mockReturnValue({
      data: envelope([BEYOND_ROW]),
      isLoading: false,
      isError: false,
      error: null,
      refetch,
    } as never);

    render(
      <MemoryRouter initialEntries={['/artifacts']}>
        <ArtifactsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('跨页任务')).toBeTruthy();
    expect(screen.queryByText(BEYOND_TASK.id)).toBeNull();
  });
});

describe('ArtifactsPage 下载反馈', () => {
  it('下载成功只提示成功，不弹错误 toast', async () => {
    const successSpy = vi
      .spyOn(message, 'success')
      .mockImplementation((() => undefined) as never);
    const errorSpy = vi
      .spyOn(message, 'error')
      .mockImplementation((() => undefined) as never);

    render(
      <MemoryRouter initialEntries={['/artifacts']}>
        <ArtifactsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /下载/ }));

    await waitFor(() =>
      expect(artifactsApi.downloadArtifact).toHaveBeenCalledWith(
        ROW.executionId,
        ROW.name,
      ),
    );
    expect(successSpy).toHaveBeenCalledWith('已开始下载');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('client 已打标并弹具体错误时，页面 catch 不再补泛化 toast', async () => {
    const specific = '产物对象已被清理';
    const errorSpy = vi
      .spyOn(message, 'error')
      .mockImplementation((() => undefined) as never);
    // 模拟 client 拦截器已经弹出的那一条具体提示
    message.error(specific, 4);
    vi.mocked(artifactsApi.downloadArtifact).mockRejectedValueOnce({
      __toastedByClient: true,
      message: specific,
      errorCode: 'ARTIFACT_OBJECT_GONE',
    });

    render(
      <MemoryRouter initialEntries={['/artifacts']}>
        <ArtifactsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /下载/ }));

    await waitFor(() =>
      expect(artifactsApi.downloadArtifact).toHaveBeenCalledWith(
        ROW.executionId,
        ROW.name,
      ),
    );
    // 让 reject 的 catch 微任务跑完，再断言没有追加 toast
    await Promise.resolve();
    await Promise.resolve();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(specific, 4);
    expect(errorSpy).not.toHaveBeenCalledWith('产物下载失败');
  });
});

describe('ArtifactsPage 空态', () => {
  it('无产物渲染空态解释，不整页白屏', async () => {
    vi.mocked(useArtifactsIndex).mockReturnValue({
      data: envelope([], 0),
      isLoading: false,
      isError: false,
      error: null,
      refetch,
    } as never);
    render(
      <MemoryRouter initialEntries={['/artifacts']}>
        <ArtifactsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/还没有任何执行产物/)).toBeTruthy();
  });
});

describe('ArtifactsPage 错误态', () => {
  it('接口失败渲染 StateError，重试重新拉取', async () => {
    vi.mocked(useArtifactsIndex).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('网关超时'),
      refetch,
    } as never);
    render(
      <MemoryRouter initialEntries={['/artifacts']}>
        <ArtifactsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('state-error')).toBeTruthy();
    fireEvent.click(screen.getByText('重试'));
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
  });
});

describe('ArtifactsPage URL 预填', () => {
  it('深链 ?taskId=t-1 把 taskId 带入索引查询', async () => {
    render(
      <MemoryRouter initialEntries={['/artifacts?taskId=t-1']}>
        <ArtifactsPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(useArtifactsIndex).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 't-1' }),
      );
    });
  });

  it('深链 ?applicationId=app-1 把 applicationId 带入索引查询', async () => {
    render(
      <MemoryRouter initialEntries={['/artifacts?applicationId=app-1']}>
        <ArtifactsPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(useArtifactsIndex).toHaveBeenCalledWith(
        expect.objectContaining({ applicationId: 'app-1' }),
      );
    });
  });

  it('深链 ?q=report&ext=csv 把关键字与类型带入索引查询', async () => {
    render(
      <MemoryRouter
        initialEntries={['/artifacts?q=report&ext=csv']}
      >
        <ArtifactsPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(useArtifactsIndex).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'report', ext: 'csv' }),
      );
    });
  });

  it('深链 ?from/to 时间闭区间带入索引查询', async () => {
    render(
      <MemoryRouter
        initialEntries={[
          '/artifacts?from=2026-11-01T00:00:00.000Z&to=2026-11-15T23:59:59.999Z',
        ]}
      >
        <ArtifactsPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(useArtifactsIndex).toHaveBeenCalledWith(
        expect.objectContaining({
          from: '2026-11-01T00:00:00.000Z',
          to: '2026-11-15T23:59:59.999Z',
        }),
      );
    });
  });

  it('分页总数读信封真实 total，不靠本页行数推断', async () => {
    vi.mocked(useArtifactsIndex).mockReturnValue({
      data: envelope([ROW], 37),
      isLoading: false,
      isError: false,
      error: null,
      refetch,
    } as never);
    render(
      <MemoryRouter initialEntries={['/artifacts']}>
        <ArtifactsPage />
      </MemoryRouter>,
    );
    // showTotal 文案携带真实过滤后总数 37
    expect(await screen.findByText('共 37 条')).toBeTruthy();
  });
});
