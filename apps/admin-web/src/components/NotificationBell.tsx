/**
 * 顶栏通知铃：统一入口，点击直达收件箱。
 *
 * 单一失败/审批面在 /inbox；铃铛不再另起失败速览面板，也不再跳管理员专属的
 * 通知渠道配置页，避免出现「顶栏一套、收件箱一套」的重复处置面。
 */
import { Button, Tooltip } from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import '../i18n';

export default function NotificationBell() {
  const nav = useNavigate();
  const { t } = useTranslation();

  return (
    <Tooltip title={t('inbox.badge.tooltip')}>
      <Button
        type="text"
        aria-label={t('nav.notify.aria')}
        style={{ fontSize: 16 }}
        data-testid="notify-bell"
        icon={<BellOutlined style={{ fontSize: 16 }} />}
        onClick={() => nav('/inbox')}
      />
    </Tooltip>
  );
}
