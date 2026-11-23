import { Alert, Button, Checkbox, Modal, Radio, Typography } from 'antd';
import { UpCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import type { AppDeployment } from '../../api/applications';
import { shortExecutorRowId } from '../../utils/executorRowId';

const { Text } = Typography;

function RouterInstallButton({ label }: { label: string }) {
  const nav = useNavigate();
  return (
    <Button size="small" onClick={() => nav('/executors/install')}>
      {label}
    </Button>
  );
}

/**
 * 跳转执行器安装向导按钮：在真实 Router 上下文内走 useNavigate SPA 跳转（消除 href 硬刷新），
 * 在未包裹 MemoryRouter 的独立组件单测内回退 pushState，避免裸调用 useNavigate 抛上下文异常。
 */
export function InstallExecutorButton({ label }: { label: string }) {
  const inRouter = useInRouterContext();
  if (inRouter) {
    return <RouterInstallButton label={label} />;
  }
  return (
    <Button
      size="small"
      onClick={() => window.history.pushState({}, '', '/executors/install')}
    >
      {label}
    </Button>
  );
}

export interface RolloutModalProps {
  open: boolean;
  upgradingAll: boolean;
  rolloutStrategy: 'full' | 'canary';
  onStrategyChange: (strategy: 'full' | 'canary') => void;
  rolloutIncludeStopped: boolean;
  onIncludeStoppedChange: (include: boolean) => void;
  coverageStats: {
    running: number;
    scheduled: number;
    stopped: number;
    inFlight: number;
  };
  deployments: AppDeployment[];
  appEntrypoint?: string;
  onConfirm: (strategy: 'full' | 'canary') => void;
  onCancel: () => void;
}

export default function RolloutModal({
  open,
  upgradingAll,
  rolloutStrategy,
  onStrategyChange,
  rolloutIncludeStopped,
  onIncludeStoppedChange,
  coverageStats,
  deployments,
  appEntrypoint,
  onConfirm,
  onCancel,
}: RolloutModalProps) {
  const { t } = useTranslation();

  const customStartCommandRows = deployments.filter(
    (d) =>
      !!d.startCommand &&
      appEntrypoint !== undefined &&
      d.startCommand !== appEntrypoint,
  );
  const rolloutWillIncludeStopped =
    rolloutStrategy === 'full' && rolloutIncludeStopped;
  const rolloutCovered =
    coverageStats.running +
    coverageStats.scheduled +
    (rolloutWillIncludeStopped ? coverageStats.stopped : 0);
  const rolloutCoverageParts = [
    t('appDeploy.rollout.coverageRunning', { count: coverageStats.running }),
    t('appDeploy.rollout.coverageScheduled', { count: coverageStats.scheduled }),
    ...(rolloutWillIncludeStopped
      ? [t('appDeploy.rollout.coverageStopped', { count: coverageStats.stopped })]
      : []),
  ];

  return (
    <Modal
      title={t('appDeploy.rollout.modalTitle')}
      open={open}
      onOk={() => onConfirm(rolloutStrategy)}
      onCancel={onCancel}
      confirmLoading={upgradingAll}
      okText={t('appDeploy.action.confirmUpgrade')}
      okButtonProps={{ icon: <UpCircleOutlined /> }}
      width={520}
    >
      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        {t('appDeploy.op.upgradeAllDesc')}
      </Text>
      <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
        {t('appDeploy.rollout.coverageLead', { count: rolloutCovered })}
        {rolloutCoverageParts.join(' + ')}
      </Text>
      {customStartCommandRows.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title={t('appDeploy.rollout.startCommandReset.title', {
            count: customStartCommandRows.length,
          })}
          description={t('appDeploy.rollout.startCommandReset.desc', {
            entrypoint: appEntrypoint ?? '—',
            detail: customStartCommandRows
              .map((r) => shortExecutorRowId(r.id) + ': ' + r.startCommand)
              .join(t('common.listSep.semicolon')),
          })}
        />
      )}
      <Radio.Group
        value={rolloutStrategy}
        onChange={(e) => onStrategyChange(e.target.value)}
        style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        <Radio value="full">
          <Text strong>{t('appDeploy.rollout.full')}</Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
            {t('appDeploy.rollout.fullDesc')}
          </Text>
        </Radio>
        <Radio value="canary">
          <Text strong>{t('appDeploy.rollout.canary')}</Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
            {t('appDeploy.rollout.canaryDesc')}
          </Text>
        </Radio>
      </Radio.Group>
      {rolloutStrategy === 'full' && (
        <Checkbox
          checked={rolloutIncludeStopped}
          onChange={(e) => onIncludeStoppedChange(e.target.checked)}
          style={{ marginTop: 12 }}
        >
          {t('appDeploy.rollout.includeStopped')}
          <Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
            {t('appDeploy.rollout.includeStoppedHint')}
          </Text>
        </Checkbox>
      )}
    </Modal>
  );
}
