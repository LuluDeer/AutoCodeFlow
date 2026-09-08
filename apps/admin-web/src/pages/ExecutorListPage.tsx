import { useState, useMemo, useRef } from 'react';
import {
  Table, Typography, Badge, Tag, Button, Input, Select, Space,
  Empty, Modal, notification, Progress, Tooltip, Alert,
} from 'antd';
import {
  SearchOutlined, FilterOutlined, ClockCircleOutlined, PlusCircleOutlined,
  DesktopOutlined,
} from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { useNavigate } from 'react-router-dom';
import { executorsApi, Executor } from '../api/executors';
import { client } from '../api/client';
import { useAuthStore } from '../store/auth';
import PageHeader from '../components/PageHeader';
// UI-07：视图切换 / 分组聚合条 / 卡片视图 / 批量操作条 / 实时状态
import ViewToggle, { readViewMode, writeViewMode, type ExecutorViewMode } from '../components/executor/ViewToggle';
import GroupFilterBar from '../components/executor/GroupFilterBar';
import ExecutorCardGrid from '../components/executor/ExecutorCardGrid';
import BatchActionBar from '../components/executor/BatchActionBar';
import { useExecutorLive } from '../hooks/useExecutorLive';

function heartbeatLabel(lastHeartbeat: string): { text: string; color: string } {
  const diffMs = Date.now() - new Date(lastHeartbeat).getTime();
  const diffMin = diffMs / 60000;
  if (diffMin < 2) return { color: '#52c41a', text: '刚刚' };
  if (diffMin < 10) return { color: '#faad14', text: `${Math.floor(diffMin)} 分钟前` };
  return { color: '#ff4d4f', text: new Date(lastHeartbeat).toLocaleString('zh-CN') };
}

export default function ExecutorListPage() {
  const prevStatusMap = useRef<Record<string, string>>({});
  const isFirstLoad = useRef(true);
  const [notifApi, notifContextHolder] = notification.useNotification();

  const { data, loading } = useRequest(executorsApi.list, {
    pollingInterval: 30000,
    pollingWhenHidden: false,
    onSuccess: (executors: Executor[]) => {
      if (isFirstLoad.current) {
        executors.forEach((ex) => { prevStatusMap.current[ex.id] = ex.status; });
        isFirstLoad.current = false;
        return;
      }
      executors.forEach((ex) => {
        const prev = prevStatusMap.current[ex.id];
        if (prev !== undefined && prev !== ex.status) {
          if (ex.status === 'online') {
            notifApi.success({
              message: `执行器上线：${ex.appName}`,
              description: `${ex.address} 已恢复在线`,
              placement: 'topRight', duration: 6,
            });
          } else if (ex.status === 'offline') {
            notifApi.warning({
              message: `执行器离线：${ex.appName}`,
              description: `${ex.address} 已离线，请检查服务状态`,
              placement: 'topRight', duration: 0,
            });
          }
        }
        prevStatusMap.current[ex.id] = ex.status;
      });
    },
  });

  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  // R5 RBAC：install-cmd / executor-shared-token 为 ADMIN-only，普通用户隐藏入口
  const isAdmin = user?.role === 'admin';
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [groupFilter, setGroupFilter] = useState<string | undefined>();
  const [installCmdModal, setInstallCmdModal] = useState(false);
  // UI-07 ①：卡片/表格双视图（localStorage 记忆，读失败回退表格）
  const [viewMode, setViewMode] = useState<ExecutorViewMode>(() => readViewMode(typeof localStorage !== 'undefined' ? localStorage : undefined));
  // UI-07 ③：批量选择（两视图共享选中集合）
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);

  const { data: groups } = useRequest(executorsApi.getGroups, { cacheKey: 'executor-groups' });
  const [installCmd, setInstallCmd] = useState<{ cmd: string } | null>(null);

  const fetchInstallCmd = async () => {
    try {
      const res = await client.get<{ cmd: string }>('/executors/install-cmd');
      setInstallCmd(res);
      setInstallCmdModal(true);
    } catch {
      Modal.error({ title: '获取安装命令失败', content: '请检查 admin-api 服务是否正常运行' });
    }
  };

  // 稳定引用：data 未变时 executors 身份不变，避免下游 useMemo 每渲染失效
  const polledExecutors: Executor[] = useMemo(() => data ?? [], [data]);

  // UI-07 ④：/metrics/stream executors 段覆盖（状态/CPU/内存/任务数 3s 实时；
  // 断线时覆盖层回退轮询快照——list 接口仍是数据源，SSE 只做覆盖加速）
  const { executors, isLive } = useExecutorLive(polledExecutors);

  const hasLongOffline = useMemo(() => executors.some((e) => {
    if (e.status !== 'offline') return false;
    if (!e.lastHeartbeat) return true;
    return Date.now() - new Date(e.lastHeartbeat).getTime() > 5 * 60 * 1000;
  }), [executors]);

  const filtered = useMemo(() => executors.filter((ex) => {
    const matchSearch = !searchText ||
      ex.appName.toLowerCase().includes(searchText.toLowerCase()) ||
      ex.address.toLowerCase().includes(searchText.toLowerCase()) ||
      (ex.groupName?.toLowerCase().includes(searchText.toLowerCase()) ?? false);
    return matchSearch &&
      (!statusFilter || ex.status === statusFilter) &&
      (!groupFilter || ex.groupName === groupFilter);
  }), [executors, searchText, statusFilter, groupFilter]);

  const hasFilters = !!(searchText || statusFilter || groupFilter);
  const onlineCount = executors.filter(e => e.status === 'online').length;

  // UI-07 ③：选中执行器实体（批量操作条需要 status/appName/address）
  const selectedExecutors = useMemo(
    () => executors.filter((ex) => selectedRowKeys.includes(ex.id)),
    [executors, selectedRowKeys],
  );
  const toggleSelect = (id: string, checked: boolean) => {
    setSelectedRowKeys((prev) => (checked ? [...prev, id] : prev.filter((k) => k !== id)));
  };

  const handleViewChange = (mode: ExecutorViewMode) => {
    setViewMode(mode);
    writeViewMode(typeof localStorage !== 'undefined' ? localStorage : undefined, mode);
  };

  const columns = [
    {
      title: '执行器',
      key: 'nameAddress',
      sorter: (a: Executor, b: Executor) => a.appName.localeCompare(b.appName),
      render: (_: unknown, r: Executor) => (
        <Space orientation="vertical" size={0}>
          <Space>
            <DesktopOutlined style={{ color: r.status === 'online' ? '#52c41a' : '#d9d9d9' }} />
            <Typography.Text strong>{r.appName}</Typography.Text>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.address}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (v: string, r: Executor) => (
        <Space orientation="vertical" size={0}>
          <Badge
            status={v === 'online' ? 'success' : v === 'busy' ? 'warning' : 'default'}
            text={v === 'online' ? '在线' : v === 'busy' ? '忙碌' : '离线'}
          />
          {/* U16: 死信积压仅 >0 时高亮（null=旧版未上报、0=无积压均不打扰，
              三态细分见详情页活性上报区） */}
          {r.deadLetterCount != null && r.deadLetterCount > 0 && (
            <Tooltip title="回调持续失败已落盘执行器本地 dead-letter，需人工排查">
              <Tag color="orange" style={{ marginInlineEnd: 0 }}>死信 {r.deadLetterCount}</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: '分组 / 标签',
      key: 'groupTags',
      responsive: ['md'] as import('antd/es/_util/responsiveObserver').Breakpoint[],
      render: (_: unknown, r: Executor) => (
        <Space size={4} wrap>
          {r.groupName && <Tag color="geekblue">{r.groupName}</Tag>}
          {r.tags?.map(t => <Tag key={t}>{t}</Tag>)}
          {!r.groupName && !r.tags?.length && <Typography.Text type="secondary">-</Typography.Text>}
        </Space>
      ),
    },
    {
      title: 'CPU / 内存 / 磁盘',
      key: 'resources',
      width: 160,
      responsive: ['lg'] as import('antd/es/_util/responsiveObserver').Breakpoint[],
      render: (_: unknown, r: Executor) => (
        <Space orientation="vertical" size={2}>
          {(['CPU', '内存', '磁盘'] as const).map((label) => {
            const val = label === 'CPU' ? (r.cpuUsage ?? 0)
              : label === '内存' ? (r.memUsage ?? 0)
              : (r.diskUsage ?? 0);
            if (label === '磁盘' && !r.diskUsage) return null;
            return (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Typography.Text style={{ fontSize: 11, width: 28 }}>{label}</Typography.Text>
                <Progress
                  percent={val}
                  size="small" showInfo={false}
                  strokeColor={val > 80 ? '#ff4d4f' : val > 60 ? '#fa8c16' : '#52c41a'}
                  style={{ width: 56, margin: 0 }}
                />
                <Typography.Text style={{ fontSize: 11 }}>{val.toFixed(0)}%</Typography.Text>
              </div>
            );
          })}
        </Space>
      ),
    },
    {
      title: '任务',
      key: 'runningTaskCount',
      width: 80,
      render: (_: unknown, r: Executor) => {
        const running = r.runningTaskCount ?? 0;
        const max = r.maxConcurrentTasks;
        const label = max != null ? `${running}/${max}任务` : `${running}任务`;
        return (
          <Typography.Text strong style={{ color: running > 0 ? '#1677ff' : undefined }}>
            {label}
          </Typography.Text>
        );
      },
    },
    {
      title: '心跳',
      dataIndex: 'lastHeartbeat',
      key: 'lastHeartbeat',
      width: 120,
      render: (v: string) => {
        if (!v) return '-';
        const hb = heartbeatLabel(v);
        return (
          <Tooltip title={new Date(v).toLocaleString('zh-CN')}>
            <Space size={4}>
              <ClockCircleOutlined style={{ color: hb.color }} />
              <Typography.Text style={{ color: hb.color, fontSize: 12 }}>{hb.text}</Typography.Text>
            </Space>
          </Tooltip>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 70,
      render: (_: unknown, r: Executor) => (
        <Button type="link" size="small" onClick={() => navigate(`/executors/${r.id}`)}>详情</Button>
      ),
    },
  ];

  return (
    <div>
      {notifContextHolder}
      {hasLongOffline && (
        <Alert
          type="warning"
          showIcon
          title="有执行器离线超过5分钟，请检查"
          style={{ marginBottom: 16 }}
          closable
        />
      )}
      {/* UI-03：页头标准化（原 Typography.Title 区块迁入 PageHeader，安装向导/快速添加进 extra） */}
      <PageHeader
        title="执行器"
        description={<>{onlineCount} / {executors.length} 台在线</>}
        extra={
          <Space wrap>
            {/* UI-07 ④：SSE 连接状态点（live=实时，connecting/reconnecting=30s 轮询兜底） */}
            <Tooltip
              title={isLive
                ? '实时状态已连接（/metrics/stream · 3s 推送）'
                : '实时流未连接，正在按 30s 轮询刷新'}
            >
              <Badge
                status={isLive ? 'processing' : 'warning'}
                text={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{isLive ? '实时' : '轮询'}</Typography.Text>}
              />
            </Tooltip>
            <ViewToggle value={viewMode} onChange={handleViewChange} />
            {isAdmin && <Button onClick={() => navigate('/executors/install')}>安装向导</Button>}
            {isAdmin && (
              <Button icon={<PlusCircleOutlined />} type="primary" onClick={fetchInstallCmd}>
                快速添加
              </Button>
            )}
          </Space>
        }
      />

      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          placeholder="搜索名称、地址、分组"
          prefix={<SearchOutlined />}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear style={{ width: 220 }}
        />
        <Select
          placeholder="全部状态"
          allowClear style={{ width: 120 }}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v)}
          suffixIcon={<FilterOutlined />}
          options={[
            { value: 'online', label: '在线' },
            { value: 'offline', label: '离线' },
            { value: 'busy', label: '忙碌' },
          ]}
        />
        {(groups ?? []).length > 0 && (
          <Select
            placeholder="全部分组"
            allowClear style={{ width: 130 }}
            value={groupFilter}
            onChange={(v) => setGroupFilter(v)}
            suffixIcon={<FilterOutlined />}
            options={(groups ?? []).map(g => ({ value: g, label: g }))}
          />
        )}
        {hasFilters && (
          <Button size="small" onClick={() => { setSearchText(''); setStatusFilter(undefined); setGroupFilter(undefined); }}>清除筛选</Button>
        )}
        {hasFilters && (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {filtered.length} / {executors.length} 条
          </Typography.Text>
        )}
      </Space>

      {/* UI-07 ②：分组聚合条（点击等价 groupFilter；全部执行器均无分组时整条隐藏） */}
      <GroupFilterBar executors={executors} value={groupFilter} onChange={setGroupFilter} />

      {/* UI-07 ③：批量操作条（ADMIN-only；两视图共享选中集合） */}
      <BatchActionBar
        selected={selectedExecutors}
        isAdmin={isAdmin}
        onDone={() => setSelectedRowKeys([])}
      />

      {viewMode === 'card' ? (
        <ExecutorCardGrid
          executors={filtered}
          selectedIds={selectedRowKeys}
          onToggleSelect={toggleSelect}
          onOpenDetail={(id) => navigate(`/executors/${id}`)}
          isAdmin={isAdmin}
          onReloadConfig={(ex) => setSelectedRowKeys([ex.id])}
          onRotateToken={(ex) => setSelectedRowKeys([ex.id])}
        />
      ) : (
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          loading={loading}
          // UI-07 ③：表格多选（ADMIN 门控在操作条——非 admin 无操作条，
          // 选中集合为空集，多选列对普通用户仅是筛选辅助，不暴露写入口）
          rowSelection={{ selectedRowKeys, onChange: (keys) => setSelectedRowKeys(keys as string[]) }}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
          locale={{
            emptyText: hasFilters ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无匹配执行器">
                <Button type="link" size="small" onClick={() => { setSearchText(''); setStatusFilter(undefined); }}>
                  清除筛选
                </Button>
              </Empty>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无执行器">
                {isAdmin && (
                  <Button type="primary" onClick={() => navigate('/executors/install')}>安装第一个执行器</Button>
                )}
              </Empty>
            ),
          }}
        />
      )}

      <Modal
        title="快速添加执行器"
        open={installCmdModal}
        onCancel={() => setInstallCmdModal(false)}
        footer={<Button onClick={() => setInstallCmdModal(false)}>关闭</Button>}
        width={640}
      >
        {installCmd && (
          <Space orientation="vertical" style={{ width: '100%' }} size={16}>
            <div>
              <Typography.Text strong>安装并启动执行器</Typography.Text>
              <Typography.Paragraph
                code copyable={{ text: installCmd.cmd }}
                style={{ marginTop: 8, padding: '8px 12px', background: '#f5f5f5', borderRadius: 6 }}
              >
                {installCmd.cmd}
              </Typography.Paragraph>
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              在目标机器上运行以上命令，执行器将自动注册并出现在列表中。
            </Typography.Text>
          </Space>
        )}
      </Modal>
    </div>
  );
}
