/**
 * P1-8 纯函数单测：application-list-stats.ts
 *
 * 组件渲染路径见 application-list-error-state.test.tsx；本文件钉住两条不变量：
 *  ① 统计未取到（null）与「已取到、无部署行」（[]）必须可区分——前者
 *     statsAvailable=false，列内显示「暂不可用」；后者回落 0/null 是真实口径。
 *  ② describeStatsError 只负责抽取折叠技术详情（状态/URL/原始消息），不产
 *     生用户主文案。
 */
import { describe, it, expect } from 'vitest';
import { mergeAppsWithStats, describeStatsError } from '../pages/application-list-stats';
import type { Application } from '../api/applications';

const app = (id: string): Application => ({
  id,
  name: id,
  version: '1.0.0',
  runtime: 'node',
  status: 'active',
  createdAt: '2026-11-15T00:00:00.000Z',
  updatedAt: '2026-11-15T00:00:00.000Z',
});

describe('mergeAppsWithStats', () => {
  it('stats=null（未取到/失败）→ statsAvailable=false，占位 0/null 不得被当作成功口径', () => {
    const rows = mergeAppsWithStats([app('a1')], null);
    expect(rows[0].statsAvailable).toBe(false);
    expect(rows[0].runningCount).toBe(0);
    expect(rows[0].failedCount).toBe(0);
    expect(rows[0].totalDeployments).toBe(0);
    expect(rows[0].lastDeployedAt).toBeNull();
  });

  it('stats=[]（已取到、无部署行）→ statsAvailable=true，按旧口径回落 0/null', () => {
    const rows = mergeAppsWithStats([app('a1')], []);
    expect(rows[0].statsAvailable).toBe(true);
    expect(rows[0].totalDeployments).toBe(0);
  });

  it('按 applicationId 合并运行/失败/总数/最近部署；未命中的应用回落 0', () => {
    const rows = mergeAppsWithStats(
      [app('a1'), app('a2')],
      [
        {
          applicationId: 'a1',
          total: 3,
          running: 2,
          failed: 1,
          lastDeployedAt: '2026-11-15T00:00:00.000Z',
        },
      ],
    );
    expect(rows[0]).toMatchObject({
      statsAvailable: true,
      runningCount: 2,
      failedCount: 1,
      totalDeployments: 3,
      lastDeployedAt: '2026-11-15T00:00:00.000Z',
    });
    expect(rows[1]).toMatchObject({
      statsAvailable: true,
      runningCount: 0,
      failedCount: 0,
      totalDeployments: 0,
      lastDeployedAt: null,
    });
  });
});

describe('describeStatsError', () => {
  it('从拦截器 envelope reject 值提取 HTTP 状态码与原始消息', () => {
    expect(
      describeStatsError({ __status: 404, message: 'fixture missing: GET /app-deployments/stats' }),
    ).toBe('HTTP 404 · fixture missing: GET /app-deployments/stats');
  });

  it('从 axios 网络错误提取 config.url 与 message', () => {
    expect(
      describeStatsError({ config: { url: '/app-deployments/stats' }, message: 'Network Error' }),
    ).toBe('/app-deployments/stats · Network Error');
  });

  it('无可用信息返回空串（由调用方回落兜底文案）', () => {
    expect(describeStatsError(null)).toBe('');
    expect(describeStatsError(new Error())).toBe('');
  });
});
