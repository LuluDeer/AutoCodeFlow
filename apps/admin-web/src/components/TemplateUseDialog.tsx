import { useEffect, useMemo, useRef, useState } from 'react';
import { Form, Input, Modal } from 'antd';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { taskTemplatesApi, type TaskTemplate } from '../api/task-templates';
import { queryKeys } from '../api/queries';
import { showApiError } from '../utils/error';
import { message } from '../utils/toast';
import ManifestParamsFields from './template-use/ManifestParamsFields';
import RawParamsEditor from './template-use/RawParamsEditor';
import {
  buildInstantiateOverlay,
  initialParamValue,
  normalizeParam,
  readManifestParams,
  type ManifestParam,
  type SupportedParamType,
} from './template-use/manifestParams';

/** 与 admin-api `TASK_NAME_MAX_LENGTH` 对齐（DB varchar(255)，按码点计）。 */
const TASK_NAME_MAX_LENGTH = 255;
const CONTROL_CHARS_RE = /[\p{Cc}\p{Cf}]/gu;

function localStamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

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

type ParamEntry = { name: string; param: ManifestParam; type: SupportedParamType };

/** 「使用模板」：采集任务名 + 清单声明的 params，实例化时以 body overlay 透传。 */
export default function TemplateUseDialog({ template, onClose, onCreated }: TemplateUseDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<{ name: string; params?: Record<string, unknown> }>();
  const [submitting, setSubmitting] = useState(false);
  const [rawParams, setRawParams] = useState('{}');
  const [rawError, setRawError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  const manifestParams = useMemo(() => readManifestParams(template?.config), [template]);
  const entries = useMemo<ParamEntry[]>(() => {
    if (!manifestParams) return [];
    return Object.entries(manifestParams)
      .map(([name, param]) => ({ name, param, type: normalizeParam(name, param) }))
      .filter((entry): entry is ParamEntry => entry.type !== null);
  }, [manifestParams]);
  const useRawEditor = !!manifestParams && entries.length === 0;

  useEffect(() => {
    if (!template) return;
    const defaults: Record<string, unknown> = {};
    for (const entry of entries) defaults[entry.name] = initialParamValue(entry.param, entry.type);
    form.setFieldsValue({ name: defaultTaskName(template.name), params: defaults });
    setRawParams('{}');
    setRawError(null);
  }, [template, entries, form]);

  const close = () => {
    submittingRef.current = false;
    setSubmitting(false);
    form.resetFields();
    onClose();
  };

  const handleCancel = () => {
    if (submittingRef.current) return;
    close();
  };

  const parseRawParams = (): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(rawParams);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setRawError(t('templates.useDialog.rawParamsObject'));
        return null;
      }
      setRawError(null);
      return parsed as Record<string, unknown>;
    } catch {
      setRawError(t('templates.useDialog.rawParamsInvalid'));
      return null;
    }
  };

  const handleConfirm = async () => {
    if (!template || submittingRef.current) return;
    let values: { name?: string; params?: Record<string, unknown> };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const name = (values.name ?? '').trim();
    if (!name) return;

    const params = useRawEditor ? parseRawParams() : (values.params ?? {});
    if (!params) return;

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const created = await taskTemplatesApi.instantiate(
        template.id,
        buildInstantiateOverlay(name, params),
      );
      message.success(t('templates.useDialog.created', { name: created.name ?? name }));
      close();
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      onCreated(created.id, created.name ?? name);
    } catch (err: unknown) {
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
      width={560}
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
              rules={[{ required: true, whitespace: true, message: t('templates.useDialog.nameRequired') }]}
            >
              <Input
                data-testid="instantiate-name-input"
                placeholder={t('templates.useDialog.namePlaceholder')}
                maxLength={TASK_NAME_MAX_LENGTH}
                autoFocus
              />
            </Form.Item>
            {manifestParams && <ManifestParamsFields entries={entries} />}
          </Form>
          {useRawEditor && (
            <RawParamsEditor
              value={rawParams}
              onChange={(v) => { setRawParams(v); setRawError(null); }}
              entries={entries}
              error={rawError}
            />
          )}
          <span>{t('templates.useDialog.hint')}</span>
        </>
      )}
    </Modal>
  );
}
