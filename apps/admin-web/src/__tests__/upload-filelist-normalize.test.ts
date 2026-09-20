/**
 * F-ZIP 生产故障回归测试：Upload 受控 fileList 归一。
 *
 * 复现的线上错误：`TypeError: (a || []).forEach is not a function`
 * （antd Upload.js 内 `React.useMemo(() => (fileList || []).forEach(...), [fileList])`）。
 *
 * 触发链：<Form.Item name="file" valuePropName="fileList"> 缺 getValueFromEvent 时，
 * rc-form 的 defaultGetValueFromEvent 会把 Upload onChange 的整个事件对象
 * `{ file, fileList, event }`（无 .target）原样存为字段值，再回填给 <Upload fileList>，
 * 于是 antd 对「真值非数组」调用 forEach 崩溃。
 *
 * normFileList 是把字段值收敛回 UploadFile[] 的单一修复点，故直接对其做契约测试。
 */
import { describe, it, expect } from 'vitest';
import { normFileList } from '../utils/upload';

describe('normFileList（Upload fileList 归一）', () => {
  it('把 Upload onChange 事件对象收敛为其 fileList 数组', () => {
    const files = [{ uid: '1', name: 'app.zip' }];
    const event = { file: files[0], fileList: files, event: {} };
    expect(normFileList(event)).toBe(files);
  });

  it('数组入参原样返回（受控回填 / 直接赋值场景）', () => {
    const files = [{ uid: '1' }, { uid: '2' }];
    expect(normFileList(files)).toBe(files);
  });

  it('undefined / null 退化为空数组，绝不返回真值非数组', () => {
    expect(normFileList(undefined)).toEqual([]);
    expect(normFileList(null)).toEqual([]);
  });

  it('缺 fileList 的杂散对象退化为空数组（防止崩溃向量复现）', () => {
    expect(normFileList({ file: {} })).toEqual([]);
  });

  it('返回值恒可被 forEach 消费（钉死线上崩溃不变量）', () => {
    for (const input of [
      { file: {}, fileList: [{ uid: '1' }] },
      [{ uid: '1' }],
      undefined,
      {},
    ]) {
      const out = normFileList(input);
      expect(Array.isArray(out)).toBe(true);
      expect(() => out.forEach(() => {})).not.toThrow();
    }
  });
});
