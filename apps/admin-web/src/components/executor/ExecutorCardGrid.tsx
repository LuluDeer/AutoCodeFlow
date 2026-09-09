/**
 * UI-07 ①：执行器卡片视图（网格 Card）。
 *
 * 与表格视图同数据源（filtered），展示字段对齐表格列语义：
 * 名称/地址/状态 Badge/死信 Tag（U16：仅 >0 高亮）/CPU+内存双 Progress/
 * 任务数（maxConcurrentTasks 双形态）/分组+标签 Tag/心跳相对时间/快捷操作。
 * 磁盘仅在有上报时展示（表格列同语义）。
 *
 * isAdmin 传入时追加 ADMIN 快捷操作（配置热更新/轮换 Token——与详情页
 * 既有入口同端点；轮换走批量操作条同一 confirm 流程由父级处理，这里仅
 * 回调）。选中复选框服务于批量操作条（表格 rowSelection 同语义）。
 */
import { Card, Checkbox, Tag, Typography, Badge, Progress, Tooltip, Space, Button, Empty } from 'antd';
import {
  DesktopOutlined, ClockCircleOutlined, SettingOutlined, KeyOutlined,
} from '@ant-design/icons';
import type { Executor } from '../../api/executors';

const { Text } = Typography;

function heartbeatLabel(lastHeartbeat: string): { text: string; color: string } {
  const diffMs = Date.now() - new Date(lastHeartbeat).getTime();
  const diffMin = diffMs / 60000;
  if (diffMin < 2) return { color: '#52c41a', text: '刚刚' };
  if (diffMin < 10) return { color: '#faad14', text: `${Math.floor(diffMin)} 分钟前` };
  return { color: '#ff4d4f', text: new Date(lastHeartbeat).toLocaleString('zh-CN') };
}

function statusBadge(status: string): 'success' | 'warning' | 'default' {
  return status === 'online' ? 'success' : status === 'busy' ? 'warning' : 'default';
}

function statusText(status: string): string {
  return status === 'online' ? '在线' : status === 'busy' ? '忙碌' : '离线';
}

function usageStroke(v: number): string {
  return v > 80 ? '#ff4d4f' : v > 60 ? '#fa8c16' : '#52c41a';
}

interface ResourceRowProps {
  label: string;
  value?: number;
}

function ResourceRow({ label, value }: ResourceRowProps) {
  const val = value ?? 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Text style={{ fontSize: 12, width: 32 }}>{label}</Text>
      <Progress
        percent={val}
        size="small"
        showInfo={false}
        strokeColor={usageStroke(val)}
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
}

export function ExecutorCard({
  executor: r, selected, onToggleSelect, onOpenDetail, isAdmin, onReloadConfig, onRotateToken,
}: ExecutorCardProps) {
  const running = r.runningTaskCount ?? 0;
  const max = r.maxConcurrentTasks;
  const taskLabel = max != null ? `${running}/${max}` : `${running}`;
  const hb = r.lastHeartbeat ? heartbeatLabel(r.lastHeartbeat) : null;
  const online = r.status === 'online';

  return (
    <Card
      data-testid={`executor-card-${r.id}`}
      size="small"
      style={{ borderColor: selected ? '#1677ff' : undefined }}
      title={
        <Space size={8}>
          <Checkbox
            checked={selected}
            onChange={(e) => onToggleSelect(r.id, e.target.checked)}
            aria-label={`选择 ${r.appName}`}
          />
          <DesktopOutlined style={{ color: online ? '#52c41a' : '#d9d9d9' }} />
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
        <Space size={4} wrap>
          <Badge status={statusBadge(r.status)} text={statusText(r.status)} />
          {r.deadLetterCount != null && r.deadLetterCount > 0 && (
            <Tooltip title="回调持续失败已落盘执行器本地 dead-letter，需人工排查">
              <Tag color="orange" style={{ marginInlineEnd: 0 }}>死信 {r.deadLetterCount}</Tag>
            </Tooltip>
          )}
        </Space>
      }
    >
      <Text type="secondary" style={{ fontSize: 12 }}>{r.address}</Text>

      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <ResourceRow label="CPU" value={r.cpuUsage} />
        <ResourceRow label="内存" value={r.memUsage} />
        {r.diskUsage != null && r.diskUsage > 0 && <ResourceRow label="磁盘" value={r.diskUsage} />}
      </div>

      <Space size={4} wrap style={{ marginTop: 8 }}>
        <Text strong style={{ color: running > 0 ? '#1677ff' : undefined }}>
          {taskLabel} 任务
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
          <Tooltip title={new Date(r.lastHeartbeat).toLocaleString('zh-CN')}>
            <Space size={4}>
              <ClockCircleOutlined style={{ color: hb.color }} />
              <Text style={{ color: hb.color, fontSize: 12 }}>{hb.text}</Text>
            </Space>
          </Tooltip>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>无心跳</Text>
        )}
        <Space size={0}>
          <Button type="link" size="small" onClick={() => onOpenDetail(r.id)}>详情</Button>
          {isAdmin && (
            <>
              <Tooltip title={online ? '配置热更新' : '执行器离线，无法推送配置'}>
                <Button
                  type="link" size="small" icon={<SettingOutlined />}
                  disabled={!online}
                  aria-label={`配置热更新 ${r.appName}`}
                  onClick={() => onReloadConfig?.(r)}
                />
              </Tooltip>
              <Tooltip title="轮换 Token（执行器将短暂重新注册）">
                <Button
                  type="link" size="small" danger icon={<KeyOutlined />}
                  aria-label={`轮换 Token ${r.appName}`}
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
}

/** 网格容器：响应式三列（minmax 280px 自适应） */
export function ExecutorCardGrid({
  executors, selectedIds, onToggleSelect, onOpenDetail, isAdmin, onReloadConfig, onRotateToken,
}: ExecutorCardGridProps) {
  if (executors.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无匹配执行器" />;
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
        />
      ))}
    </div>
  );
}

export default ExecutorCardGrid;
