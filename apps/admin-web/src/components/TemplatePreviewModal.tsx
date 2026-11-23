import { useEffect, useState } from 'react';
import { Button, Descriptions, Modal, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { TaskTemplate } from '../api/task-templates';
import '../i18n';

const { Text, Paragraph } = Typography;

export interface TemplatePreviewModalProps {
  open: boolean;
  template: TaskTemplate | null;
  onClose: () => void;
}

/** 长文折叠阈值：超出后只留摘要，点「展开」看全文。 */
const PREVIEW_COLLAPSE_LINES = 6;

/**
 * P1-5：模板只读预览。展示完整说明（长文折叠）与 config JSON（等宽、可滚动）。
 * 不改任何数据；编辑走 TemplateEditModal。
 */
export default function TemplatePreviewModal({
  open,
  template,
  onClose,
}: TemplatePreviewModalProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (open) setExpanded(false);
  }, [open]);

  if (!template) return null;

  const description = template.description ?? '';
  const descLines = description.split('\n');
  const descCollapsed = descLines.length > PREVIEW_COLLAPSE_LINES && !expanded;
  const descText = descCollapsed ? descLines.slice(0, PREVIEW_COLLAPSE_LINES).join('\n') : description;
  const configJson = JSON.stringify(template.config ?? {}, null, 2);

  return (
    <Modal
      open={open}
      title={t('templatePreview.title', { name: template.name })}
      onCancel={onClose}
      destroyOnHidden
      width={600}
      footer={<Button onClick={onClose}>{t('templatePreview.close')}</Button>}
    >
      <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
        <Descriptions.Item label={t('templatePreview.key')}>{template.key}</Descriptions.Item>
        {template.category && (
          <Descriptions.Item label={t('templatePreview.category')}>{template.category}</Descriptions.Item>
        )}
      </Descriptions>

      <Paragraph type="secondary" style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }}>
        {descText || t('templatePreview.noDesc')}
      </Paragraph>
      {descLines.length > PREVIEW_COLLAPSE_LINES && (
        <Button type="link" size="small" onClick={() => setExpanded((v) => !v)} style={{ padding: 0, marginBottom: 8 }}>
          {expanded ? t('templatePreview.collapse') : t('templatePreview.expand')}
        </Button>
      )}

      <Text type="secondary" style={{ fontSize: 12 }}>{t('templatePreview.config')}</Text>
      <pre
        style={{
          margin: '4px 0 0',
          padding: 12,
          maxHeight: 240,
          overflow: 'auto',
          borderRadius: 8,
          background: 'var(--log-bg)',
          color: 'var(--log-text)',
          fontFamily: 'monospace',
          fontSize: 12,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {configJson}
      </pre>
    </Modal>
  );
}
