/**
 * UI-07 ①：执行器卡片视图（网格 Card）。
 *
 * 与表格视图同数据源（filtered），展示字段对齐表格列语义：
 * 名称/地址/状态 Badge/死信 Tag（U16：仅 >0 高亮）/CPU+内存双 Progress/
 * 任务数（maxConcurrentTasks 双形态）/分组+标签 Tag/心跳相对时间/快捷操作。
 * B-7 徽标对齐表格视图：pull 模式、版本漂移同款 Tag；磁盘未上报（null）
 * 显式标注「未上报」占位（0 是真实上报值，正常渲染进度行）。
 * B-7 空态：与表格空态同款动作（清除筛选/ADMIN 安装入口，经 emptyExtra 注入）。
 *
 * isAdmin 传入时追加 ADMIN 快捷操作（配置热更新/轮换 Token——与详情页
 * 既有入口同端点；B-13 起直达与批量操作条同一 confirm 流程，这里仅回调）。
 * 配置热更新按钮的禁用判据与详情页/批量条同源（isControlPlaneUnavailable）。
 * 选中复选框服务于批量操作条（表格 rowSelection 同语义）。
 */
import { Card, Checkbox, Tag, Typography, Badge, Progress, Tooltip, Space, Button, Empty, theme } from 'antd';
import {
  DesktopOutlined, ClockCircleOutlined, SettingOutlined, KeyOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { Executor } from '../../api/executors';
// F-26（DEEP_REVIEW 0ef3bbe）：locale 单一来源，不再硬编码 zh-CN
import { currentLocale } from '../../utils/locale';
// P2-5（executor lifecycle audit）：心跳着色阈值与后端判死阈值同源
import { heartbeatFreshness } from '../../utils/executorLiveness';
// ARCH-33（ADR-016）：pull 控制面可用性判据（与详情页/批量条同源）
import { isControlPlaneUnavailable } from '../../utils/control-plane';
import '../../i18n';

type TFunc = (k: string, opts?: Record<string, unknown>) => string;

const { Text } = Typography;

// F-15（DEEP_REVIEW 0ef3bbe）：语义色/用量色走 antd token（双主题自适应）。
type AntdToken = ReturnType<typeof theme.useToken>['token'];
function heartbeatLabel(
  t: TFunc,
  lastHeartbeat: string,
  token: AntdToken,
  staleTimeoutMs: number,
): { text: string; color: string } {
  const diffMs = Date.now() - new Date(lastHeartbeat).getTime();
  const freshness = heartbeatFreshness(diffMs, staleTimeoutMs);
  if (freshness === 'fresh') return { color: token.colorSuccess, text: t('execCard.hb.justNow') };
  if (freshness === 'recent') {
    return { color: token.colorWarning, text: t('execCard.hb.minAgo', { min: Math.floor(diffMs / 60000) }) };
  }
  return { color: token.colorError, text: new Date(lastHeartbeat).toLocaleString(currentLocale()) };
}

// B-8：删除 status==='busy' 死分支——执行器状态只有 online/offline 两态
// （executor.entity.ts:15-16），全仓无第三态取值（与表格视图同口径）。
function statusBadge(status: string): 'success' | 'default' {
  return status === 'online' ? 'success' : 'default';
}

function statusText(t: TFunc, status: string): string {
  return status === 'online' ? t('execCard.status.online') : t('execCard.status.offline');
}

function usageStroke(v: number, token: AntdToken): string {
  return v > 80 ? token.colorError : v > 60 ? token.colorWarning : token.colorSuccess;
}

interface ResourceRowProps {
  label: string;
  value?: number;
}

function ResourceRow({ label, value }: ResourceRowProps) {
  const { token } = theme.useToken();
  const val = value ?? 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Text style={{ fontSize: 12, width: 32 }}>{label}</Text>
      <Progress
        percent={val}
        size="small"
        showInfo={false}
        strokeColor={usageStroke(val, token)}
        style={{ flex: 1, margin: 0 }}
      />
      <Text style={{ fontSize: 12, width: 36, textAlign: 'right' }}>{val.toFixed(0)}%</Text>
    </div>
  );
}

export interface ExecutorCardProps {
  executor: Executor;
  selected: boolean;
  onToggleSelect: (id: string, checked: boolean) => void;
  onOpenDetail: (id: string) => void;
  /** ADMIN 传入时渲染快捷操作（配置热更新/轮换 Token） */
  isAdmin?: boolean;
  onReloadConfig?: (executor: Executor) => void;
  onRotateToken?: (executor: Executor) => void;
  /** P2-5：心跳「新鲜」边界 = 后端有效判死阈值（runtime-config，默认 90s）。 */
  staleTimeoutMs: number;
}export function ExecutorCard({
  executor: r, selected, onToggleSelect, onOpenDetail, isAdmin, onReloadConfig, onRotateToken, staleTimeoutMs,
}: ExecutorCardProps) {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：语义色/边框走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
  const running = r.runningTaskCount ?? 0;
  const max = r.maxConcurrentTasks;
  const taskLabel = max != null ? `${running}/${max}` : `${running}`;
  const hb = r.lastHeartbeat ? heartbeatLabel(t, r.lastHeartbeat, token, staleTimeoutMs) : null;
  const online = r.status === 'online';

  return (
    <Card
      data-testid={`executor-card-${r.id}`}
      size="small"
      style={{ borderColor: selected ? token.colorPrimary : undefined }}
      title={
        <Space size={8}>
          <Checkbox
            checked={selected}
            onChange={(e) => onToggleSelect(r.id, e.target.checked)}
            aria-label={t('execCard.selectAria', { name: r.appName })}
          />
          <DesktopOutlined style={{ color: online ? token.colorSuccess : token.colorBorder }} />
          <span
            role="link"
            tabIndex={0}
            style={{ cursor: 'pointer' }}
            onClick={() => onOpenDetail(r.id)}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpenDetail(r.id); }}
          >
            {r.appName}
          </span>
        </Space>
      }
      extra={
        // 375px 走查：超长名称省略号紧贴「在线」徽标——卡头 title(flex:1) 与
        // extra 之间无默认间距，补一档呼吸空隙（桌面卡片视图同款，仅间距）。
        <Space size={4} wrap style={{ marginLeft: 12 }}>
          <Badge status={statusBadge(r.status)} text={statusText(t, r.status)} />
          {r.deadLetterCount != null && r.deadLetterCount > 0 && (
            <Tooltip title={t('execCard.deadLetterTip')}>
              <Tag color="orange" style={{ marginInlineEnd: 0 }}>{t('execCard.deadLetter', { count: r.deadLetterCount })}</Tag>
            </Tooltip>
          )}
          {/* B-7：与表格视图（ExecutorListPage 状态列）对齐的徽标——pull 模式
              与版本漂移（EXE-VER-1），复用表格视图既有 i18n 键 */}
          {r.dispatchMode === 'pull' && (
            <Tooltip title={t('execList.pullModeTooltip')}>
              <Tag color="purple" style={{ marginInlineEnd: 0 }}>{t('execList.pullMode')}</Tag>
            </Tooltip>
          )}
          {r.versionCompliant === false && (
            <Tooltip title={t('execList.versionDriftTooltip')}>
              <Tag color="volcano" style={{ marginInlineEnd: 0 }}>{t('execList.versionDrift')}</Tag>
            </Tooltip>
          )}
        </Space>
      }
    >
      <Text type="secondary" style={{ fontSize: 12 }}>{r.address}</Text>

      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <ResourceRow label={t('execCard.res.cpu')} value={r.cpuUsage} />
        <ResourceRow label={t('execCard.res.mem')} value={r.memUsage} />
        {/* B-7：磁盘未上报（null）显式占位而非整行消失（表格视图 DISK-PLACEHOLDER-01
            同款纪律）；0 是真实上报值（磁盘为空），照常渲染进度行 */}
        {r.diskUsage == null ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Text style={{ fontSize: 12, width: 32 }}>{t('execCard.res.disk')}</Text>
            <Tooltip title={t('execList.res.diskUnreported')}>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('execList.res.diskUnreported')}</Text>
            </Tooltip>
          </div>
        ) : (
          <ResourceRow label={t('execCard.res.disk')} value={r.diskUsage} />
        )}
      </div>

      <Space size={4} wrap style={{ marginTop: 8 }}>
        <Text strong style={{ color: running > 0 ? token.colorPrimary : undefined }}>
          {t('execCard.tasks', { label: taskLabel })}
        </Text>
        {r.groupName && <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>{r.groupName}</Tag>}
        {r.tags?.map((t) => <Tag key={t} style={{ marginInlineEnd: 0 }}>{t}</Tag>)}
      </Space>

      <div
        style={{
          marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}
      >
        {hb ? (
          <Tooltip title={new Date(r.lastHeartbeat).toLocaleString(currentLocale())}>
            <Space size={4}>
              <ClockCircleOutlined style={{ color: hb.color }} />
              <Text style={{ color: hb.color, fontSize: 12 }}>{hb.text}</Text>
            </Space>
          </Tooltip>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>{t('execCard.noHeartbeat')}</Text>
        )}
        <Space size={0}>
          <Button type="link" size="small" onClick={() => onOpenDetail(r.id)}>{t('execCard.detail')}</Button>
          {isAdmin && (
            <>
              {/* B-13：禁用判据与详情页/批量条同源（ARCH-33：pull 且协议 <2
                  会静默忽略 commands 字段，比失败更危险）——离线或控制面不可达
                  均禁用，Tooltip 分别说明 */}
              <Tooltip title={
                !online
                  ? t('execCard.reloadOfflineTip')
                  : isControlPlaneUnavailable(r)
                    ? t('executorDetail.config.pullDisabledTooltip')
                    : t('execCard.reloadTip')
              }>
                <Button
                  type="link" size="small" icon={<SettingOutlined />}
                  disabled={!online || isControlPlaneUnavailable(r)}
                  aria-label={t('execCard.reloadAria', { name: r.appName })}
                  onClick={() => onReloadConfig?.(r)}
                />
              </Tooltip>
              <Tooltip title={t('execCard.rotateTip')}>
                <Button
                  type="link" size="small" danger icon={<KeyOutlined />}
                  aria-label={t('execCard.rotateAria', { name: r.appName })}
                  onClick={() => onRotateToken?.(r)}
                />
              </Tooltip>
            </>
          )}
        </Space>
      </div>
    </Card>
  );
}

interface ExecutorCardGridProps {
  executors: Executor[];
  selectedIds: string[];
  onToggleSelect: (id: string, checked: boolean) => void;
  onOpenDetail: (id: string) => void;
  isAdmin?: boolean;
  onReloadConfig?: (executor: Executor) => void;
  onRotateToken?: (executor: Executor) => void;
  /** P2-5：透传给卡片的心跳判死阈值（与后端 runtime-config 同源）。 */
  staleTimeoutMs: number;
  /** B-7：空态动作（清除筛选/ADMIN 安装入口）——由父级注入，与表格空态同款 */
  emptyExtra?: ReactNode;
}

/** 网格容器：响应式三列（minmax 280px 自适应） */
export function ExecutorCardGrid({
  executors, selectedIds, onToggleSelect, onOpenDetail, isAdmin, onReloadConfig, onRotateToken, staleTimeoutMs, emptyExtra,
}: ExecutorCardGridProps) {
  const { t } = useTranslation();
  if (executors.length === 0) {
    // B-7：空态补动作入口（表格视图空态同款语义：筛选无匹配 → 清除筛选；
    // 机群确空 → ADMIN 安装第一个执行器）
    return (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('execCard.empty')}>
        {emptyExtra}
      </Empty>
    );
  }
  return (
    <div
      data-testid="executor-card-grid"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: 12,
      }}
    >
      {executors.map((r) => (
        <ExecutorCard
          key={r.id}
          executor={r}
          selected={selectedIds.includes(r.id)}
          onToggleSelect={onToggleSelect}
          onOpenDetail={onOpenDetail}
          isAdmin={isAdmin}
          onReloadConfig={onReloadConfig}
          onRotateToken={onRotateToken}
          staleTimeoutMs={staleTimeoutMs}
        />
      ))}
    </div>
  );
}

export default ExecutorCardGrid;
