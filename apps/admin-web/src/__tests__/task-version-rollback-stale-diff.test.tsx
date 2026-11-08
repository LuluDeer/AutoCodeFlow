/**
 * R170：**过期响应**不得覆盖当前内容（两处不可逆动作前的假事实）。
 *
 * ## 为什么守这两处
 *
 * 两条都是「读 A 显示 B」里**代价最高**的一类 —— 它们直接喂给**不可逆操作**：
 *
 * ① **版本对比**：`handleCompareVersions` 失败时此前**不清 `versionDiff`** ⇒ 先对比
 *    A↔B（成功）、再对比 C↔D（失败）时，面板**继续显示 A↔B 的差异**，而卡片标题
 *    只有「版本差异」四个字、**不带版本号** ⇒ 用户把 A↔B 的差异当成 C↔D 的来读，
 *    并据此点**回滚**（不可逆）。
 * ② **下发到设备弹窗**：`openDeployModal` 无序号守卫 ⇒ 快速先点版本 A 再点 B
 *    （或 A 响应慢于 B）时，**A 的旧响应晚到**把 `pkg` 与默认勾选的执行器覆盖成 A 的
 *    ⇒ 标题写着 B、**要发的包却来自 A**。
 *
 * ## 判据
 *
 * ① 对比失败 ⇒ `versionDiff` 必须被清空（**宁可什么都没有，也不给错的**），且失败原因可读到；
 * ② 对比成功 ⇒ 正常拿到 diff（**正例控制组**：证明①不是因为「永远拿不到 diff」才绿）；
 * ③ 下发弹窗：晚到的旧响应**不得**改写当前弹窗的 `deployData`（序号守卫）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const compareVersions = vi.fn();
vi.mock('../api/tasks', () => ({
  tasksApi: {
    versions: vi.fn().mockResolvedValue([]),
    compareVersions: (...a: unknown[]) => compareVersions(...a),
  },
}));
vi.mock('../utils/toast', () => ({ message: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('../utils/error', () => ({
  showApiError: vi.fn(),
  getErrMsg: (_e: unknown, fb: string) => fb,
}));

import { useTaskVersionRollback } from '../pages/task-detail/useTaskVersionRollback';

beforeEach(() => {
  compareVersions.mockReset();
  vi.clearAllMocks();
});

describe('R170：版本对比失败必须清掉上一次的差异（防回滚错版本）', () => {
  it('① 失败 ⇒ versionDiff 被清空且 versionDiffError 可读到（不再显示旧差异）', async () => {
    const { result } = renderHook(() => useTaskVersionRollback('t-1', () => {}));

    // 第一次对比：成功
    compareVersions.mockResolvedValueOnce({ changes: [{ key: 'a' }] });
    act(() => result.current.setPickedVersionIds(['v1', 'v2']));
    await act(async () => {
      await result.current.handleCompareVersions();
    });
    expect(result.current.versionDiff).not.toBeNull();

    // 第二次对比：失败 —— 必须清空，**不能**留着上一对
    compareVersions.mockRejectedValueOnce(new Error('boom'));
    act(() => result.current.setPickedVersionIds(['v3', 'v4']));
    await act(async () => {
      await result.current.handleCompareVersions();
    });
    await waitFor(() => {
      expect(result.current.versionDiff).toBeNull();
    });
    expect(result.current.versionDiffError).not.toBeNull();
  });

  it('② 正例控制组：成功时正常拿到 diff 且没有 error', async () => {
    const { result } = renderHook(() => useTaskVersionRollback('t-1', () => {}));
    compareVersions.mockResolvedValueOnce({ changes: [{ key: 'a' }, { key: 'b' }] });
    act(() => result.current.setPickedVersionIds(['v1', 'v2']));
    await act(async () => {
      await result.current.handleCompareVersions();
    });
    expect(result.current.versionDiff).toEqual({ changes: [{ key: 'a' }, { key: 'b' }] });
    expect(result.current.versionDiffError).toBeNull();
  });

  it('③ 失败后重试成功 ⇒ error 被清掉、diff 回来（重试路径可用）', async () => {
    const { result } = renderHook(() => useTaskVersionRollback('t-1', () => {}));
    act(() => result.current.setPickedVersionIds(['v1', 'v2']));
    compareVersions.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      await result.current.handleCompareVersions();
    });
    expect(result.current.versionDiffError).not.toBeNull();
    compareVersions.mockResolvedValueOnce({ changes: [] });
    await act(async () => {
      await result.current.handleCompareVersions();
    });
    expect(result.current.versionDiffError).toBeNull();
    expect(result.current.versionDiff).toEqual({ changes: [] });
  });
});
