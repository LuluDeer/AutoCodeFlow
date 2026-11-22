import { Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { AgentSession } from '../api/agent';

/** Present the persisted question and final answer as text, not as JSON or a
 * 200-character step preview. Never treat a tool result as the Agent's answer. */
export default function AgentSessionOutcome({ session }: { session: AgentSession }) {
  const { t } = useTranslation();
  const question = session.contextJson?.question;
  const answer = session.status === 'succeeded' ? session.resultJson?.conclusion : null;
  const style = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;
  return <>
    {typeof question === 'string' && question.trim() && <section aria-label={t('agents.questionHeading')}>
      <Typography.Title level={5}>{t('agents.questionHeading')}</Typography.Title>
      <Typography.Paragraph style={style}>{question}</Typography.Paragraph>
    </section>}
    {typeof answer === 'string' && answer.trim() ? <section aria-label={t('agents.answerHeading')}>
      <Typography.Title level={5}>{t('agents.answerHeading')}</Typography.Title>
      <Typography.Paragraph style={style}>{answer}</Typography.Paragraph>
    </section> : session.summary && <Typography.Paragraph type="secondary">{session.summary}</Typography.Paragraph>}
  </>;
}
