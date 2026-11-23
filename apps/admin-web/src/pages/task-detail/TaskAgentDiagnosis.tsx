import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Form, Input, Modal, Typography } from 'antd';
import { RobotOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { agentApi } from '../../api/agent';
import { useModalA11y } from '../../hooks/useModalA11y';
import { isAdminUser, useAuthStore } from '../../store/auth';
import { agentSessionUrl } from '../../utils/agentSessionUrl';
import { getErrMsg, showApiError } from '../../utils/error';

const QUESTION_ID = 'task-agent-diagnosis-question';
const TARGET_ID = 'task-agent-diagnosis-target';

export default function TaskAgentDiagnosis({ taskId, taskName }: { taskId: string; taskName: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'creating' | 'failed'>('idle');
  const [requestErr, setRequestErr] = useState<unknown>(null);
  const inFlight = useRef(false);
  // A task/role change unmounts this action. A late response must not take over the new page.
  useEffect(() => () => { inFlight.current = false; }, []);
  const { contentRef } = useModalA11y(draft !== null);
  const target = t('taskDetail.agentTarget', { taskId });
  const question = draft?.trim();
  const creating = status === 'creating';
  const requestFallback = t('taskDetail.agentCreateFailed');
  // 原位 Alert 副文案：透出后端结构化错误 code/message；通用兜底标题与草稿问题保留。
  const requestDetail = status === 'failed' && requestErr != null
    ? getErrMsg(requestErr, requestFallback)
    : undefined;

  async function confirm() {
    if (!question || inFlight.current || !isAdminUser(useAuthStore.getState().user)) return;
    inFlight.current = true;
    setStatus('creating');
    const title = t('taskDetail.agentTitle', { name: taskName.trim() || taskId });
    let created;
    try {
      created = await agentApi.create({
        kind: 'ops_watch',
        title: Array.from(title).slice(0, 80).join(''),
        context: { taskId, question: `${target}\n${question}` },
        scope: { tasks: [taskId] },
      });
    } catch (err: unknown) {
      if (inFlight.current) {
        inFlight.current = false;
        // 后端错误码/消息经 showApiError 透出；原位 Alert 保留通用兜底与草稿问题。
        showApiError(err, t('taskDetail.agentCreateFailed'));
        setRequestErr(err);
        setStatus('failed');
      }
      return;
    }
    // Keep the confirmed request locked until navigation unmounts the task page.
    if (inFlight.current) navigate(agentSessionUrl(created.id));
  }

  return (
    <>
      <Button
        icon={<RobotOutlined />}
        aria-haspopup="dialog"
        disabled={creating}
        onClick={() => {
          setStatus('idle');
          setRequestErr(null);
          setDraft(t('taskDetail.agentDefaultQuestion'));
        }}
      >
        {t('taskDetail.agentDiagnose')}
      </Button>
      <Modal
        open={draft !== null}
        title={t('taskDetail.agentDiagnose')}
        okText={t('taskDetail.agentConfirm')}
        cancelText={t('taskDetail.cancel')}
        onOk={confirm}
        onCancel={() => { if (!inFlight.current) setDraft(null); }}
        confirmLoading={creating}
        okButtonProps={{ disabled: creating || !question }}
        cancelButtonProps={{ disabled: creating }}
        closable={!creating}
        keyboard={!creating}
        mask={{ closable: !creating }}
        destroyOnHidden
      >
        <div ref={contentRef} aria-busy={creating}>
          <Typography.Paragraph id={TARGET_ID} style={{ overflowWrap: 'anywhere' }}>
            <strong>{taskName}</strong><br />{target}
          </Typography.Paragraph>
          <Typography.Paragraph>{t('taskDetail.agentReadOnly')}</Typography.Paragraph>
          <Form layout="vertical" component={false}>
            <Form.Item label={t('taskDetail.agentQuestion')} htmlFor={QUESTION_ID}>
              <Input.TextArea id={QUESTION_ID} aria-describedby={TARGET_ID} rows={3} maxLength={2000}
                value={draft ?? ''} disabled={creating} onChange={(event) => {
                  setDraft(event.target.value);
                  setStatus('idle');
                  setRequestErr(null);
                }} />
            </Form.Item>
          </Form>
          {status === 'failed' && (
            <Alert role="alert" type="error" showIcon title={requestFallback} description={requestDetail} />
          )}
        </div>
      </Modal>
    </>
  );
}
