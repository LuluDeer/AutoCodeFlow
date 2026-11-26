import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getQuotaStatus } from '../api/capability-activation';
import { client } from '../api/client';

vi.mock('../api/client', () => ({
  client: { get: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(client.get).mockReset();
});

describe('getQuotaStatus', () => {
  it('命中 quota-status 路径并透传 windowDays', async () => {
    vi.mocked(client.get).mockResolvedValueOnce([] as never);

    const rows = await getQuotaStatus(14);

    expect(rows).toEqual([]);
    expect(client.get).toHaveBeenCalledWith(
      '/capability-activation/quota-status',
      { params: { windowDays: 14 } },
    );
  });

  it('缺省 windowDays 为 30', async () => {
    vi.mocked(client.get).mockResolvedValueOnce([] as never);

    await getQuotaStatus();

    expect(client.get).toHaveBeenCalledWith(
      '/capability-activation/quota-status',
      { params: { windowDays: 30 } },
    );
  });
});
