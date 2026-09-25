/**
 * MODAL-01 守卫：命令式 Modal 出口必须**可被测试侦察**。
 *
 * 背景：迁移前全站 11 处 `Modal.confirm(...)` 调 antd 静态方法，测试普遍用
 * `vi.spyOn(Modal, 'confirm')` 拦截并自动触发 onOk。迁移到 utils/modal 出口后，
 * 若出口不把调用**委托回 antd 的那个对象**，这些 spy 会静默失效——更危险的是
 * `expect(confirmSpy).not.toHaveBeenCalled()` 这类**反向断言会变成永真**
 * （实测：executor-pull-gating 的「空配置体不发确认」用例即此形态）。
 *
 * 本文件把"可侦察性"钉死：桥未挂载（测试直渲组件/非 React 场景）时，
 * 出口必须走 antd 静态实现，且该实现可被 spyOn 拦截。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Modal as antdModal } from 'antd';
import { Modal as shimModal } from '../utils/modal';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MODAL-01：utils/modal 出口的可侦察性', () => {
  it('桥未挂载时 vi.spyOn(antd Modal, "confirm") 能拦到出口的调用', () => {
    const spy = vi.spyOn(antdModal, 'confirm').mockImplementation((() => undefined) as never);
    shimModal.confirm({ title: 'probe' } as never);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ title: 'probe' }));
  });

  it('五个命令式方法都委托回 antd（spy 全覆盖）', () => {
    const names = ['confirm', 'info', 'success', 'error', 'warning'] as const;
    for (const n of names) {
      const spy = vi.spyOn(antdModal, n).mockImplementation((() => undefined) as never);
      (shimModal[n] as (p: unknown) => void)({ title: n });
      expect(spy, `${n} 未被委托回 antd（该方法的 spy 会静默失效）`).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    }
  });

  it('反向断言有牙：未调用时 spy 确实为 0（防止"永真"式假绿）', () => {
    const spy = vi.spyOn(antdModal, 'confirm').mockImplementation((() => undefined) as never);
    expect(spy).not.toHaveBeenCalled();
    shimModal.confirm({ title: 'now-called' } as never);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
