import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Modal,
  Space,
  Tabs,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import {
  taskTemplatesApi,
  type TaskTemplate,
  type ImportTemplatePayload,
} from '../api/task-templates';
import { showApiError } from '../utils/error';
import {
  parseTemplateImportText,
  previewTemplateConflicts,
  type TemplateImportConflict,
  type TemplateImportErrorCode,
  type TemplateImportIssue,
} from '../utils/templateImport';
import '../i18n';

const { Text } = Typography;

const ISSUE_KEY: Record<TemplateImportErrorCode, string> = {
  notJson: 'templateImport.error.notJson',
  notObject: 'templateImport.error.notObject',
  nameMissing: 'templateImport.error.nameMissing',
  nameBlank: 'templateImport.error.nameBlank',
  nameInvalid: 'templateImport.error.nameInvalid',
  versionMissing: 'templateImport.error.versionMissing',
  versionInvalid: 'templateImport.error.versionInvalid',
  descriptionMissing: 'templateImport.error.descriptionMissing',
  descriptionBlank: 'templateImport.error.descriptionBlank',
  descriptionTooLong: 'templateImport.error.descriptionTooLong',
  configNotObject: 'templateImport.error.configNotObject',
};

export interface TemplateImportModalProps {
  open: boolean;
  onClose: () => void;
  existing: Pick<TaskTemplate, 'id' | 'key' | 'name'>[];
  onImported: () => void;
}

export default function TemplateImportModal({
  open,
  onClose,
  existing,
  onImported,
}: TemplateImportModalProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'file' | 'paste'>('file');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [issues, setIssues] = useState<TemplateImportIssue[]>([]);
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);
  const [conflicts, setConflicts] = useState<TemplateImportConflict[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [importedName, setImportedName] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTab('file');
      setText('');
      setFileName(null);
      setIssues([]);
      setPayload(null);
      setConflicts([]);
      setAcknowledged(false);
      setSubmitting(false);
      setImportedName(null);
    }
  }, [open]);

  const readFile = async (file: File): Promise<void> => {
    setFileName(file.name);
    try {
      setText(await file.text());
    } catch {
      setText('');
      message.error(t('templateImport.error.readFile'));
    }
  };

  const handleParse = (): void => {
    const parsed = parseTemplateImportText(text);
    if (!parsed.ok) {
      setIssues(parsed.issues);
      setPayload(null);
      setConflicts([]);
      return;
    }
    setIssues([]);
    setPayload(parsed.payload);
    setConflicts(previewTemplateConflicts(parsed.payload, existing));
    setAcknowledged(false);
  };

  const handleBack = (): void => {
    setPayload(null);
    setConflicts([]);
    setIssues([]);
    setAcknowledged(false);
  };

  const handleSubmit = async (): Promise<void> => {
    if (!payload || submitting) return;
    setSubmitting(true);
    try {
      const created = await taskTemplatesApi.importTemplate(
        payload as ImportTemplatePayload,
      );
      setImportedName(created.name);
      onImported();
    } catch (err: unknown) {
      showApiError(err, t('templateImport.submitFail'));
    } finally {
      setSubmitting(false);
    }
  };

  const conflictBlock = conflicts.length > 0 && (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      message={t('templateImport.conflict.title', { count: conflicts.length })}
      description={
        <Space direction="vertical" size={4}>
          {conflicts.map((c, i) => (
            <Text key={i} type="warning">
              {t('templateImport.conflict.key', { key: c.key, name: c.existingName ?? '' })}
            </Text>
          ))}
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('templateImport.conflict.noOverwrite')}
          </Text>
        </Space>
      }
    />
  );

  const reviewBody = payload && (
    <>
      {conflictBlock}
      <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
        <Descriptions.Item label={t('templateImport.review.key')}>
          {String(payload.name)}
        </Descriptions.Item>
        <Descriptions.Item label={t('templateImport.review.version')}>
          {String(payload.version ?? '—')}
        </Descriptions.Item>
        <Descriptions.Item label={t('templateImport.review.description')}>
          {String(payload.description ?? '—')}
        </Descriptions.Item>
      </Descriptions>
      {conflicts.length > 0 && (
        <Checkbox checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)}>
          {t('templateImport.conflict.acknowledge')}
        </Checkbox>
      )}
    </>
  );

  const inputBody = (
    <>
      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as 'file' | 'paste')}
        items={[
          {
            key: 'file',
            label: t('templateImport.tab.file'),
            children: (
              <Upload.Dragger
                accept=".json,application/json"
                showUploadList={false}
                beforeUpload={(file) => {
                  void readFile(file);
                  return false;
                }}
              >
                <p style={{ margin: '12px 0 4px' }}>
                  <UploadOutlined aria-hidden />
                </p>
                <Text type="secondary">{t('templateImport.file.hint')}</Text>
                {fileName && <div><Tag>{fileName}</Tag></div>}
              </Upload.Dragger>
            ),
          },
          {
            key: 'paste',
            label: t('templateImport.tab.paste'),
            children: (
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t('templateImport.paste.placeholder')}
                spellCheck={false}
                style={{ width: '100%', minHeight: 180, fontFamily: 'monospace', fontSize: 12 }}
              />
            ),
          },
        ]}
      />
      {issues.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 12 }}
          message={t('templateImport.error.title')}
          description={
            <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
              {issues.map((issue, i) => (
                <li key={i}>{t(ISSUE_KEY[issue.code], issue.params ?? {})}</li>
              ))}
            </ul>
          }
        />
      )}
    </>
  );

  const okDisabled = submitting || (conflicts.length > 0 && !acknowledged);

  return (
    <Modal
      open={open}
      title={t('templateImport.title')}
      onCancel={onClose}
      destroyOnHidden
      width={560}
      mask={{ closable: !submitting }}
      closable={!submitting}
      keyboard={!submitting}
      footer={
        importedName ? (
          <Space>
            <Button type="primary" onClick={onClose}>{t('templateImport.result.close')}</Button>
          </Space>
        ) : payload ? (
          <Space>
            <Button onClick={handleBack} disabled={submitting}>{t('templateImport.back')}</Button>
            <Button onClick={onClose} disabled={submitting}>{t('templateImport.cancel')}</Button>
            <Button type="primary" loading={submitting} disabled={okDisabled} onClick={() => void handleSubmit()}>
              {t('templateImport.submit')}
            </Button>
          </Space>
        ) : (
          <Space>
            <Button onClick={onClose}>{t('templateImport.cancel')}</Button>
            <Button type="primary" disabled={!text.trim()} onClick={handleParse}>
              {t('templateImport.parse')}
            </Button>
          </Space>
        )
      }
    >
      {importedName ? (
        <Alert
          type="success"
          showIcon
          message={t('templateImport.result.created', { name: importedName })}
        />
      ) : payload ? reviewBody : inputBody}
    </Modal>
  );
}
