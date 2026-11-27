/**
 * Prompt-first composer: auto-growing textarea, Enter to send / Shift+Enter
 * newline, optional cadence chips, key-value builder, and a safe file
 * placeholder (files are named only — no bytes are uploaded yet).
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Input, Popover, Space, Tag, Tooltip, Typography } from 'antd';
import { PaperClipOutlined, SendOutlined, StopOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { ComposerCadence } from '../../pages/workbench/types-public';

const { Text } = Typography;

const CADENCES: ComposerCadence[] = ['once', 'hourly', 'daily', 'weekly', 'monthly'];

function cadenceLabel(t: (k: string) => string, cadence: ComposerCadence): string {
  switch (cadence) {
    case 'once': return t('workbench.cadence.once');
    case 'hourly': return t('workbench.cadence.hourly');
    case 'daily': return t('workbench.cadence.daily');
    case 'weekly': return t('workbench.cadence.weekly');
    case 'monthly': return t('workbench.cadence.monthly');
    default: return cadence;
  }
}

export interface ComposerDraft {
  prompt: string;
  cadence: ComposerCadence;
  params: Record<string, string>;
  attachmentNames: string[];
}

export interface WorkbenchComposerProps {
  onSend: (draft: ComposerDraft) => void;
  onCancel: () => void;
  running: boolean;
  sending: boolean;
  disabled?: boolean;
  initialPrompt?: string;
  initialCadence?: ComposerCadence;
  /** Value-change token: bump to re-apply the initial prompt. */
  seedToken?: number;
}

export default function WorkbenchComposer({
  onSend, onCancel, running, sending, disabled, initialPrompt = '', initialCadence = 'once', seedToken = 0,
}: WorkbenchComposerProps) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState(initialPrompt);
  const [cadence, setCadence] = useState<ComposerCadence>(initialCadence);
  const [params, setParams] = useState<Array<{ key: string; value: string }>>([]);
  const [attachmentNames, setAttachmentNames] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (initialPrompt) setPrompt(initialPrompt);
    if (initialCadence) setCadence(initialCadence);
  }, [initialPrompt, initialCadence, seedToken]);

  const trimmed = prompt.trim();
  const canSend = trimmed.length > 0 && !disabled && !sending;

  const submit = () => {
    if (!canSend) return;
    const record: Record<string, string> = {};
    for (const item of params) {
      const key = item.key.trim();
      if (key) record[key] = item.value;
    }
    onSend({ prompt: trimmed, cadence, params: record, attachmentNames });
    setPrompt('');
    setParams([]);
    setAttachmentNames([]);
    if (fileRef.current) fileRef.current.value = '';
  };

  const kvEditor = (
    <div style={{ width: 320 }}>
      {params.map((item, idx) => (
        <Space key={idx} size={4} style={{ marginBottom: 6 }}>
          <Input
            size="small"
            aria-label={t('workbench.params.key')}
            placeholder={t('workbench.params.key')}
            value={item.key}
            onChange={(e) => setParams((prev) => prev.map((p, i) => i === idx ? { ...p, key: e.target.value } : p))}
          />
          <Input
            size="small"
            aria-label={t('workbench.params.value')}
            placeholder={t('workbench.params.value')}
            value={item.value}
            onChange={(e) => setParams((prev) => prev.map((p, i) => i === idx ? { ...p, value: e.target.value } : p))}
          />
          <Button
            type="text"
            size="small"
            danger
            onClick={() => setParams((prev) => prev.filter((_, i) => i !== idx))}
            aria-label={t('workbench.params.remove')}
          >
            ×
          </Button>
        </Space>
      ))}
      <Button
        type="dashed"
        size="small"
        block
        onClick={() => setParams((prev) => [...prev, { key: '', value: '' }])}
      >
        {t('workbench.params.add')}
      </Button>
    </div>
  );

  return (
    <div data-testid="workbench-composer" style={{ borderTop: '1px solid rgba(127,127,127,0.18)', paddingTop: 12 }}>
      <Input.TextArea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={t('workbench.composer.placeholder')}
        autoSize={{ minRows: 2, maxRows: 8 }}
        disabled={disabled || sending}
        data-testid="workbench-composer-input"
      />

      {attachmentNames.length > 0 ? (
        <Space size={4} wrap style={{ marginTop: 6 }}>
          {attachmentNames.map((name) => (
            <Tag
              key={name}
              closable
              onClose={() => setAttachmentNames((prev) => prev.filter((n) => n !== name))}
            >
              {name}
            </Tag>
          ))}
        </Space>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
        <Space size={4} wrap>
          <Popover content={kvEditor} title={t('workbench.params.title')} trigger="click" placement="topLeft">
            <Button size="small" type="text" disabled={disabled}>{t('workbench.params.button')}</Button>
          </Popover>
          <Tooltip title={t('workbench.attach.hint')}>
            <Button
              size="small"
              type="text"
              icon={<PaperClipOutlined aria-hidden />}
              disabled={disabled}
              onClick={() => fileRef.current?.click()}
            >
              {t('workbench.attach.button')}
            </Button>
          </Tooltip>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            data-testid="workbench-composer-file"
            onChange={(e) => {
              const names = Array.from(e.target.files ?? []).map((f) => f.name);
              setAttachmentNames((prev) => [...prev, ...names]);
            }}
          />
          <Text type="secondary" style={{ fontSize: 11 }}>{t('workbench.composer.enterHint')}</Text>
        </Space>

        <Space size={4}>
          <Space size={2} wrap>
            {CADENCES.map((value) => (
              <Button
                key={value}
                size="small"
                type={cadence === value ? 'primary' : 'text'}
                onClick={() => setCadence(value)}
                disabled={disabled}
              >
                {cadenceLabel(t, value)}
              </Button>
            ))}
          </Space>
          {running ? (
            <Button
              danger
              size="small"
              icon={<StopOutlined aria-hidden />}
              onClick={onCancel}
              data-testid="workbench-stop"
            >
              {t('workbench.action.stop')}
            </Button>
          ) : null}
          <Button
            type="primary"
            size="small"
            icon={<SendOutlined aria-hidden />}
            loading={sending}
            disabled={!canSend}
            onClick={submit}
            data-testid="workbench-send"
          >
            {t('workbench.action.send')}
          </Button>
        </Space>
      </div>
    </div>
  );
}
