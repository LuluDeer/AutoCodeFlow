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
function Harness({ value }: { value?: Record<string, unknown> }) {
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
      const [value, setValue] = useState<Record<string, unknown>>({
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
      const [value, setValue] = useState<Record<string, unknown>>({});
      return <ParamsEditor value={value} onChange={v => setValue({ ...v })} />;
    }
    render(<CloningParent />);
    expect(inputs()).toHaveLength(0);

    // 添加一行（空键空值），键入键名 'k1'
    const addBtn = document.querySelector('button.ant-btn-dashed');
    expect(addBtn).toBeTruthy();
    fireEvent.click(addBtn!);
    // A-11R：每行现在是 key 输入 + 类型 Select（jsdom 下渲染为搜索用 input）
    // + value 输入。inputs()[0] 恒为 key 输入框。
    expect(inputs().length).toBeGreaterThanOrEqual(2);
    fireEvent.change(inputs()[0], { target: { value: 'k1' } });
    expect(inputs()[0].value).toBe('k1');

    // 清空键名（emit 产物会丢弃该行）→ 回流行仍保留编辑中空键行
    fireEvent.change(inputs()[0], { target: { value: '' } });
    expect(inputs()[0].value).toBe('');

    // 继续键入不打断
    fireEvent.change(inputs()[0], { target: { value: 'k2' } });
    expect(inputs()[0].value).toBe('k2');
  });
});

/**
 * A-11R：类型契约。中台此前只能产出字符串（Record<string,string>）——这正是
 * A-11 生产事故的中台半边根因：需要真实布尔/数字/数组的用户没有任何入口。
 * 这些用例钉住"值不被静默字符串化、类型能完整往返"。
 *
 * 注：antd 的 Select 在 jsdom 下不把选中项渲染成 `input[value]`（它渲染的是
 * 一个只读的搜索框 + 独立的 `.ant-select-selection-item` 文本节点），故断言
 * 走文本节点而不是 getByDisplayValue。
 */
describe('ParamsEditor（A-11R 类型契约）', () => {
  /**
   * 取各 Select 当前显示的文案。本仓库的 antd 版本用
   * `.ant-select-content`（`title` 属性即选中项文本），而非旧版的
   * `.ant-select-selection-item`——两者都读，避免 antd 升级即测试红。
   */
  const selectedTexts = (): string[] =>
    Array.from(
      document.querySelectorAll('.ant-select-content, .ant-select-selection-item'),
    ).map(el => (el.textContent ?? '').trim());

  it('按值的真实类型推断并回填（布尔/数字/JSON 不被字符串化）', () => {
    render(
      <Harness
        value={{
          dry_run: true,
          limit: 3,
          ratio: 1.5,
          tags: ['a', 2],
          nested: { b: true },
          region: '欧盟',
        }}
      />,
    );
    // 文本值原样进输入框（不加引号——这正是 A-11 弄坏的那一处）
    expect(screen.getByDisplayValue('region')).toBeTruthy();
    expect(screen.getByDisplayValue('欧盟')).toBeTruthy();
    // 数字/JSON 值以字面量呈现
    expect(screen.getByDisplayValue('3')).toBeTruthy();
    expect(screen.getByDisplayValue('1.5')).toBeTruthy();
    expect(screen.getByDisplayValue('["a",2]')).toBeTruthy();
    expect(screen.getByDisplayValue('{"b":true}')).toBeTruthy();
    // 类型下拉按值推断：布尔行选「布尔」，两个容器/数组行选「JSON」，
    // 两个数字行选「数字」；布尔行**另有一个**显示 true 的值下拉。
    const texts = selectedTexts();
    expect(texts).toContain('布尔');
    expect(texts).toContain('true');
    expect(texts.filter(t => t === 'JSON').length).toBe(2);
    expect(texts.filter(t => t === '数字').length).toBe(2);
    // 文本行仍显示「文本」（region 一个）
    expect(texts.filter(t => t === '文本').length).toBe(1);
  });

  it('编辑文本类型的值时提交的是字符串（不猜测性转成数字/布尔）', () => {
    const emitted: Record<string, unknown>[] = [];
    function Parent() {
      const [value, setValue] = useState<Record<string, unknown>>({});
      return (
        <ParamsEditor
          value={value}
          onChange={v => {
            emitted.push({ ...v });
            setValue(v);
          }}
        />
      );
    }
    render(<Parent />);
    fireEvent.click(document.querySelector('button.ant-btn-dashed')!);
    fireEvent.change(inputs()[0], { target: { value: 'limit' } });
    // 值输入框是最后一个 input（类型 Select 的搜索框排在它前面）
    fireEvent.change(inputs()[inputs().length - 1], { target: { value: '3' } });
    // 默认类型是文本：用户填的 "3" 必须原样是字符串。这是最容易被"聪明"
    // 实现破坏的一条——静默改类型会改变任务行为且极难排查。
    expect(emitted[emitted.length - 1]).toEqual({ limit: '3' });
  });

  it('切换类型后按该类型提交', async () => {
    const emitted: Record<string, unknown>[] = [];
    function Parent() {
      const [value, setValue] = useState<Record<string, unknown>>({ limit: '3' });
      return (
        <ParamsEditor
          value={value}
          onChange={v => {
            emitted.push({ ...v });
            setValue(v);
          }}
        />
      );
    }
    render(<Parent />);
    // 打开类型下拉（antd Select 的交互入口是 selector/content 上的 mousedown）
    const selector = document.querySelector(
      '.ant-select-content, .ant-select-selector',
    ) as HTMLElement;
    expect(selector).toBeTruthy();
    fireEvent.mouseDown(selector);
    const option = await screen.findByTitle('数字');
    fireEvent.click(option);
    expect(emitted[emitted.length - 1]).toEqual({ limit: 3 });
  });

  it('JSON 类型解析失败时给出可见提示且不丢参数（回落原始字符串）', () => {
    const emitted: Record<string, unknown>[] = [];
    function Parent() {
      const [value, setValue] = useState<Record<string, unknown>>({ bad: { a: 1 } });
      return (
        <ParamsEditor
          value={value}
          onChange={v => {
            emitted.push({ ...v });
            setValue(v);
          }}
        />
      );
    }
    render(<Parent />);
    const jsonInput = screen.getByDisplayValue('{"a":1}');
    fireEvent.change(jsonInput, { target: { value: '{oops' } });
    // 参数仍在（绝不静默丢弃用户填的值），但以原始字符串提交且界面标红
    expect(emitted[emitted.length - 1]).toEqual({ bad: '{oops' });
    expect(screen.getByText(/无法按所选类型解析/)).toBeTruthy();
  });
});
