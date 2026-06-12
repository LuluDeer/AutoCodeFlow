import { useState, useMemo, useRef } from 'react';
import { Table, Typography, Badge, Tag, Button, Input, Select, Space, Empty, Modal, notification } from 'antd';
import { SearchOutlined, FilterOutlined, ClockCircleOutlined, PlusCircleOutlined, CopyOutlined } from '@ant-design/icons';
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
    pollingInterval: 15000,
    onSuccess: (executors: Executor[]) => {
      if (isFirstLoad.current) {
        // 首次加载，只记录状态，不触发通知
        executors.forEach((ex) => { prevStatusMap.current[ex.id] = ex.status; });
        isFirstLoad.current = false;
        return;
      }
      // 后续轮询检测状态变化
      executors.forEach((ex) => {
        const prev = prevStatusMap.current[ex.id];
        if (prev !== undefined && prev !== ex.status) {
          if (ex.status === 'online') {
            notifApi.success({
              message: '执行器已上线',
              description: `${ex.appName}（${ex.address}）已恢复在线`,
              placement: 'topRight',
              duration: 6,
            });
          } else if (ex.status === 'offline') {
            notifApi.warning({
              message: '执行器已离线',
              description: `${ex.appName}（${ex.address}）已离线，请检查服务状态`,
              placement: 'topRight',
              duration: 0,
            });
          } else {
            notifApi.error({
              message: '执行器状态异常',
              description: `${ex.appName}（${ex.address}）状态变为 ${ex.status}`,
              placement: 'topRight',
              duration: 0,
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
      const res = await client.get<any, { cmd: string; curlCmd: string }>('/executors/install-cmd');
      setInstallCmd(res);
      setInstallCmdModal(true);
    } catch {
      Modal.error({ title: '获取安装命令失败', content: '请检查 admin-api 服务是否正常运行' });
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      // Silent success — UI feedback via button state is enough
    });
  };

  const executors: Executor[] = data ?? [];

  const filtered = useMemo(() => {
    return executors.filter((ex) => {
      const matchSearch =
        !searchText ||
        ex.appName.toLowerCase().includes(searchText.toLowerCase()) ||
        ex.address.toLowerCase().includes(searchText.toLowerCase()) ||
        (ex.groupName?.toLowerCase().includes(searchText.toLowerCase()) ?? false) ||
        (ex.description?.toLowerCase().includes(searchText.toLowerCase()) ?? false);
      const matchStatus = !statusFilter || ex.status === statusFilter;
      return matchSearch && matchStatus;
    });
  }, [executors, searchText, statusFilter]);

  const hasFilters = !!(searchText || statusFilter);

  const columns = [
    { title: 'AppName', dataIndex: 'appName', key: 'appName', sorter: (a: Executor, b: Executor) => a.appName.localeCompare(b.appName) },
    { title: '地址', dataIndex: 'address', key: 'address' },
    { title: '分组', dataIndex: 'groupName', key: 'groupName', render: (v: string) => v || '-' },
    {
      title: '标签',
      dataIndex: 'tags',
      key: 'tags',
      render: (v: string[]) => v?.length ? v.map(t => <Tag key={t}>{t}</Tag>) : '-',
    },
    { title: '类型', dataIndex: 'type', key: 'type', render: (v: string) => v || '-' },
    { title: '版本', dataIndex: 'version', key: 'version', render: (v: string) => v || '-' },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => <Badge status={v === 'online' ? 'success' : 'default'} text={v} />,
    },
    { title: 'CPU%', dataIndex: 'cpuUsage', key: 'cpuUsage', render: (v: number) => `${v?.toFixed(1) ?? '-'}%` },
    { title: 'MEM%', dataIndex: 'memUsage', key: 'memUsage', render: (v: number) => `${v?.toFixed(1) ?? '-'}%` },
    { title: '运行任务数', dataIndex: 'runningTaskCount', key: 'runningTaskCount' },
    {
      title: '最后心跳',
      dataIndex: 'lastHeartbeat',
      key: 'lastHeartbeat',
      sorter: (a: Executor, b: Executor) =>
        new Date(a.lastHeartbeat).getTime() - new Date(b.lastHeartbeat).getTime(),
      render: (v: string) => {
        if (!v) return '-';
        const hb = heartbeatLabel(v);
        return (
          <Space size={4}>
            <ClockCircleOutlined style={{ color: hb.color }} />
            <Typography.Text style={{ color: hb.color, fontSize: 13 }}>{hb.text}</Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_: any, record: Executor) => (
        <Button type="link" onClick={() => navigate(`/executors/${record.id}`)}>详情</Button>
      ),
    },
  ];

  return (
    <div>
      {notifContextHolder}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>执行器列表</Typography.Title>
        <Space>
          <Button onClick={() => navigate('/executors/install')}>安装向导</Button>
          <Button icon={<PlusCircleOutlined />} type="primary" onClick={fetchInstallCmd}>
            添加执行器
          </Button>
        </Space>
      </div>

      {/* 搜索/筛选栏 */}
      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          placeholder="搜索名称、地址、分组"
          prefix={<SearchOutlined />}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear
          style={{ width: 220 }}
        />
        <Select
          placeholder="全部状态"
          allowClear
          style={{ width: 120 }}
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
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                hasFilters ? (
                  <Space direction="vertical" size={4}>
                    <span>未找到匹配的执行器</span>
                    <Button type="link" size="small" onClick={() => { setSearchText(''); setStatusFilter(undefined); }}>
                      清除筛选条件
                    </Button>
                  </Space>
                ) : (
                  <Space direction="vertical" size={12} style={{ padding: '24px 0' }}>
                    <span>暂无执行器</span>
                    <Button type="primary" onClick={() => navigate('/executors/install')}>
                      安装第一个执行器
                    </Button>
                  </Space>
                )
              }
            />
          ),
        }}
      />

      {/* 安装命令弹窗 */}
      <Modal
        title="执行器安装命令"
        open={installCmdModal}
        onCancel={() => setInstallCmdModal(false)}
        footer={<Button onClick={() => setInstallCmdModal(false)}>关闭</Button>}
        width={680}
      >
        {installCmd && (
          <Space direction="vertical" style={{ width: '100%' }} size={16}>
            <div>
              <Typography.Text strong>本地安装（已有源码）</Typography.Text>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <Typography.Paragraph
                  code
                  copyable={{ text: installCmd.cmd, icon: <CopyOutlined /> }}
                  style={{ flex: 1, margin: 0, padding: '8px 12px', background: '#f5f5f5', borderRadius: 6 }}
                >
                  {installCmd.cmd}
                </Typography.Paragraph>
              </div>
            </div>
            <div>
              <Typography.Text strong>远程一键安装（curl）</Typography.Text>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <Typography.Paragraph
                  code
                  copyable={{ text: installCmd.curlCmd, icon: <CopyOutlined /> }}
                  style={{ flex: 1, margin: 0, padding: '8px 12px', background: '#f5f5f5', borderRadius: 6, wordBreak: 'break-all' }}
                >
                  {installCmd.curlCmd}
                </Typography.Paragraph>
              </div>
            </div>
            <Typography.Text type="secondary">
              在目标机器上运行以上命令后，执行器将自动注册到当前 admin-api 并出现在列表中。
            </Typography.Text>
          </Space>
        )}
      </Modal>
    </div>
  );
}
