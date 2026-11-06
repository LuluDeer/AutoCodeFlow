/**
 * P3-1（SOP 指派弹窗）：从 SopsPage 外提的**指派对话框本体**。
 *
 * ## 为什么外提
 *
 * `apps/admin-web/src/pages/SopsPage.tsx` 在体量棘轮顶格
 * （scripts/source-size-baseline.json：nonCommentLines=996 / functionLines=1062，
 * **只减不增**）⇒ 指派弹窗的 JSX 必须外提，页面里只留调用与状态。
 * 顺带把「可接指派执行器的三态渲染」也放在本目录（AssignableExecutorPicker），
 * 于是「读取失败 ≠ 数据为空」这条判据有了**唯一**实现点。
 *
 * ## 语义（**核心纪律：读取失败 ≠ 数据为空**）
 *
 *  · 候选执行器在途（loading）⇒ 只给加载指示，**不**说「没有可接指派的执行器」；
 *  · 读到空列表（ready 且空）⇒ 才说「没有可接指派的执行器」（真空态）；
 *  · 读取失败（error）⇒ 原位错误块 + 「重新加载」（不再只留一条会消失的 toast）。
 *
 * ## 确认键的处置
 *
 * `okButtonProps={{ disabled: !assignForm.executorId }}` **保持不变**：
 * 失败态下确实**没有**任何可指派的执行器可选（executorId 必为空），把确认键
 * 放开就等于让用户提交一个必然失败的指派。真正的缺陷不是「键灰着」，而是
 * **灰着且无处可走**——所以本组件在错误态给出「重新加载」这条可恢复路径：
 * 重试成功后候选列表回来、用户可选、确认键自动可用。
 */
import { Form, Modal, Select, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { AssignableExecutor, SopVersion } from '../../api/sops';
import AssignableExecutorPicker from './AssignableExecutorPicker';
import type { AssignableExecutors } from './useAssignableExecutors';
import { ASSIGN_SOP_FIELD_ID } from './assign-field-ids';

const { Text } = Typography;

export interface AssignSopModalProps {
  /** 目标 SOP（null = 弹窗关闭）。 */
  open: boolean;
  /** 指派表单：SOP 版本 + 选中的执行器 id。 */
  form: { version: string; executorId: string };
  onFormChange: (next: { version: string; executorId: string }) => void;
  /** 该 SOP 的可指派版本列表（版本下拉的选项）。 */
  versions: SopVersion[];
  /** 可接指派执行器的三态取数结果。 */
  assignable: AssignableExecutors;
  /** 提交中（确认键 loading）。 */
  submitting: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}

/** SOP 指派对话框（版本 + 执行器两个下拉 + 三态状态区）。 */
export default function AssignSopModal({
  open,
  form,
  onFormChange,
  versions,
  assignable,
  submitting,
  onSubmit,
  onCancel,
}: AssignSopModalProps) {
  const { t } = useTranslation();

  return (
    <Modal
      title={t('sops.assignTitle')}
      open={open}
      onOk={onSubmit}
      onCancel={onCancel}
      confirmLoading={submitting}
      width={620}
      okText={t('sops.assignSubmit')}
      // 失败态下 executorId 必为空 ⇒ 确认键置灰（这是**事实**：确实没有可
      // 指派的执行器可选）；可恢复路径由状态区的「重新加载」按钮给出。
      okButtonProps={{ disabled: !form.executorId }}
    >
      {/* A11Y-SOPS-01：两个下拉补可见标签（仍是 Space 的直接子项，间距不变） */}
      <Form layout="vertical" component={false}>
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          <AssignableExecutorPicker assignable={assignable} />
          <Form.Item
            label={t('sops.field.assignVersion')}
            htmlFor={ASSIGN_SOP_FIELD_ID.assignVersion}
            style={{ marginBottom: 0 }}
          >
            <Select
              id={ASSIGN_SOP_FIELD_ID.assignVersion}
              style={{ width: '100%' }}
              showSearch
              // 版本随 SOP 修订持续增长，键入过滤；label 含版本号与内容摘要
              optionFilterProp="label"
              placeholder={t('sops.assignVersion')}
              value={form.version || undefined}
              onChange={(v) => onFormChange({ ...form, version: v })}
              options={versions.map((v) => ({
                value: v.version,
                label: `${v.version} (${v.contentHash.slice(0, 8)}…)`,
              }))}
            />
          </Form.Item>
          <Form.Item
            label={t('sops.field.assignExecutor')}
            htmlFor={ASSIGN_SOP_FIELD_ID.assignExecutor}
            style={{ marginBottom: 0 }}
          >
            <Select
              id={ASSIGN_SOP_FIELD_ID.assignExecutor}
              style={{ width: '100%' }}
              showSearch
              optionFilterProp="label"
              placeholder={t('sops.assignExecutorPlaceholder')}
              value={form.executorId || undefined}
              onChange={(v) => onFormChange({ ...form, executorId: v })}
              options={assignable.items.map((e: AssignableExecutor) => ({
                value: e.id,
                label: `${e.appName} (${e.address}) · ${e.agentCapabilities.join(',')}`,
              }))}
            />
          </Form.Item>
          <Text type="secondary">{t('sops.assignNote')}</Text>
        </Space>
      </Form>
    </Modal>
  );
}
