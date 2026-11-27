/**
 * UX-AUDIT / Writer B：工作台「运行我的草稿」动作区（按钮 + 错误重试 + 会话面板）。
 * 从 WorkbenchPage 外提以守住该函数体的 check:size-caps 天花板（300 行）。
 * 纯展示 + 回调，不持有业务状态（状态由 useWorkbenchSession 持有）。
 */
import { Alert, Button, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import WorkbenchSessionPanel, { type WorkbenchSessionView } from './WorkbenchSessionPanel';
import '../../i18n';

export interface WorkbenchSessionActionProps {
  error: string | null;
  starting: boolean;
  sessionId: string | null;
  session: WorkbenchSessionView | null;
  onStart: () => void;
}

export default function WorkbenchSessionAction({
  error, starting, sessionId, session, onStart,
}: WorkbenchSessionActionProps) {
  const { t } = useTranslation();
  return (
    <div style={{ marginTop: 8 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
        {t('workbench.runDraftHint')}
      </Typography.Text>
      <Button
        type="primary"
        data-testid="workbench-run-draft"
        loading={starting}
        disabled={!!sessionId}
        onClick={onStart}
      >
        {t('workbench.runDraft')}
      </Button>
      {error && (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 8 }}
          title={error}
          action={
            <Button size="small" data-testid="workbench-session-retry" onClick={onStart}>
              {t('workbench.session.retry')}
            </Button>
          }
        />
      )}
      {session && <WorkbenchSessionPanel session={session} />}
    </div>
  );
}
