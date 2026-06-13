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
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [installCmdModal, setInstallCmdModal] = useState(false);
  const [installCmd, setInstallCmd] = useState<{ cmd: string; curlCmd: string } | null>(null);

  const fetchInstallCmd = async () => {
    try {
      const res = await client.get<{ cmd: string; curlCmd: string }>('/executors/install-cmd');
      setInstallCmd(res);
      setInstallCmdModal(true);
    } catch (_err) {
      Modal.error({ title: '获取安装命令失败', content: '请检查 admin-api 服务是否正常运行' });
    }
  };

  const executors: Executor[] = data ?? [];

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
    return matchSearch && (!statusFilter || ex.status === statusFilter);
  }), [executors, searchText, statusFilter]);

  const hasFilters = !!(searchText || statusFilter);
  const onlineCount = executors.filter(e => e.status === 'online').length;

  const columns = [
    {
      title: '执行器',
      key: 'nameAddress',
      sorter: (a: Executor, b: Executor) => a.appName.localeCompare(b.appName),
      render: (_: unknown, r: Executor) => (
        <Space direction="vertical" size={0}>
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
      render: (v: string) => (
        <Badge
          status={v === 'online' ? 'success' : v === 'busy' ? 'warning' : 'default'}
          text={v === 'online' ? '在线' : v === 'busy' ? '忙碌' : '离线'}
        />
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
      title: 'CPU / 内存',
      key: 'resources',
      width: 140,
      responsive: ['lg'] as import('antd/es/_util/responsiveObserver').Breakpoint[],
      render: (_: unknown, r: Executor) => (
        <Space direction="vertical" size={2}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Typography.Text style={{ fontSize: 11, width: 28 }}>CPU</Typography.Text>
            <Progress
              percent={r.cpuUsage ?? 0}
              size="small" showInfo={false}
              strokeColor={(r.cpuUsage ?? 0) > 80 ? '#ff4d4f' : (r.cpuUsage ?? 0) > 60 ? '#fa8c16' : '#52c41a'}
              style={{ width: 56, margin: 0 }}
            />
            <Typography.Text style={{ fontSize: 11 }}>{(r.cpuUsage ?? 0).toFixed(0)}%</Typography.Text>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Typography.Text style={{ fontSize: 11, width: 28 }}>内存</Typography.Text>
            <Progress
              percent={r.memUsage ?? 0}
              size="small" showInfo={false}
              strokeColor={(r.memUsage ?? 0) > 80 ? '#ff4d4f' : (r.memUsage ?? 0) > 60 ? '#fa8c16' : '#52c41a'}
              style={{ width: 56, margin: 0 }}
            />
            <Typography.Text style={{ fontSize: 11 }}>{(r.memUsage ?? 0).toFixed(0)}%</Typography.Text>
          </div>
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
          message="有执行器离线超过5分钟，请检查"
          style={{ marginBottom: 16 }}
          closable
        />
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>执行器</Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {onlineCount} / {executors.length} 台在线
          </Typography.Text>
        </div>
        <Space>
          <Button onClick={() => navigate('/executors/install')}>安装向导</Button>
          <Button icon={<PlusCircleOutlined />} type="primary" onClick={fetchInstallCmd}>
            快速添加
          </Button>
        </Space>
      </div>

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
        {hasFilters && (
          <Button size="small" onClick={() => { setSearchText(''); setStatusFilter(undefined); }}>清除筛选</Button>
        )}
        {hasFilters && (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {filtered.length} / {executors.length} 条
          </Typography.Text>
        )}
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={filtered}
        loading={loading}
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
              <Button type="primary" onClick={() => navigate('/executors/install')}>安装第一个执行器</Button>
            </Empty>
          ),
        }}
      />

      <Modal
        title="快速添加执行器"
        open={installCmdModal}
        onCancel={() => setInstallCmdModal(false)}
        footer={<Button onClick={() => setInstallCmdModal(false)}>关闭</Button>}
        width={640}
      >
        {installCmd && (
          <Space direction="vertical" style={{ width: '100%' }} size={16}>
            <div>
              <Typography.Text strong>本地安装（已有源码）</Typography.Text>
              <Typography.Paragraph
                code copyable={{ text: installCmd.cmd }}
                style={{ marginTop: 8, padding: '8px 12px', background: '#f5f5f5', borderRadius: 6 }}
              >
                {installCmd.cmd}
              </Typography.Paragraph>
            </div>
            <div>
              <Typography.Text strong>远程一键安装（curl）</Typography.Text>
              <Typography.Paragraph
                code copyable={{ text: installCmd.curlCmd }}
                style={{ marginTop: 8, padding: '8px 12px', background: '#f5f5f5', borderRadius: 6, wordBreak: 'break-all' }}
              >
                {installCmd.curlCmd}
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
