import { useEffect, useRef, useState } from 'react';
import { Form, Input, Modal } from 'antd';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { taskTemplatesApi, type TaskTemplate } from '../api/task-templates';
import { queryKeys } from '../api/queries';
import { showApiError } from '../utils/error';
import { message } from '../utils/toast';

/** 与 admin-api `TASK_NAME_MAX_LENGTH` 对齐（DB varchar(255)，按码点计）。 */
const TASK_NAME_MAX_LENGTH = 255;

/** 控制字符（C0 + DEL + 格式字符）。与后端 `IsTaskName` 的判据同源。 */
const CONTROL_CHARS_RE = /[\p{Cc}\p{Cf}]/gu;

/** 本地时间戳 `yyyyMMdd-HHmmss`（用本地时区，降低连续创建撞名的概率）。 */
function localStamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * 「使用模板」弹窗的默认任务名：`<模板名>-yyyyMMdd-HHmmss`。
 * 必须开箱即可提交：消掉控制字符、首尾空白与超长，清空后回退 `task`。
 */
function defaultTaskName(templateName: string, now: Date = new Date()): string {
  const suffix = `-${localStamp(now)}`;
  const base = templateName.replace(CONTROL_CHARS_RE, ' ').trim() || 'task';
  const room = Math.max(TASK_NAME_MAX_LENGTH - Array.from(suffix).length, 1);
  const head = Array.from(base).slice(0, room).join('').trim() || 'task';
  return `${head}${suffix}`;
}

interface TemplateUseDialogProps {
  template: TaskTemplate | null;
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
}

/**
 * 「使用模板」= 直接实例化（POST /task-templates/:id/instantiate）。
 *
 * 从 TaskTemplatesPage 抽出以控制页面组件函数体体量；表单状态、同步锁与
 * 提交语义与原内联实现保持一致：失败（如 409 重名）弹窗保持打开并保留输入，
 * 成功后失效任务缓存并由父级跳转任务详情。
 */
export default function TemplateUseDialog({ template, onClose, onCreated }: TemplateUseDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<{ name: string }>();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (template) form.setFieldsValue({ name: defaultTaskName(template.name) });
  }, [template, form]);

  const close = () => {
    submittingRef.current = false;
    setSubmitting(false);
    form.resetFields();
    onClose();
  };

  const handleCancel = () => {
    // 请求在途时不允许关闭：避免用户以为已取消、实际任务已创建。
    if (submittingRef.current) return;
    close();
  };

  const handleConfirm = async () => {
    if (!template || submittingRef.current) return;
    let values: { name?: string };
    try {
      values = await form.validateFields();
    } catch {
      // 校验错误（required/whitespace）由 Form.Item 内联红字呈现，不发请求。
      return;
    }
    const name = (values.name ?? '').trim();
    if (!name) return;

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const created = await taskTemplatesApi.instantiate(template.id, { name });
      message.success(t('templates.useDialog.created', { name: created.name ?? name }));
      close();
      // 任务列表/统计缓存立即失效，返回列表时能看到刚创建的任务。
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      onCreated(created.id, created.name ?? name);
    } catch (err: unknown) {
      // 409 重名等后端拒因经 getErrMsg 透出（拦截器已弹过的错误会被去重）。
      showApiError(err, t('templates.useDialog.fail'));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={template !== null}
      title={t('templates.useDialog.title')}
      okText={t('templates.useDialog.ok')}
      cancelText={t('templates.useDialog.cancel')}
      onOk={() => void handleConfirm()}
      onCancel={handleCancel}
      confirmLoading={submitting}
      okButtonProps={{ loading: submitting, disabled: submitting }}
      cancelButtonProps={{ disabled: submitting }}
      closable={!submitting}
      keyboard={!submitting}
      mask={{ closable: !submitting }}
      destroyOnHidden
      width={520}
    >
      {template && (
        <>
          <Form.Item label={t('templates.useDialog.template', { name: template.name })}>
            <span />
          </Form.Item>
          <Form form={form} layout="vertical" preserve={false}>
            <Form.Item
              name="name"
              label={t('templates.useDialog.name')}
              rules={[{
                required: true,
                whitespace: true,
                message: t('templates.useDialog.nameRequired'),
              }]}
            >
              <Input
                data-testid="instantiate-name-input"
                placeholder={t('templates.useDialog.namePlaceholder')}
                maxLength={TASK_NAME_MAX_LENGTH}
                autoFocus
              />
            </Form.Item>
          </Form>
          <span>{t('templates.useDialog.hint')}</span>
        </>
      )}
    </Modal>
  );
}
