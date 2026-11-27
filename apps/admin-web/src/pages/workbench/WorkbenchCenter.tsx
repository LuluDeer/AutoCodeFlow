/**
 * Center pane: timeline + prompt-first composer, or a calm empty state before
 * the first session is selected. Pure presentation; all state/handlers come
 * from WorkbenchPage.
 */
import { Button, Empty, Typography } from 'antd';
import { SendOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import WorkbenchComposer, { type ComposerDraft } from '../../components/workbench/WorkbenchComposer';
import WorkbenchTimeline from '../../components/workbench/WorkbenchTimeline';
import type {
  WorkbenchApprovalDecision,
  WorkbenchSessionDetail,
} from './types-public';

export interface WorkbenchCenterProps {
  detail: WorkbenchSessionDetail | null;
  live: boolean;
  running: boolean;
  sending: boolean;
  actingKey: string | null;
  starterPrompt: string;
  starterCadence: 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly';
  seedToken: number;
  onSend: (draft: ComposerDraft) => void;
  onCancel: () => void;
  onDecide: (key: string, decision: WorkbenchApprovalDecision) => void;
  onRetry: (text: string) => void;
}

export default function WorkbenchCenter({
  detail, live, running, sending, actingKey,
  starterPrompt, starterCadence, seedToken,
  onSend, onCancel, onDecide, onRetry,
}: WorkbenchCenterProps) {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 12 }}>
      {detail ? (
        <>
          <div style={{ flex: 1, minHeight: 0 }}>
            <WorkbenchTimeline
              detail={detail}
              live={live}
              actingKey={actingKey}
              onDecide={onDecide}
              onRetry={onRetry}
            />
          </div>
          <WorkbenchComposer
            onSend={onSend}
            onCancel={onCancel}
            running={running}
            sending={sending}
            initialPrompt={starterPrompt}
            initialCadence={starterCadence}
            seedToken={seedToken}
          />
        </>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('workbench.empty.title')}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('workbench.empty.desc')}
              </Typography.Text>
              <Button
                type="primary"
                icon={<SendOutlined aria-hidden />}
                onClick={() => onSend({
                  prompt: t('workbench.starter.summarize.prompt'),
                  cadence: 'once',
                  params: {},
                  attachmentNames: [],
                })}
                data-testid="workbench-empty-start"
              >
                {t('workbench.starter.summarize.label')}
              </Button>
            </div>
          </Empty>
        </div>
      )}
    </div>
  );
}
