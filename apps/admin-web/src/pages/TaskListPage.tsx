import { useState } from 'react';
import {
  Table, Button, Tag, Space, Typography, message, Input, Select,
  Badge, Popconfirm, Tooltip, Empty, Switch, Modal, Form, Alert,
} from 'antd';
import {
  PlusOutlined, SearchOutlined, FilterOutlined, ThunderboltOutlined,
  DeleteOutlined, EyeOutlined, EditOutlined,
  CheckSquareOutlined,
} from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { useNavigate } from 'react-router-dom';
import { tasksApi, Task } from '../api/tasks';
import { getErrMsg } from '../utils/error';
import ParamsEditor from '../components/ParamsEditor';

const { Text } = Typography;

type BadgeStatus = 'success' | 'processing' | 'error' | 'default' | 'warning';
const STATUS_CONFIG: Record<string, { badge: BadgeStatus; label: string; color: string }> = {
  active: { badge: 'success', label: '运行中', color: 'green' },
  paused: { badge: 'warning', label: '已暂停', color: 'orange' },
  inactive: { badge: 'default', label: '未激活', color: 'default' },
  failed: { badge: 'error', label: '失败', color: 'red' },
};

const TRIGGER_LABEL: Record<string, string> = {
  manual: '手动', cron: 'Cron', fixed_rate: '定时', dependency: '依赖',
};

const TRIGGER_COLOR: Record<string, string> = {
  manual: 'default', cron: 'blue', fixed_rate: 'geekblue', dependency: 'purple',
};

export default function TaskListPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [triggerFilter, setTriggerFilter] = useState<string | undefined>();
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [triggerTarget, setTriggerTarget] = useState<{ id: string; name: string; defaultParams?: Record<string, unknown> } | null>(null);
  const [triggerParams, setTriggerParams] = useState<Record<string, string>>({});
  const [triggering, setTriggering] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const { data, loading, refresh } = useRequest(
    () => tasksApi.list({ page, pageSize, name: search || undefined, status: statusFilter, triggerType: triggerFilter }),
    { pollingInterval: 30000, refreshDeps: [page, pageSize, search, statusFilter, triggerFilter] },
  );

  const tasks: Task[] = data?.items ?? [];
  const total: number = data?.total ?? 0;

  const hasFilters = !!(search || statusFilter || triggerFilter);

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: React.Key[]) => setSelectedRowKeys(keys as string[]),
  };

  const handleBatchTrigger = async () => {
    if (batchLoading) return;
    setBatchLoading(true);
    try { await tasksApi.batchTrigger(selectedRowKeys); message.success(`已触发 ${selectedRowKeys.length} 个任务`); setSelectedRowKeys([]); refresh(); }
    catch (err: unknown) { message.error(getErrMsg(err, '批量触发失败')); }
    finally { setBatchLoading(false); }
  };
  const handleBatchPause = async () => {
    if (batchLoading) return;
    setBatchLoading(true);
    try { await tasksApi.batchPause(selectedRowKeys); message.success(`已暂停 ${selectedRowKeys.length} 个任务`); setSelectedRowKeys([]); refresh(); }
    catch (err: unknown) { message.error(getErrMsg(err, '批量暂停失败')); }
    finally { setBatchLoading(false); }
  };
  const handleBatchResume = async () => {
    if (batchLoading) return;
    setBatchLoading(true);
    try { await tasksApi.batchResume(selectedRowKeys); message.success(`已恢复 ${selectedRowKeys.length} 个任务`); setSelectedRowKeys([]); refresh(); }
    catch (err: unknown) { message.error(getErrMsg(err, '批量恢复失败')); }
    finally { setBatchLoading(false); }
  };
  const handleBatchDelete = async () => {
    if (batchLoading) return;
    setBatchLoading(true);
    try { await tasksApi.batchDelete(selectedRowKeys); message.success(`已删除 ${selectedRowKeys.length} 个任务`); setSelectedRowKeys([]); refresh(); }
    catch (err: unknown) { message.error(getErrMsg(err, '批量删除失败')); }
    finally { setBatchLoading(false); }
  };

  const handleTrigger = (id: string, name: string, defaultParams?: Record<string, unknown>) => {
    setTriggerParams(
      Object.fromEntries(Object.entries(defaultParams ?? {}).map(([k, v]) => [k, String(v)]))
    );
    setTriggerTarget({ id, name, defaultParams });
  };

  const handleTriggerConfirm = async () => {
    if (!triggerTarget) return;
    setTriggering(true);
    try {
      const params = Object.fromEntries(
        Object.entries(triggerParams).filter(([k]) => k.trim())
      );
      await tasksApi.trigger(triggerTarget.id, Object.keys(params).length > 0 ? params : undefined);
      message.success(`已触发: ${triggerTarget.name}`);
      setTriggerTarget(null);
      setTimeout(refresh, 1000);
    } catch (err: unknown) {
      message.error(getErrMsg(err, '触发失败'));
    } finally {
      setTriggering(false);
    }
  };

  const handlePause = async (id: string) => {
    if (togglingId) return;
    setTogglingId(id);
    try { await tasksApi.pause(id); message.success('已暂停'); refresh(); }
    catch (err: unknown) { message.error(getErrMsg(err, '暂停失败')); }
    finally { setTogglingId(null); }
  };

  const handleResume = async (id: string) => {
    if (togglingId) return;
    setTogglingId(id);
    try { await tasksApi.resume(id); message.success('已恢复'); refresh(); }
    catch (err: unknown) { message.error(getErrMsg(err, '恢复失败')); }
    finally { setTogglingId(null); }
  };

  const handleDelete = async (id: string) => {
    try { await tasksApi.delete(id); message.success('已删除'); refresh(); }
    catch (err: unknown) { message.error(getErrMsg(err, '删除失败')); }
  };

  const columns = [
    {
      title: '任务名称',
      key: 'name',
      sorter: (a: Task, b: Task) => a.name.localeCompare(b.name),
      render: (_: unknown, r: Task) => (
        <Space orientation="vertical" size={0}>
          <a onClick={() => nav(`/tasks/${r.id}`)} style={{ fontWeight: 500 }}>{r.name}</a>
          {r.description && <Text type="secondary" style={{ fontSize: 12 }}>{r.description}</Text>}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => {
        const cfg = STATUS_CONFIG[s] || { badge: 'default', label: s, color: 'default' };
        return <Badge status={cfg.badge} text={cfg.label} />;
      },
    },
    {
      title: '触发方式',
      dataIndex: 'triggerType',
      width: 100,
      render: (v: string) => (
        <Tag color={TRIGGER_COLOR[v] || 'default'}>{TRIGGER_LABEL[v] || v}</Tag>
      ),
    },
    {
      title: '调度',
      key: 'schedule',
      width: 160,
      render: (_: unknown, r: Task) => {
        if (r.triggerType === 'cron' && r.cronExpression) {
          return <Text code style={{ fontSize: 12 }}>{r.cronExpression}</Text>;
        }
        if (r.triggerType === 'fixed_rate' && r.fixedRate) {
          const secs = r.fixedRate;
          if (secs < 60) return <Text type="secondary" style={{ fontSize: 12 }}>每 {secs} 秒</Text>;
          const mins = Math.floor(secs / 60);
          const rem = secs % 60;
          const label = rem > 0 ? `${mins} 分 ${rem} 秒` : `${mins} 分钟`;
          return <Text type="secondary" style={{ fontSize: 12 }}>每 {label}</Text>;
        }
        return <Text type="secondary" style={{ fontSize: 12 }}>-</Text>;
      },
    },
    {
      title: '下次执行',
      key: 'nextRun',
      width: 150,
      render: (_: unknown, r: Task) => {
        if (r.status !== 'active') return <Text type="secondary" style={{ fontSize: 12 }}>-</Text>;
        if (r.triggerType === 'cron' && r.cronExpression) {
          return (
            <Tooltip title="下次 Cron 触发时间">
              <Tag color="blue" style={{ fontSize: 11 }}>Cron 计划中</Tag>
            </Tooltip>
          );
        }
        if (r.triggerType === 'fixed_rate' && r.fixedRate) {
          return <Tag color="geekblue" style={{ fontSize: 11 }}>定时运行中</Tag>;
        }
        return <Text type="secondary" style={{ fontSize: 12 }}>手动触发</Text>;
      },
    },
    {
      title: '运行时',
      dataIndex: 'runtime',
      width: 80,
      render: (v: string) => v ? <Tag>{v}</Tag> : '-',
    },
    {
      title: '启用',
      key: 'toggle',
      width: 70,
      render: (_: unknown, r: Task) => (
        <Switch
          size="small"
          checked={r.status === 'active'}
          loading={togglingId === r.id}
          onChange={checked => checked ? handleResume(r.id) : handlePause(r.id)}
          disabled={r.status === 'failed' || r.status === 'inactive' || (!!togglingId && togglingId !== r.id)}
        />
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_: unknown, r: Task) => (
        <Space size={2}>
          <Tooltip title="查看详情">
            <Button type="text" size="small" icon={<EyeOutlined />} onClick={() => nav(`/tasks/${r.id}`)} />
          </Tooltip>
          <Tooltip title="编辑">
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => nav(`/tasks/${r.id}/edit`)} />
          </Tooltip>
          <Tooltip title="立即执行">
            <Button
              type="text" size="small" icon={<ThunderboltOutlined />}
              onClick={() => handleTrigger(r.id, r.name, r.params)}
              style={{ color: '#1677ff' }}
            />
          </Tooltip>
          <Popconfirm
            title="确认删除此任务？"
            onConfirm={() => handleDelete(r.id)}
            okText="删除" okButtonProps={{ danger: true }}
          >
            <Tooltip title="删除">
              <Button type="text" size="small" icon={<DeleteOutlined />} danger />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>任务调度</Typography.Title>
          <Text type="secondary" style={{ fontSize: 13}}>
            {tasks.filter(t => t.status === 'active').length} 个运行中，共{tasks.length} 个任务
          </Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => nav('/tasks/new')}>
          创建任务
        </Button>
      </div>

      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          placeholder="搜索任务名、描述"
          prefix={<SearchOutlined />}
          value={search}
          onChange={e => setSearch(e.target.value)}
          allowClear
          style={{ width: 220 }}
        />
        <Select
          placeholder="全部状态"
          allowClear
          style={{ width: 110 }}
          value={statusFilter}
          onChange={setStatusFilter}
          suffixIcon={<FilterOutlined />}
          options={[
            { value: 'active', label: '运行中' },
            { value: 'paused', label: '已暂停' },
          ]}
        />
        <Select
          placeholder="触发方式"
          allowClear
          style={{ width: 120 }}
          value={triggerFilter}
          onChange={setTriggerFilter}
          options={[
            { value: 'manual', label: '手动' },
            { value: 'cron', label: 'Cron' },
            { value: 'fixed_rate', label: '固定间隔' },
          ]}
        />
        {hasFilters && (
          <Button size="small" onClick={() => { setSearch(''); setStatusFilter(undefined); setTriggerFilter(undefined); }}>
            清除筛选
          </Button>
        )}
        {hasFilters && (
          <Text type="secondary" style={{ fontSize: 13 }}>
            共 {total} 条
          </Text>
        )}
      </Space>

      {selectedRowKeys.length > 0 && (
        <div style={{ background: '#e6f4ff', border: '1px solid #91caff', borderRadius: 6, padding: '8px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <CheckSquareOutlined style={{ color: '#1677ff' }} />
          <Text>已选 <strong>{selectedRowKeys.length}</strong> 项</Text>
          <Button size="small" icon={<ThunderboltOutlined />} loading={batchLoading} disabled={batchLoading} onClick={handleBatchTrigger}>批量触发</Button>
          <Button size="small" loading={batchLoading} disabled={batchLoading} onClick={handleBatchPause}>批量暂停</Button>
          <Button size="small" loading={batchLoading} disabled={batchLoading} onClick={handleBatchResume}>批量恢复</Button>
          <Popconfirm title={`确认删除 ${selectedRowKeys.length} 个任务？`} onConfirm={handleBatchDelete} okText="删除" okButtonProps={{ danger: true }}>
            <Button size="small" danger icon={<DeleteOutlined />} loading={batchLoading} disabled={batchLoading}>批量删除</Button>
          </Popconfirm>
          <Button size="small" disabled={batchLoading} onClick={() => setSelectedRowKeys([])}>取消选择</Button>
        </div>
      )}

      <Modal
        title={<Space><ThunderboltOutlined /> 立即触发：{triggerTarget?.name}</Space>}
        open={!!triggerTarget}
        onCancel={() => setTriggerTarget(null)}
        onOk={handleTriggerConfirm}
        okText="触发"
        okButtonProps={{ loading: triggering, icon: <ThunderboltOutlined /> }}
        cancelText="取消"
        width={520}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          title="运行时参数（可选）"
          description="此处填写的参数会覆盖任务默认参数，以 AUTOFLOW_<KEY> 环境变量注入任务。留空则使用任务默认参数。"
          style={{ marginBottom: 16 }}
        />
        <Form layout="vertical">
          <Form.Item label="执行参数">
            <ParamsEditor
              value={triggerParams}
              onChange={setTriggerParams}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Table
        rowKey="id"
        rowSelection={rowSelection}
        columns={columns}
        dataSource={tasks}
        loading={loading}
        pagination={{
          total,
          current: page,
          pageSize,
          onChange: (p, ps) => { setPage(p); setPageSize(ps ?? 20); },
          showTotal: (t) => `共 ${t} 条`,
          showSizeChanger: true,
        }}
        locale={{
          emptyText: hasFilters
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无匹配任务" />
            : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务">
                <Button type="primary" onClick={() => nav('/tasks/new')}>创建第一个任务</Button>
              </Empty>
            ),
        }}
      />
    </div>
  );
}
