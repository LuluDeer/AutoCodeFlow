/**
 * F-5（UIUX 审计 P2-4）回归：大文件传输不吃全局 30s axios 超时。
 *
 * 执行器包 / PyPI 包可达数百 MB（后端 multer 上限 500MB），弱网下 30s 内传
 * 不完即被 axios 掐断报「网络错误」——而服务端可能仍在接收（上传侧）或已在
 * 传输（下载侧），用户按提示重传会产生重复包/僵尸包。三条大传输路径必须
 * 显式 `timeout: 0`（不限时，由进度/loading 态 + 用户手动取消兜底）；其余
 * 请求保持实例默认 30s。
 *
 * 只 mock `api/client`（最外层 HTTP 出口），真实 api 实现在跑——断言的是
 * 各 api 函数实际下发的 per-request config（对齐 executor-packages-keyset-api
 * 先例：mock 页面层会检验到测试自己的 mock，无意义）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { client } from '../api/client';
import { executorPackagesApi } from '../api/executor-packages';
import { registryApi } from '../api/registry';

vi.mock('../api/client', () => ({
  client: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
const mockedClient = vi.mocked(client, true);

beforeEach(() => {
  vi.clearAllMocks();
  mockedClient.get.mockResolvedValue(new Blob() as never);
  mockedClient.post.mockResolvedValue({} as never);
});

describe('F-5: 大文件传输显式 timeout:0', () => {
  it('executorPackagesApi.upload → timeout 0（数百 MB 包 × 弱网，30s 必掐断）', async () => {
    await executorPackagesApi.upload(new FormData());
    const config = mockedClient.post.mock.calls[0]![2] as { timeout?: number };
    expect(config.timeout).toBe(0);
  });

  it('executorPackagesApi.upload 仍透传 onUploadProgress（B-12 进度条不回退）', async () => {
    const onUploadProgress = () => {};
    await executorPackagesApi.upload(new FormData(), onUploadProgress);
    const config = mockedClient.post.mock.calls[0]![2] as { onUploadProgress?: unknown };
    expect(config.onUploadProgress).toBe(onUploadProgress);
  });

  it('executorPackagesApi.download（blob）→ timeout 0', async () => {
    await executorPackagesApi.download('pkg-1');
    const config = mockedClient.get.mock.calls[0]![1] as {
      responseType?: string;
      timeout?: number;
    };
    expect(config.responseType).toBe('blob');
    expect(config.timeout).toBe(0);
  });

  it('registryApi.uploadPypiPackage → timeout 0', async () => {
    await registryApi.uploadPypiPackage(new FormData());
    const config = mockedClient.post.mock.calls[0]![2] as { timeout?: number };
    expect(config.timeout).toBe(0);
  });
});
