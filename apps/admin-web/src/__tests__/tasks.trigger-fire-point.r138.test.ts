/**
 * R138 / A6b：`tasksApi.trigger` 的第 4 参 `options.consumeNextFirePoint`。
 *
 * ## 钉的是什么（产品口径，`docs/OPEN-DECISIONS.md:18`）
 * 「`consumeNextFirePoint`（**缺省 false ⇒ 行为逐字节不变**）。勾选 ⇒ 把下一个
 * cron 落点登记为已消耗……非 cron ⇒ 400；已有未消耗登记 ⇒ 409。」
 *
 * 故本文件只做**载荷级**判据（页面层另有 `fire-point-consume.r138.test.tsx` 钉
 * 「勾选/不勾选/非 cron 不渲染」）：
 *   ① 未传 options ⇒ body **逐字节**与改动前一致（键集合就是 `['params']`）；
 *   ② 显式 `{ consumeNextFirePoint: false }` ⇒ 同上（`false` 不落键，不能靠
 *      后端把 false 当缺省——「缺键」才是文档写死的判据）；
 *   ③ `true` ⇒ body 多一个键，且与 `params` 共存；
 *   ④ 与 `version` 共存时三键同时出现（A 组「按原版本重放」路径不被覆盖）；
 *   ⑤ 只传 version、不传 options ⇒ body 仍与改动前逐字节一致（`version` 老路径）。
 *
 * ## 反证（已实跑，见 artifacts/autonomy/R138/impl-firepoint.md）
 * 把 `api/tasks.ts` 里 `if (options?.consumeNextFirePoint === true) body...` 删掉 ⇒
 * ③④ 变红；把它改成无条件 `body.consumeNextFirePoint = options?.consumeNextFirePoint`
 * ⇒ ①②⑤ 变红（多了一个 `consumeNextFirePoint: undefined/false` 键）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tasksApi } from '../api/tasks';
import { client } from '../api/client';

vi.mock('../api/client', () => ({
  client: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const mockPost = vi.mocked(client.post);

const bodyOfLastPost = (): Record<string, unknown> =>
  mockPost.mock.calls[mockPost.mock.calls.length - 1]![1] as Record<string, unknown>;

beforeEach(() => {
  mockPost.mockReset();
  mockPost.mockResolvedValue({} as never);
});

describe('A6b · tasksApi.trigger 载荷（逐字节不变的判据）', () => {
  it('① 未传 options ⇒ body 只有 params（无 consumeNextFirePoint 键）', async () => {
    await tasksApi.trigger('t1', { region: 'cn' });

    expect(mockPost).toHaveBeenCalledWith('/tasks/t1/trigger', { params: { region: 'cn' } });
    expect(Object.keys(bodyOfLastPost())).toEqual(['params']);
  });

  it('② 显式传 { consumeNextFirePoint: false } ⇒ 仍然不出现该键（逐字节不变）', async () => {
    await tasksApi.trigger('t1', { region: 'cn' }, undefined, { consumeNextFirePoint: false });

    expect(mockPost).toHaveBeenCalledWith('/tasks/t1/trigger', { params: { region: 'cn' } });
    expect('consumeNextFirePoint' in bodyOfLastPost()).toBe(false);
  });

  it('③ 勾选 ⇒ body 带 consumeNextFirePoint:true（与 params 共存）', async () => {
    await tasksApi.trigger('t1', { region: 'cn' }, undefined, { consumeNextFirePoint: true });

    expect(mockPost).toHaveBeenCalledWith('/tasks/t1/trigger', {
      params: { region: 'cn' },
      consumeNextFirePoint: true,
    });
  });

  it('④ 与 version 共存 ⇒ params / version / consumeNextFirePoint 三键同时在', async () => {
    await tasksApi.trigger('t1', { region: 'cn' }, 3, { consumeNextFirePoint: true });

    expect(mockPost).toHaveBeenCalledWith('/tasks/t1/trigger', {
      params: { region: 'cn' },
      version: 3,
      consumeNextFirePoint: true,
    });
  });

  it('⑤ 只传 version（老路径）⇒ body 与改动前逐字节一致', async () => {
    await tasksApi.trigger('t1', { region: 'cn' }, 3);

    expect(mockPost).toHaveBeenCalledWith('/tasks/t1/trigger', { params: { region: 'cn' }, version: 3 });
    expect(Object.keys(bodyOfLastPost())).toEqual(['params', 'version']);
  });
});
