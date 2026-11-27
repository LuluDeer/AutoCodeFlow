import { Button, Card, Space, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { DesktopAgentEventType } from '../../api/desktop-bridge';
import { useDesktopAgent } from '../../hooks/workbench/useDesktopAgent';

const { Text } = Typography;

function eventTypeLabel(t: (key: string) => string, type: DesktopAgentEventType): string {
  switch (type) {
    case 'phase': return t('workbench.desktop.eventType.phase');
    case 'plan': return t('workbench.desktop.eventType.plan');
    case 'file': return t('workbench.desktop.eventType.file');
    case 'trial': return t('workbench.desktop.eventType.trial');
    case 'browser': return t('workbench.desktop.eventType.browser');
    case 'gui': return t('workbench.desktop.eventType.gui');
    case 'screenshot': return t('workbench.desktop.eventType.screenshot');
    case 'verify': return t('workbench.desktop.eventType.verify');
    case 'status': return t('workbench.desktop.eventType.status');
    case 'error': return t('workbench.desktop.eventType.error');
    default: return type;
  }
}

/**
 * 桌面工作台专属状态条：仅在窄桥完整存在时渲染。
 * 事件 payload 经过白名单归一化后只作为 React 文本节点展示，不执行、不注入 HTML。
 */
export default function DesktopAgentStrip() {
  const { t } = useTranslation();
  const { bridge, context, events, running, cancelling, cancelError, cancelAssignment } = useDesktopAgent();

  if (!bridge) return null;

  const executorName = context.executorName?.trim() || t('workbench.desktop.executorUnknown');
  const agentEnabled = context.agentEnabled === true;
  const platformConfigured = context.platformConfigured === true;
  const recentEvents = events.slice(-5);

  return (
    <Card
      size="small"
      title={t('workbench.desktop.title')}
      data-testid="desktop-agent-strip"
      style={{ marginBottom: 12 }}
    >
      <Space size={4} wrap>
        <Text data-testid="desktop-agent-executor">
          {t('workbench.desktop.executor')}: {executorName}
        </Text>
        <Tag color={agentEnabled ? 'success' : 'default'} data-testid="desktop-agent-enabled">
          {agentEnabled ? t('workbench.desktop.agentEnabled') : t('workbench.desktop.agentDisabled')}
        </Tag>
        <Tag color={platformConfigured ? 'blue' : 'warning'} data-testid="desktop-agent-platform">
          {platformConfigured
            ? t('workbench.desktop.platformConfigured')
            : t('workbench.desktop.platformMissing')}
        </Tag>
        {running ? (
          <Button
            size="small"
            danger
            loading={cancelling}
            onClick={() => void cancelAssignment()}
            data-testid="desktop-agent-cancel"
          >
            {t('workbench.desktop.cancel')}
          </Button>
        ) : null}
      </Space>

      <div data-testid="desktop-agent-events" style={{ marginTop: 8 }}>
        {recentEvents.length === 0 ? (
          <Text type="secondary">{t('workbench.desktop.noEvents')}</Text>
        ) : (
          recentEvents.map((event, index) => (
            <div key={`${event.assignmentId}:${event.timestamp}:${index}`} data-testid="desktop-agent-event">
              <Text strong>{eventTypeLabel(t, event.type)}</Text>
              <Text> · {event.summary}</Text>
              {event.detail ? <Text type="secondary"> — {event.detail}</Text> : null}
            </div>
          ))
        )}
      </div>

      {cancelError ? (
        <Text type="danger" data-testid="desktop-agent-cancel-error">
          {t('workbench.desktop.cancelFailed')}
        </Text>
      ) : null}
    </Card>
  );
}
