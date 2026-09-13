/**
 * F-02（DEEP_REVIEW 0ef3bbe）：ParamsEditor 半受控行为。
 *
 * 背景：value 此前只在 useState 初始化时消费——挂载后的外部注入
 * （模板预填 setFieldsValue 等）不会反映到行；修法为「最后外发值」ref。
 * 覆盖：
 * ① 挂载后外部 value 变化必须同步进 rows；
 * ② 自身 onChange 回流（父层原样/克隆回传）不重置行——键入连续性
 *    （焦点保持、清空键名等编辑中状态不被丢弃）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import ParamsEditor from '../components/ParamsEditor';

afterEach(() => {
  cleanup();
});

// antd 在 jsdom 下需要的最小 polyfill（同 task-form-affinity.test.tsx 惯例）
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

const inputs = (): HTMLInputElement[] =>
  Array.from(document.querySelectorAll('input.ant-input'));

/** 纯外部注入 harness：value 由测试经 rerender 控制 */
function Harness({ value }: { value?: Record<string, string> }) {
  return <ParamsEditor value={value} onChange={() => undefined} />;
}

describe('ParamsEditor（F-02 半受控）', () => {
  it('① 挂载后外部 value 变化必须反映到行（模板预填 setFieldsValue 场景）', () => {
    const { rerender } = render(<Harness value={{ host: 'http://a' }} />);
    expect(screen.getByDisplayValue('host')).toBeTruthy();
    expect(screen.getByDisplayValue('http://a')).toBeTruthy();

    // 挂载后再注入新 value（同引用更新路径）→ 新键值行出现
    rerender(<Harness value={{ host: 'http://a', token: 'xyz' }} />);
    expect(screen.getByDisplayValue('token')).toBeTruthy();
    expect(screen.getByDisplayValue('xyz')).toBeTruthy();
    expect(screen.getAllByDisplayValue('host')).toHaveLength(1);
  });

  it('①b value 为 undefined 时渲染空态（无输入行）', () => {
    const { container } = render(<Harness />);
    expect(container.querySelectorAll('input.ant-input')).toHaveLength(0);
  });

  it('② 用户键入触发 onChange、父层回传同值后行不被重置（焦点保持、键入连续）', () => {
    function ControlledParent() {
      const [value, setValue] = useState<Record<string, string>>({
        host: 'http://a',
      });
      return <ParamsEditor value={value} onChange={setValue} />;
    }
    render(<ControlledParent />);

    // 键入键名 → onChange 回流 → 输入框保留新值且焦点不丢
    const keyInput = screen.getByDisplayValue('host') as HTMLInputElement;
    keyInput.focus();
    fireEvent.change(keyInput, { target: { value: 'hosts' } });
    const afterEcho = screen.getByDisplayValue('hosts') as HTMLInputElement;
    expect(afterEcho.value).toBe('hosts');
    expect(document.activeElement).toBe(afterEcho);

    // 第二次键入（值列）不被打断，且无行重复重建
    const valueInput = screen.getByDisplayValue('http://a') as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: 'http://a2' } });
    expect(screen.getByDisplayValue('http://a2')).toBeTruthy();
    expect(screen.getAllByDisplayValue('hosts')).toHaveLength(1);
  });

  it('②b 父层克隆回传（内容同、引用异）时清空键名的编辑中行不被丢弃', () => {
    // 最不利父层形态：onChange 回传浅克隆（引用必不同）——内容回声判定
    // 必须兜住，否则清空键名的行会被外部 value 重建掉（键入被打断）。
    function CloningParent() {
      const [value, setValue] = useState<Record<string, string>>({});
      return <ParamsEditor value={value} onChange={v => setValue({ ...v })} />;
    }
    render(<CloningParent />);
    expect(inputs()).toHaveLength(0);

    // 添加一行（空键空值），键入键名 'k1'
    const addBtn = document.querySelector('button.ant-btn-dashed');
    expect(addBtn).toBeTruthy();
    fireEvent.click(addBtn!);
    expect(inputs()).toHaveLength(2);
    fireEvent.change(inputs()[0], { target: { value: 'k1' } });
    expect(inputs()[0].value).toBe('k1');
    expect(inputs()).toHaveLength(2);

    // 清空键名（emit 产物会丢弃该行）→ 回流行仍保留编辑中空键行
    fireEvent.change(inputs()[0], { target: { value: '' } });
    expect(inputs()).toHaveLength(2);
    expect(inputs()[0].value).toBe('');

    // 继续键入不打断
    fireEvent.change(inputs()[0], { target: { value: 'k2' } });
    expect(inputs()).toHaveLength(2);
    expect(inputs()[0].value).toBe('k2');
  });
});
