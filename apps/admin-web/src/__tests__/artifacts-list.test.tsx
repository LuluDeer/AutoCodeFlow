/**
 * FEAT-05（UI 半场）ArtifactsList 组件测试：
 *  1) 传入 artifacts 清单 → 渲染 name / 人类可读 size / sha 前缀 / 下载入口；
 *  2) 点击某行下载 → 调用 api 层 downloadArtifact(execId, name)（blob 下载逻辑在 api 层，此处只断言接线）；
 *  3) 空清单（传入 []）→ 整段不渲染；
 *  4) 未传 artifacts 且给定 execId → 组件自 listArtifacts 拉取后渲染。
 *
 * 说明：antd 对两字中文按钮会插入排版空格（渲染为「下 载」），
 * 故下载按钮统一用 aria-label + getByLabelText 精确匹配（对齐 settings.history-rollback 注2）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ArtifactsList from '../components/ArtifactsList';
import { artifactsApi } from '../api/artifacts';
import { formatArtifactSize } from '../utils/artifactSize';

vi.mock('../api/artifacts', () => ({
  artifactsApi: {
    listArtifacts: vi.fn(),
    downloadArtifact: vi.fn(),
  },
}));

// jsdom 缺失 antd 依赖的浏览器 API（对齐 task-detail-maintenance / settings 测试先例）。
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

const EXEC_ID = 'exec-abc-123';

const ARTIFACTS = [
  { name: 'screenshot.png', size: 2048, sha256: 'deadbeefcafebabe0000000000000000000000000000000000000000000000aa' },
  { name: 'report.csv', size: 1048576, sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
];

beforeEach(() => {
  vi.mocked(artifactsApi.listArtifacts).mockReset();
  vi.mocked(artifactsApi.downloadArtifact).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('formatArtifactSize', () => {
  it('B / KB / MB 换算', () => {
    expect(formatArtifactSize(512)).toBe('512 B');
    expect(formatArtifactSize(2048)).toBe('2.0 KB');
    expect(formatArtifactSize(1048576)).toBe('1.0 MB');
  });
});

describe('ArtifactsList', () => {
  it('传入 artifacts：渲染 name/大小/sha 前缀与下载入口', async () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ArtifactsList execId={EXEC_ID} artifacts={ARTIFACTS} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('screenshot.png')).toBeTruthy();
    expect(screen.getByText('report.csv')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
    expect(screen.getByText('1.0 MB')).toBeTruthy();
    // sha256 前 8 位
    expect(screen.getByText(/sha256:deadbeef/)).toBeTruthy();
    expect(screen.getByText(/sha256:01234567/)).toBeTruthy();
    // 标题带条数
    expect(screen.getByText('产物（2）')).toBeTruthy();
    // 两条下载入口
    expect(screen.getByLabelText('下载产物 screenshot.png')).toBeTruthy();
    expect(screen.getByLabelText('下载产物 report.csv')).toBeTruthy();
    // 传了 artifacts 就不该自行拉取
    expect(artifactsApi.listArtifacts).not.toHaveBeenCalled();
    expect(container).toBeTruthy();
  });

  it('点击下载：以 (execId, name) 调用 api 层 downloadArtifact', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ArtifactsList execId={EXEC_ID} artifacts={ARTIFACTS} />
      </QueryClientProvider>,
    );
    await screen.findByText('report.csv');
    fireEvent.click(screen.getByLabelText('下载产物 report.csv'));
    await waitFor(() =>
      expect(artifactsApi.downloadArtifact).toHaveBeenCalledWith(EXEC_ID, 'report.csv'),
    );
    expect(artifactsApi.downloadArtifact).toHaveBeenCalledTimes(1);
  });

  it('空清单（传入 []）：整段不渲染', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ArtifactsList execId={EXEC_ID} artifacts={[]} />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(document.body.textContent).toBe('');
    });
    expect(screen.queryByText(/^产物/)).toBeNull();
    // 传了 artifacts（即便为空）不应触发自取数
    expect(artifactsApi.listArtifacts).not.toHaveBeenCalled();
  });

  it('未传 artifacts：按 execId 自 listArtifacts 拉取后渲染', async () => {
    vi.mocked(artifactsApi.listArtifacts).mockResolvedValue(ARTIFACTS);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ArtifactsList execId={EXEC_ID} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(artifactsApi.listArtifacts).toHaveBeenCalledWith(EXEC_ID));
    expect(await screen.findByText('screenshot.png')).toBeTruthy();
    expect(screen.getByText('report.csv')).toBeTruthy();
  });

  it('下载失败：调用 api 层后不抛异常，渲染保持', async () => {
    vi.mocked(artifactsApi.downloadArtifact).mockRejectedValueOnce(new Error('401 未授权'));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ArtifactsList execId={EXEC_ID} artifacts={ARTIFACTS} />
      </QueryClientProvider>,
    );
    await screen.findByText('screenshot.png');
    fireEvent.click(screen.getByLabelText('下载产物 screenshot.png'));
    await waitFor(() =>
      expect(artifactsApi.downloadArtifact).toHaveBeenCalledWith(EXEC_ID, 'screenshot.png'),
    );
    // 组件仍稳定渲染，未因失败卸载
    expect(screen.getByText('screenshot.png')).toBeTruthy();
  });
});
