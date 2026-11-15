import { useState } from 'react';
import { Alert, Button, Form, Input, Modal, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { taskTemplatesApi, type TaskTemplate } from '../api/task-templates';
import { showApiError } from '../utils/error';
import '../i18n';

const { Text } = Typography;

export interface TemplateEditModalProps {
  open: boolean;
  template: TaskTemplate | null;
  onClose: () => void;
  onSaved: () => void;
}

interface EditFormValues {
  name: string;
  description?: string;
  category?: string;
  configText: string;
}

/**
 * P1-5：自定义模板编辑弹窗（PATCH /task-templates/:id）。
 *
 * 可编辑字段 = name / description / category / config；key、官方标记、属主
 * 不可改（后端 UpdateTaskTemplateDto 白名单 + service 闸门）。config 以 JSON 文本
 * 编辑，提交前在客户端做一次 JSON 解析把关，结构值域仍由后端 CreateTaskDto
 * 子集校验兜底。
 */
export default function TemplateEditModal({
  open,
  template,
  onClose,
  onSaved,
}: TemplateEditModalProps) {
  const { t } = useTranslation();
  const [form] = Form.useForm<EditFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  // destroyOnHidden + preserve=false：每次打开都重新挂载 Form，初始值在挂载时
  // 由 initialValues 带入（弹窗未连接时 setFieldsValue 会落空，见既有 use 弹窗注释）。
  const initialValues = template
    ? {
        name: template.name,
        description: template.description ?? '',
        category: template.category ?? '',
        configText: JSON.stringify(template.config ?? {}, null, 2),
      }
    : undefined;

  const handleSubmit = async (): Promise<void> => {
    if (!template || submitting) return;
    let values: EditFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }

    let config: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(values.configText || '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('config must be an object');
      }
      config = parsed as Record<string, unknown>;
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : t('templateEdit.configInvalid'));
      return;
    }
    setConfigError(null);

    setSubmitting(true);
    try {
      await taskTemplatesApi.update(template.id, {
        name: values.name.trim(),
        description: values.description?.trim() || null,
        category: values.category?.trim() || null,
        config,
      });
      onSaved();
      onClose();
    } catch (err: unknown) {
      showApiError(err, t('templateEdit.saveFail'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t('templateEdit.title')}
      onCancel={onClose}
      destroyOnHidden
      width={600}
      mask={{ closable: !submitting }}
      closable={!submitting}
      keyboard={!submitting}
      confirmLoading={submitting}
      okButtonProps={{ loading: submitting, disabled: submitting }}
      cancelButtonProps={{ disabled: submitting }}
      footer={
        <Space>
          <Button onClick={onClose} disabled={submitting}>{t('templateEdit.cancel')}</Button>
          <Button type="primary" loading={submitting} onClick={() => void handleSubmit()}>
            {t('templateEdit.save')}
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" preserve={false} initialValues={initialValues}>
        <Form.Item
          name="name"
          label={t('templateEdit.name')}
          rules={[{ required: true, whitespace: true, message: t('templateEdit.nameRequired') }]}
        >
          <Input maxLength={128} autoFocus />
        </Form.Item>
        <Form.Item name="category" label={t('templateEdit.category')}>
          <Input maxLength={32} placeholder={t('templateEdit.categoryPlaceholder')} />
        </Form.Item>
        <Form.Item name="description" label={t('templateEdit.description')}>
          <Input.TextArea rows={3} maxLength={500} />
        </Form.Item>
        <Form.Item
          name="configText"
          label={t('templateEdit.config')}
          extra={<Text type="secondary" style={{ fontSize: 12 }}>{t('templateEdit.configHint')}</Text>}
        >
          <Input.TextArea
            rows={10}
            spellCheck={false}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
        </Form.Item>
        {configError && (
          <Alert type="error" showIcon style={{ marginBottom: 12 }} message={configError} />
        )}
      </Form>
    </Modal>
  );
}
