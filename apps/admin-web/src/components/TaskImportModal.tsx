import { useEffect, useMemo, useState } from 'react';
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
import { tasksApi, type Task } from '../api/tasks';
import type { components } from '../types/generated/api-types';
import { showApiError } from '../utils/error';
import {
  parseTaskImportText,
  previewTaskConflicts,
  type ImportConflict,
  type ImportErrorCode,
  type ImportValidationIssue,
} from '../utils/taskImport';
import '../i18n';

const { Text, Paragraph } = Typography;

/** 校验问题码 → i18n 键（params 由纯函数 issues 携带，供插值）。 */
const ISSUE_KEY: Record<ImportErrorCode, string> = {
  notJson: 'taskImport.error.notJson',
  arrayNotSupported: 'taskImport.error.arrayNotSupported',
  notObject: 'taskImport.error.notObject',
  schemaVersionMissing: 'taskImport.error.schemaVersionMissing',
  schemaVersionMismatch: 'taskImport.error.schemaVersionMismatch',
  taskMissing: 'taskImport.error.taskMissing',
  taskNotObject: 'taskImport.error.taskNotObject',
  nameMissing: 'taskImport.error.nameMissing',
  nameNotString: 'taskImport.error.nameNotString',
  nameBlank: 'taskImport.error.nameBlank',
  nameTooLong: 'taskImport.error.nameTooLong',
  triggerTypeMissing: 'taskImport.error.triggerTypeMissing',
  triggerTypeInvalid: 'taskImport.error.triggerTypeInvalid',
  runtimeInvalid: 'taskImport.error.runtimeInvalid',
  idInvalid: 'taskImport.error.idInvalid',
};

export interface TaskImportModalProps {
  open: boolean;
  onClose: () => void;
  /** 当前列表快照，用于客户端冲突预览（重名 / id 已存在 / 项目不一致）。 */
  existing: Pick<Task, 'id' | 'name' | 'projectId'>[];
  /** 当前项目筛选上下文（跨项目导入提示用）。 */
  currentProjectId?: string | null;
  /** 导入成功后刷新列表（失效 tasks 缓存）。 */
  onImported: () => void;
  /** 「去查看」跳转任务详情。 */
  onViewDetail: (taskId: string) => void;
}

interface ImportResult {
  taskId: string;
  name: string;
  warnings: string[];
}

function conflictText(conflict: ImportConflict, t: import('i18next').TFunction): string {
  if (conflict.type === 'name') {
    return t('taskImport.conflict.name', { name: conflict.existingName ?? '' });
  }
  if (conflict.type === 'id') {
    return t('taskImport.conflict.id', { id: conflict.existingId ?? '' });
  }
  return t('taskImport.conflict.project', { projectId: conflict.projectId ?? '' });
}

export default function TaskImportModal({
  open,
  onClose,
  existing,
  currentProjectId,
  onImported,
  onViewDetail,
}: TaskImportModalProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'file' | 'paste'>('file');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [issues, setIssues] = useState<ImportValidationIssue[]>([]);
  const [payload, setPayload] = useState<components['schemas']['ImportTaskDto'] | null>(null);
  const [conflicts, setConflicts] = useState<ImportConflict[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  // 每次打开重置为输入态：避免上一次的粘贴文本 / 结果残留。
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
      setResult(null);
    }
  }, [open]);

  const parsedTask = useMemo(() => {
    if (!payload) return null;
    return payload.task as Record<string, unknown>;
  }, [payload]);

  const readFile = async (file: File): Promise<void> => {
    setFileName(file.name);
    try {
      setText(await file.text());
    } catch {
      setText('');
      message.error(t('taskImport.error.readFile'));
    }
  };

  const handleParse = (): void => {
    const parsed = parseTaskImportText(text);
    if (!parsed.ok) {
      setIssues(parsed.issues);
      setPayload(null);
      setConflicts([]);
      return;
    }
    setIssues([]);
    setPayload(parsed.payload);
    setConflicts(previewTaskConflicts(parsed.payload, existing, currentProjectId));
    setAcknowledged(false);
  };

  const handleBackToInput = (): void => {
    setPayload(null);
    setConflicts([]);
    setIssues([]);
    setAcknowledged(false);
  };

  const handleSubmit = async (): Promise<void> => {
    if (!payload || submitting) return;
    setSubmitting(true);
    try {
      const created = await tasksApi.importDefinition(payload);
      setResult({ taskId: created.taskId, name: created.name, warnings: created.warnings ?? [] });
      onImported();
    } catch (err: unknown) {
      // 后端拒因（400 载荷非法 / 403 项目无权 / 409 名称全冲突）透出；弹窗留在复核态可改后重试。
      showApiError(err, t('taskImport.submitFail'));
    } finally {
      setSubmitting(false);
    }
  };

  const conflictBlock = conflicts.length > 0 && (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      message={t('taskImport.conflict.title', { count: conflicts.length })}
      description={
        <Space orientation="vertical" size={4}>
          {conflicts.map((c, i) => (
            <Text key={i} type="warning">{conflictText(c, t)}</Text>
          ))}
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('taskImport.conflict.noOverwrite')}
          </Text>
        </Space>
      }
    />
  );

  const reviewBody = payload && parsedTask ? (
    <>
      {conflictBlock}
      <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
        <Descriptions.Item label={t('taskImport.review.name')}>{String(parsedTask.name)}</Descriptions.Item>
        <Descriptions.Item label={t('taskImport.review.triggerType')}>
          {String(parsedTask.triggerType ?? '—')}
        </Descriptions.Item>
        <Descriptions.Item label={t('taskImport.review.runtime')}>
          {parsedTask.runtime ? String(parsedTask.runtime) : '—'}
        </Descriptions.Item>
        {parsedTask.projectId != null && (
          <Descriptions.Item label={t('taskImport.review.projectId')}>
            {String(parsedTask.projectId)}
          </Descriptions.Item>
        )}
      </Descriptions>
      {conflicts.length > 0 && (
        <Checkbox checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)}>
          {t('taskImport.conflict.acknowledge')}
        </Checkbox>
      )}
    </>
  ) : null;

  const resultBody = result && (
    <>
      <Alert
        type="success"
        showIcon
        style={{ marginBottom: 12 }}
        message={t('taskImport.result.created', { count: 1, name: result.name })}
      />
      {result.warnings.length > 0 && (
        <Paragraph type="secondary" style={{ marginBottom: 8 }}>
          {t('taskImport.result.warnings')}
          <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
            {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Paragraph>
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
            label: t('taskImport.tab.file'),
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
                <Text type="secondary">{t('taskImport.file.hint')}</Text>
                {fileName && <div><Tag>{fileName}</Tag></div>}
              </Upload.Dragger>
            ),
          },
          {
            key: 'paste',
            label: t('taskImport.tab.paste'),
            children: (
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t('taskImport.paste.placeholder')}
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
          message={t('taskImport.error.title')}
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
      title={t('taskImport.title')}
      onCancel={onClose}
      destroyOnHidden
      width={560}
      mask={{ closable: !submitting }}
      closable={!submitting}
      keyboard={!submitting}
      footer={
        result ? (
          <Space>
            <Button onClick={onClose}>{t('taskImport.result.close')}</Button>
            <Button type="primary" onClick={() => onViewDetail(result.taskId)}>
              {t('taskImport.result.viewDetail')}
            </Button>
          </Space>
        ) : payload ? (
          <Space>
            <Button onClick={handleBackToInput} disabled={submitting}>{t('taskImport.back')}</Button>
            <Button onClick={onClose} disabled={submitting}>{t('taskImport.cancel')}</Button>
            <Button type="primary" loading={submitting} disabled={okDisabled} onClick={() => void handleSubmit()}>
              {t('taskImport.submit')}
            </Button>
          </Space>
        ) : (
          <Space>
            <Button onClick={onClose}>{t('taskImport.cancel')}</Button>
            <Button type="primary" disabled={!text.trim()} onClick={handleParse}>
              {t('taskImport.parse')}
            </Button>
          </Space>
        )
      }
    >
      {result ? resultBody : payload ? reviewBody : inputBody}
    </Modal>
  );
}
