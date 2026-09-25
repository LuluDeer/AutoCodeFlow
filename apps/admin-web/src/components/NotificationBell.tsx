/**
 * BELL-01：顶栏通知铃——从「零反馈的纯跳转」升级为**近期失败速览面板**。
 *
 * 背景（P1-20 UX 审计续）：铃铛此前点击直达 /notifications（渠道配置页），
 * 既无未读信号也无内容预览——值班场景下「刚才有没有任务挂了」这一最高频
 * 问题无法从顶栏回答。
 *
 * 设计：
 * - 数据源复用 /metrics/failures（Dashboard 最近失败同一接口，30s staleTime
 *   + SSE 兜底，不加新端点）；
 * - 未读红点 = createdAt 晚于 localStorage 记录的「上次查看」时刻的失败数
 *   （无后端已读模型，本地记忆即可满足"有没有新失败"的诉求）；
 * - 打开面板即记为已读；面板底部提供「全部失败」深链（/executions?status=failed，
 *   URL-SYNC-01 已让该深链生效）与「通知设置」入口。
 */
import { useMemo } from 'react';
import { Badge, Button, Popover, Typography, Empty } from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useRecentFailures } from '../api/queries';
import { formatRelativeTime } from '../utils/timeFormat';
import '../i18n';

const { Text } = Typography;

const LAST_SEEN_KEY = 'autoflow-notify-lastseen';

function readLastSeen(): number {
  try {
    const raw = window.localStorage.getItem(LAST_SEEN_KEY);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export default function NotificationBell() {
  const nav = useNavigate();
  const { t } = useTranslation();
  const { data: failures } = useRecentFailures();

  const lastSeen = readLastSeen();
  // useMemo 稳定引用：unreadCount 的依赖数组需要引用级稳定（否则每次渲染重算）
  const list = useMemo(() => failures ?? [], [failures]);

  /** 未读数：查看时刻之后新产生的失败（后端按时间倒序返回） */
  const unreadCount = useMemo(
    () => list.filter((f) => {
      const ts = new Date(f.createdAt).getTime();
      return Number.isFinite(ts) && ts > lastSeen;
    }).length,
    [list, lastSeen],
  );

  const markSeen = () => {
    const maxTs = list.reduce((acc, f) => {
      const ts = new Date(f.createdAt).getTime();
      return Number.isFinite(ts) && ts > acc ? ts : acc;
    }, readLastSeen());
    try {
      window.localStorage.setItem(LAST_SEEN_KEY, String(maxTs));
    } catch {
      /* 隐私模式等 localStorage 不可用时静默降级（红点常驻无害） */
    }
  };

  const content = (
    <div style={{ width: 320, maxWidth: '80vw' }} data-testid="notify-panel">
      {list.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('nav.notify.empty')} style={{ margin: '8px 0' }} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
          {list.map((f) => (
            <div key={f.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <Link to={`/tasks/${f.taskId}/executions/${f.id}`} style={{ fontSize: 13, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.taskName || f.taskId}
                </Link>
                <Text type="secondary" style={{ fontSize: 11, flex: 'none' }}>
                  {formatRelativeTime(f.createdAt, t)}
                </Text>
              </div>
              <Text type="danger" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.errorMessage || t('dashboard.unknownError')}
              </Text>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between' }}>
        <Button type="link" size="small" onClick={() => nav('/executions?status=failed')}>
          {t('nav.notify.viewAll')}
        </Button>
        <Button type="link" size="small" onClick={() => nav('/notifications')}>
          {t('nav.notify.settings')}
        </Button>
      </div>
    </div>
  );

  return (
    <Popover
      content={content}
      title={t('nav.notify.panelTitle')}
      trigger={['click']}
      placement="bottomRight"
      onOpenChange={(open) => {
        // 打开面板 = 已读时刻（用箭头函数体避免把 Promise 当 handler 返回）
        if (open) markSeen();
      }}
    >
      <Button
        type="text"
        aria-label={t('nav.notify.aria')}
        style={{ fontSize: 16 }}
        data-testid="notify-bell"
        icon={
          <Badge count={unreadCount} size="small" offset={[2, -2]}>
            <BellOutlined style={{ fontSize: 16, color: 'inherit' }} />
          </Badge>
        }
      />
    </Popover>
  );
}
