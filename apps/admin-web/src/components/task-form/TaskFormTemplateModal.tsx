/**
 * REFACTOR-TASKFORM-06：FEAT-13「保存为自定义模板」弹窗（原 TaskFormPage 内联
 * Modal 原样迁出）。
 *
 * 职责边界：本组件只负责**模板元信息**（name/描述/分类）的采集与校验——
 * tplForm 与 validateFields 语义原样保留（required/whitespace、maxLength、
 * 校验失败静默 return / 请求外错误走 showApiError 的分支不动）。校验通过后
 * 经 onConfirm(meta) 交回父级：config 由 templateConfigFromFormValues 白名单
 * 抽取（CreateTaskDto 子集，后端 forbidNonWhitelisted 校验），载荷组装与
 * POST /task-templates 仍在 TaskFormPage 提交链路内（行为保持不变）。
 */
import { Form, Input, Modal, Space, Typography } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import '../../i18n';
import { isFormValidationError, showApiError } from '../../utils/error';

/** 模板元信息（FEAT-13；name 必填非空白，描述/分类可选） */
export interface TaskFormTemplateMeta {
  name: string;
  description?: string;
  category?: string;
}

export default function TaskFormTemplateModal({
  open,
  saving,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** 提交中态（父级模板保存请求进行中，原 tplSaving） */
  saving: boolean;
  onCancel: () => void;
  /** 元信息校验通过后回调；载荷组装与请求仍由父级提交链路完成 */
  onConfirm: (meta: TaskFormTemplateMeta) => void;
}) {
  const { t } = useTranslation();
  const [tplForm] = Form.useForm<TaskFormTemplateMeta>();

  // FEAT-13：原 handleSaveAsTemplate 的前半段——先校验模板元信息，通过后才
  // 进入父级载荷组装（与原执行顺序一致：校验失败不触碰 saving 状态）。
  const handleOk = async () => {
    let meta: TaskFormTemplateMeta;
    try {
      meta = await tplForm.validateFields();
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      // UX-11：同 TaskFormPage——统一走 getErrMsg/showApiError 归一。
      showApiError(err, t('taskForm.tpl.saveFail'));
      return;
    }
    onConfirm(meta);
  };

  return (
    <Modal
      title={<Space><SaveOutlined /> {t('taskForm.tpl.modalTitle')}</Space>}
      open={open}
      onCancel={onCancel}
      onOk={handleOk}
      okText={t('taskForm.tpl.save')}
      okButtonProps={{ loading: saving, 'data-testid': 'tpl-save-confirm' }}
      cancelText={t('taskForm.tpl.cancel')}
      width={520}
      destroyOnHidden
    >
      <Form form={tplForm} layout="vertical">
        <Form.Item
          name="name"
          label={t('taskForm.tpl.name')}
          rules={[{ required: true, whitespace: true, message: t('taskForm.tpl.name.required') }]}
        >
          <Input placeholder={t('taskForm.tpl.name.placeholder')} maxLength={128} data-testid="tpl-name-input" />
        </Form.Item>
        <Form.Item name="description" label={t('taskForm.tpl.description')}>
          <Input.TextArea rows={2} placeholder={t('taskForm.tpl.description.placeholder')} maxLength={500} data-testid="tpl-desc-input" />
        </Form.Item>
        <Form.Item name="category" label={t('taskForm.tpl.category')}>
          <Input placeholder={t('taskForm.tpl.category.placeholder')} maxLength={32} data-testid="tpl-category-input" />
        </Form.Item>
      </Form>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('taskForm.tpl.hint')}
      </Typography.Text>
    </Modal>
  );
}
