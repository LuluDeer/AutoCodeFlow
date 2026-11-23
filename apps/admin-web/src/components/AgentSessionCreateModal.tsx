import { useEffect, useRef, useState } from 'react';
import { Alert, Form, Input, Modal, Select } from 'antd';
import { useTranslation } from 'react-i18next';
import { agentApi } from '../api/agent';
import { useModalA11y } from '../hooks/useModalA11y';
import { agentKindLabel } from '../utils/agent-label';
import { message } from '../utils/toast';
import { showApiError } from '../utils/error';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

const KINDS = ['chat', 'ops_watch', 'incident', 'sop_authoring', 'sop_review', 'app_scaffold'];
const FIELD = {
  kind: 'agents-create-kind',
  title: 'agents-create-title',
  titleHint: 'agents-create-title-hint',
  question: 'agents-create-question',
  context: 'agents-create-context',
  error: 'agents-create-error',
} as const;
const EMPTY_DRAFT = { kind: 'chat', title: '', question: '', context: '' };
type Draft = typeof EMPTY_DRAFT;
type ValidationError = 'invalidContext' | 'invalidQuestion' | 'conflict' | 'missingGoal';
type CreateBody = Pick<Parameters<typeof agentApi.create>[0], 'kind' | 'title' | 'context'>;

function prepareCreate(draft: Draft): { body: CreateBody } | { error: ValidationError } {
  const kind = draft.kind;
  const title = draft.title.trim();
  const question = draft.question.trim();
  let context: Record<string, unknown> | undefined;
  if (draft.context.trim()) {
    try {
      const parsed: unknown = JSON.parse(draft.context);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'invalidContext' };
      }
      context = parsed as Record<string, unknown>;
    } catch {
      return { error: 'invalidContext' };
    }
  }

  const jsonQuestion = context?.question;
  if (jsonQuestion !== undefined) {
    if (typeof jsonQuestion !== 'string' || !jsonQuestion.trim()) return { error: 'invalidQuestion' };
    if (question && question !== jsonQuestion.trim()) return { error: 'conflict' };
    // Two matching questions describe one goal. Keep the supplied JSON as-is.
  } else if (question) {
    context = { question, ...context };
  } else if (kind === 'chat' && !(typeof context?.goal === 'string' && context.goal.trim())) {
    // The runtime reads context, not the display title. Preserve title-only chat,
    // but don't reinterpret a title as an instruction alongside other metadata.
    if (!title || (context && Object.keys(context).length > 0)) return { error: 'missingGoal' };
    context = { question: title };
  }
  return { body: { kind, ...(title ? { title } : {}), ...(context ? { context } : {}) } };
}

export default function AgentSessionCreateModal({ open, onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const { contentRef } = useModalA11y(open);
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [error, setError] = useState<ValidationError | 'request' | null>(null);
  const [creating, setCreating] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => () => { inFlight.current = false; }, []);

  function change(field: keyof Draft, value: string) {
    setDraft(prev => ({ ...prev, [field]: value }));
    setError(null);
  }

  async function submit() {
    if (inFlight.current) return;
    const result = prepareCreate(draft);
    if ('error' in result) {
      setError(result.error);
      const field = result.error === 'missingGoal' ? 'question' : 'context';
      if (field === 'context' && advancedRef.current) advancedRef.current.open = true;
      contentRef.current?.querySelector<HTMLTextAreaElement>(`#${FIELD[field]}`)?.focus();
      return;
    }

    inFlight.current = true;
    setCreating(true);
    setError(null);
    let id: string;
    try {
      ({ id } = await agentApi.create(result.body));
      if (!inFlight.current) return; // Left the page while creating: don't open its drawer now.
    } catch (err: unknown) {
      if (!inFlight.current) return;
      // 后端错误码/消息经 showApiError 透出（拦截器已弹过的按标去重）；原位 Alert 保留通用兜底与草稿。
      showApiError(err, t('agents.createFailed'));
      setError('request');
      return;
    } finally {
      if (inFlight.current) {
        inFlight.current = false;
        setCreating(false);
      }
    }
    setDraft({ ...EMPTY_DRAFT, kind: draft.kind });
    message.success(t('agents.createOk'));
    onClose();
    onCreated(id);
  }

  const errorMessage = error && {
    invalidContext: t('agents.createInvalidContext'),
    invalidQuestion: t('agents.createInvalidQuestion'),
    conflict: t('agents.createQuestionConflict'),
    missingGoal: t('agents.createGoalRequired'),
    request: t('agents.createFailed'),
  }[error];
  const questionInvalid = error === 'missingGoal';
  const contextInvalid = error !== null && error !== 'request' && !questionInvalid;
  return (
    <Modal
      open={open}
      title={t('agents.createDialogTitle')}
      okText={t('agents.create')}
      cancelText={t('agents.createCancel')}
      confirmLoading={creating}
      okButtonProps={{ disabled: creating }}
      cancelButtonProps={{ disabled: creating }}
      closable={!creating}
      keyboard={!creating}
      mask={{ closable: !creating }}
      onOk={() => void submit()}
      onCancel={() => {
        if (inFlight.current) return;
        setError(null);
        onClose();
      }}
      destroyOnHidden
    >
      <div ref={contentRef} aria-busy={creating}>
        <Form layout="vertical" component={false} disabled={creating}>
          <Form.Item label={t('agents.createKind')} htmlFor={FIELD.kind} style={{ marginBottom: 16 }}>
            <Select
              id={FIELD.kind}
              value={draft.kind}
              onChange={value => change('kind', value)}
              options={KINDS.map(value => ({ value, label: agentKindLabel(value, t) }))}
            />
          </Form.Item>
          <Form.Item label={t('agents.createQuestion')} htmlFor={FIELD.question} style={{ marginBottom: 16 }}>
            <Input.TextArea
              id={FIELD.question}
              rows={3}
              value={draft.question}
              onChange={e => change('question', e.target.value)}
              placeholder={t('agents.createQuestionPlaceholder')}
              aria-invalid={questionInvalid || undefined}
              aria-describedby={questionInvalid ? FIELD.error : undefined}
            />
          </Form.Item>
          <Form.Item
            label={t('agents.createTitle')}
            htmlFor={FIELD.title}
            extra={draft.kind === 'chat' && <span id={FIELD.titleHint}>{t('agents.createTitleHint')}</span>}
            style={{ marginBottom: 16 }}
          >
            <Input
              id={FIELD.title}
              aria-describedby={draft.kind === 'chat' ? FIELD.titleHint : undefined}
              maxLength={255}
              value={draft.title}
              onChange={e => change('title', e.target.value)}
              placeholder={t('agents.createTitlePlaceholder')}
            />
          </Form.Item>
          <details ref={advancedRef}>
            <summary style={{ cursor: 'pointer' }}>{t('agents.createAdvanced')}</summary>
            <Form.Item label={t('agents.createContext')} htmlFor={FIELD.context} style={{ margin: '8px 0 0' }}>
              <Input.TextArea
                id={FIELD.context}
                rows={4}
                value={draft.context}
                onChange={e => change('context', e.target.value)}
                placeholder={t('agents.createContextPlaceholder')}
                aria-invalid={contextInvalid || undefined}
                aria-describedby={contextInvalid ? FIELD.error : undefined}
              />
            </Form.Item>
          </details>
        </Form>
        {errorMessage && <Alert id={FIELD.error} role="alert" type="error" showIcon title={errorMessage} style={{ marginTop: 16 }} />}
      </div>
    </Modal>
  );
}
