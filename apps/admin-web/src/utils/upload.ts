/**
 * F-ZIP（生产故障修复）：Upload 受控 fileList 归一工具。
 *
 * 背景：`<Form.Item name="file" valuePropName="fileList">` 若不配 `getValueFromEvent`，
 * rc-form 的 `defaultGetValueFromEvent` 会把 antd Upload `onChange` 回调的**整个事件对象**
 * `{ file, fileList, event }` 原样存为字段值（该对象没有 `.target`，命中不了默认提取分支）。
 * 字段值随后又被 Form.Item 回填给 `<Upload fileList={...}>`，而 antd 内部：
 *
 *   React.useMemo(() => { (fileList || []).forEach(...) }, [fileList])
 *
 * 对这个「真值但非数组」的对象调用 `.forEach` 直接抛
 * `TypeError: (a || []).forEach is not a function`——即用户在选择 zip/wheel 包的一瞬间整页崩溃。
 *
 * 解法：给 Upload 的 Form.Item 配 `getValueFromEvent={normFileList}`，把字段值收敛为
 * 恒定的 `UploadFile[]`（onChange 取 `e.fileList`，数组入参原样返回）。
 */
export function normFileList(e: unknown): unknown[] {
  if (Array.isArray(e)) return e;
  return (e as { fileList?: unknown[] })?.fileList ?? [];
}
