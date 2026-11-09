/**
 * A11Y-SOPS-01：指派弹窗两个下拉的**字段 id**（页面与外提的弹窗组件共用同一份）。
 *
 * ## 为什么单独成文件
 *
 * `SopsPage.tsx` 与 `pages/sops/AssignSopModal.tsx` 都要用这两个 id
 * （页面的 SOPS_FIELD_ID 常量含全部 12 个字段 id；指派弹窗外提后，那两个
 * id 的**消费点**搬到了新文件）。id 若在两处各写一份，迟早漂移 ⇒
 * `getByLabelText` 的用例会在漂移后才转红，而那时已经坏了。
 *
 * 口径不变（见 SopsPage.tsx 的 SOPS_FIELD_ID 头注）：可见标签与可访问名是
 * **同一个 DOM 节点**（`<Form.Item label htmlFor>` + 控件同 id），不另造
 * aria-label。
 */
export const ASSIGN_SOP_FIELD_ID = {
  assignVersion: 'sops-assign-version',
  assignExecutor: 'sops-assign-executor',
} as const;
