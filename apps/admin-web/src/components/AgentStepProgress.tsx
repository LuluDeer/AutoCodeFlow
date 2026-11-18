import { Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { AgentStep } from '../api/agent';
import { formatDateTime } from '../utils/timeFormat';

/** Only render after a successful detail read. The backend's stall predicate
 * uses MAX(step.createdAt), not the last write to the session (updatedAt). */
export default function AgentStepProgress({ steps }: { steps: AgentStep[] }) {
  const { t } = useTranslation();
  let latest: AgentStep | undefined;
  let latestTime = -Infinity;
  for (const step of steps) {
    const time = Date.parse(step.createdAt);
    if (time > latestTime) { latest = step; latestTime = time; }
  }
  return <Typography.Paragraph>
    {latest ? <>
      <strong>{t('agents.progress.latest', { seq: latest.seq })}</strong>{' '}
      <time dateTime={latest.createdAt}>{formatDateTime(latest.createdAt)}</time>
    </> : steps.length ? t('agents.progress.noTime') : t('agents.progress.noSteps')}
  </Typography.Paragraph>;
}
