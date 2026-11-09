/**
 * R171：**下发弹窗的序号守卫**（补 R170 留下的「照抄了代码但没照抄测试」）。
 *
 * ## 这条守卫要防的事故
 *
 * 快速先点版本 A 再点版本 B（或 A 的响应慢于 B）时，**A 的旧响应晚到**会把 `data.pkg`
 * 与 `checked` 整个覆盖成 A 的 ⇒ **标题写着 B、要下发的包地址与默认勾选的执行器却来自 A**
 * ⇒ 用户点「确认下发」就**发错包**（不可逆）。
 *
 * ## 判据
 *
 * ① **旧响应晚到 ⇒ 丢弃**：先 load(A)（悬而未决）→ load(B)（已落地）→ 再让 A 落地
 *    ⇒ 最终 `data.pkg` / `checked` 必须是 **B 的**；
 * ② **关闭后旧响应不许写回**：load(A)（悬而未决）→ `reset()` → A 落地 ⇒ `data` 仍为 null；
 * ③ **旧响应的失败不该动当前弹窗**：load(A)（悬而未决）→ load(B)（成功）→ A 拒绝
 *    ⇒ `error` 必须仍是 null，且 `data` 仍是 B 的；
 * ④ **正例控制组**：单发 load 正常落地（证明①②③不是因为「永远拿不到数据」才绿）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const list = vi.fn();
const getReleases = vi.fn();

vi.mock('../api/applications', () => ({
  deploymentsApi: { list: (...a: unknown[]) => list(...a) },
  applicationsApi: { getReleases: (...a: unknown[]) => getReleases(...a) },
}));

import { useDeployModalData } from '../pages/application-detail/useDeployModalData';

/** 造一个可外部控制落地时机的 Promise。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 部署行 fixture（只用到 `status` 与 `executorId`）。 */
const row = (executorId: string, status = 'running') => ({ executorId, status });

beforeEach(() => {
  list.mockReset();
  getReleases.mockReset();
  getReleases.mockResolvedValue(null);
});

describe('R171：下发弹窗序号守卫（晚到的旧响应不得改写当前弹窗）', () => {
  it('① 旧版本响应晚到 ⇒ 不得覆盖新版本的包与勾选集', async () => {
    const { result } = renderHook(() => useDeployModalData('app-1'));
    const a = deferred<{ data: unknown[]; total: number }>();
    const b = deferred<{ data: unknown[]; total: number }>();
    list.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

    act(() => {
      void result.current.load({ id: 'ver-A' });
    });
    act(() => {
      void result.current.load({ id: 'ver-B' });
    });

    // B 先落地（反映「B 的响应更快」）
    await act(async () => {
      b.resolve({ data: [row('exec-B')], total: 1 });
    });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.checked).toEqual(['exec-B']);

    // A 的旧响应**晚到** —— 必须被丢弃
    await act(async () => {
      a.resolve({ data: [row('exec-A-old')], total: 1 });
    });
    // 仍然是 B 的（如果守卫失效，这里会变成 exec-A-old）
    expect(result.current.checked).toEqual(['exec-B']);
    expect(result.current.data?.rows).toEqual([row('exec-B')]);
  });

  it('② 关闭（reset）后旧响应不许写回', async () => {
    const { result } = renderHook(() => useDeployModalData('app-1'));
    const a = deferred<{ data: unknown[]; total: number }>();
    list.mockReturnValueOnce(a.promise);

    act(() => {
      void result.current.load({ id: 'ver-A' });
    });
    act(() => {
      result.current.reset();
    });
    await act(async () => {
      a.resolve({ data: [row('exec-A')], total: 1 });
    });
    expect(result.current.data).toBeNull();
    expect(result.current.checked).toEqual([]);
  });

  it('③ 旧响应的失败不该动当前弹窗（error 仍为 null）', async () => {
    const { result } = renderHook(() => useDeployModalData('app-1'));
    const a = deferred<{ data: unknown[]; total: number }>();
    const b = deferred<{ data: unknown[]; total: number }>();
    list.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

    act(() => {
      void result.current.load({ id: 'ver-A' });
    });
    act(() => {
      void result.current.load({ id: 'ver-B' });
    });
    await act(async () => {
      b.resolve({ data: [row('exec-B')], total: 1 });
    });
    await waitFor(() => expect(result.current.data).not.toBeNull());

    await act(async () => {
      a.reject(new Error('old request failed'));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.checked).toEqual(['exec-B']);
  });

  it('④ 正例控制组：单发 load 正常落地（数据 + 勾选都对）', async () => {
    const { result } = renderHook(() => useDeployModalData('app-1'));
    list.mockResolvedValueOnce({ data: [row('e1'), row('e2', 'stopped')], total: 2 });
    await act(async () => {
      await result.current.load({ id: 'ver-A' });
    });
    expect(result.current.data?.total).toBe(2);
    // 只勾 running 的执行器（stopped 不勾）—— 这是既有的缺省语义
    expect(result.current.checked).toEqual(['e1']);
    expect(result.current.error).toBeNull();
  });
});
