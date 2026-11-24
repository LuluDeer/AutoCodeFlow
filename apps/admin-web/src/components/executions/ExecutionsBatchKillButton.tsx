/**
 * 执行记录批量终止按钮（Popconfirm 二次确认 + 进度文案）。
 *
 * 纯展示 + 回调：编排进度与结果汇总在 useBatchKill；本组件只负责
 * 确认弹窗、在途禁用 / loading、`done/total` 进度文案。文案走组件内 i18n。
 */
import { Button, Popconfirm } from 'antd';
import { StopOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

export interface BatchKillProgress {
  done: number;
  total: number;
}

export interface ExecutionsBatchKillButtonProps {
  count: number;
  busy: boolean;
  progress: BatchKillProgress | null;
  onConfirm: () => void;
}

export default function ExecutionsBatchKillButton({
  count,
  busy,
  progress,
  onConfirm,
}: ExecutionsBatchKillButtonProps) {
  const { t } = useTranslation();
  return (
    <Popconfirm
      title={t('execs.batchKill.confirm', { count })}
      onConfirm={onConfirm}
      okText={t('execs.action.kill')}
      okButtonProps={{ danger: true }}
      cancelText={t('taskList.cancel')}
    >
      <Button danger icon={<StopOutlined />} loading={busy} disabled={busy}>
        {progress
          ? t('execs.batchKilling', { done: progress.done, total: progress.total })
          : t('execs.batchKill')}
      </Button>
    </Popconfirm>
  );
}
