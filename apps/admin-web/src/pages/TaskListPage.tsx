import { useState, useRef } from 'react';
import { Table, Button, Tag, Space, Popconfirm, message, notification, Typography, Input, Select, Empty, Tabs, Switch, Badge } from 'antd';
import {
  PlusOutlined, PlayCircleOutlined, DeleteOutlined, PauseCircleOutlined,
  PlaySquareOutlined, SearchOutlined, FilterOutlined
} from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { useNavigate } from 'react-router-dom';
import { tasksApi, Task } from '../api/tasks';

const statusColor: Record<string, string> = {
  active: 'green', paused: 'orange', inactive: 'default', deleted: 'red',
};

export default function TaskListPage() {
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [searchName, setSearchName] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearchInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setSearchName(value);
      setPage(1);
    }, 300);
  };
  const [filterStatus, setFilterStatus] = useState<string | undefined>();
  const [filterRuntime, setFilterRuntime] = useState<string | undefined>();

  const { data, loading, refresh } = useRequest(
    () => tasksApi.list({ page, pageSize: 20, name: searchName || undefined, status: filterStatus, runtime: filterRuntime }),
    { refreshDeps: [page, searchName, filterStatus, filterRuntime] },
  );

  const handleSearch = () => { setPage(1); refresh(); };

  const trigger = async (id: string) => {
    try {
      await tasksApi.trigger(id);
      notification.success({
        message: '任务已触发',
        description: (
          <a onClick={() => nav('/executions')} style={{ cursor: 'pointer' }}>查看执行记录</a>
        ),
        duration: 4,
      });
    } catch { message.error('触发失败'); }
  };

  const remove = async (id: string) => {
    try { await tasksApi.delete(id); message.success('已删除'); refresh(); } catch { message.error('删除失败'); }
  };

  const pause = async (id: string) => {
    try { await tasksApi.pause(id); message.success('已暂停'); refresh(); } catch { message.error('暂停失败'); }
  };

  const resume = async (id: string) => {
    try { await tasksApi.resume(id); message.success('已恢复'); refresh(); } catch { message.error('恢复失败'); }
  };

  const batchTrigger = async () => {
    if (selectedRowKeys.length === 0) { message.warning('请选择任务'); return; }
    try {
      await tasksApi.batchTrigger(selectedRowKeys);
      message.success(`已触发 ${selectedRowKeys.length} 个任务`);
      setSelectedRowKeys([]); refresh();
    } catch { message.error('批量触发失败'); }
  };

  const batchPause = async () => {
    if (selectedRowKeys.length === 0) { message.warning('请选择任务'); return; }
    try {
      await tasksApi.batchPause(selectedRowKeys);
      message.success(`已暂停 ${selectedRowKeys.length} 个任务`);
      setSelectedRowKeys([]); refresh();
    } catch { message.error('批量暂停失败'); }
  };

  const batchResume = async () => {
    if (selectedRowKeys.length === 0) { message.warning('请选择任务'); return; }
    try {
      await tasksApi.batchResume(selectedRowKeys);
      message.success(`已恢复 ${selectedRowKeys.length} 个任务`);
      setSelectedRowKeys([]); refresh();
    } catch { message.error('批量恢复失败'); }
  };

  const batchDelete = async () => {
    if (selectedRowKeys.length === 0) { message.warning('请选择任务'); return; }
    try {
      await tasksApi.batchDelete(selectedRowKeys);
      message.success(`已删除 ${selectedRowKeys.length} 个任务`);
      setSelectedRowKeys([]); refresh();
    } catch { message.error('批量删除失败'); }
  };

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: React.Key[]) => setSelectedRowKeys(keys as string[]),
  };

  const columns = [
    {
      title: '任务名',
      dataIndex: 'name',
      key: 'name',
      sorter: (a: Task, b: Task) => a.name.localeCompare(b.name),
      render: (v: string, r: Task) => (
        <Space direction="vertical" size={0}>
          <Typography.Link onClick={() => nav(`/tasks/${r.id}`)}>{v}</Typography.Link>
          {r.description && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.description}</Typography.Text>
          )}
        </Space>
      ),
    },
    { title: '运行时', dataIndex: 'runtime', key: 'runtime', render: (v: string) => v ? <Tag>{v}</Tag> : '-' },
    {
      title: '触发方式',
      key: 'triggerType',
      render: (_: any, r: Task) => (
        <Space direction="vertical" size={0}>
          <span>{r.triggerType === 'manual' ? '手动' : r.triggerType === 'cron' ? 'Cron' : r.triggerType === 'fixed_rate' ? '定时' : r.triggerType}</span>
          {r.triggerType === 'cron' && r.cronExpression && (
            <Typography.Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace' }}>{r.cronExpression}</Typography.Text>
          )}
          {r.triggerType === 'fixed_rate' && r.fixedRate && (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>每 {r.fixedRate}s</Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => <Tag color={statusColor[v]}>{v}</Tag>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      sorter: (a: Task, b: Task) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      render: (v: string) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: '启用',
      key: 'enabled',
      width: 70,
      render: (_: any, r: Task) => (
        <Switch
          size="small"
          checked={r.status === 'active'}
          onChange={async (checked) => {
            try {
              await tasksApi.update(r.id, { status: checked ? 'active' : 'paused' });
              refresh();
            } catch { message.error('操作失败'); }
          }}
          onClick={(_, e) => e.stopPropagation()}
        />
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 220,
      render: (_: any, r: Task) => (
        <Space>
          <Button size="small" icon={<PlayCircleOutlined />} onClick={() => trigger(r.id)}>触发</Button>
          {r.status === 'active' ? (
            <Button size="small" icon={<PauseCircleOutlined />} onClick={() => pause(r.id)}>暂停</Button>
          ) : r.status === 'paused' ? (
            <Button size="small" icon={<PlaySquareOutlined />} onClick={() => resume(r.id)}>恢复</Button>
          ) : null}
          <Popconfirm title="确认删除?" onConfirm={() => remove(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const hasFilters = !!(searchName || filterStatus || filterRuntime);

  return (
    <div>
      {/* 状态快筛 */}
      <Tabs
        size="small"
        style={{ marginBottom: 4 }}
        activeKey={filterStatus ?? 'all'}
        onChange={(k) => { setFilterStatus(k === 'all' ? undefined : k); setPage(1); }}
        items={[
          { key: 'all', label: '全部' },
          { key: 'active', label: <Badge color="green" text="运行中" /> },
          { key: 'paused', label: <Badge color="orange" text="已暂停" /> },
          { key: 'inactive', label: <Badge color="default" text="未激活" /> },
        ]}
      />
      {/* 搜索/筛选栏 */}
      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          placeholder="搜索任务名"
          prefix={<SearchOutlined />}
          value={searchName}
          onChange={handleSearchInputChange}
          onPressEnter={handleSearch}
          allowClear
          onClear={() => { setSearchName(''); setPage(1); }}
          style={{ width: 200 }}
        />
        <Select
          placeholder="状态筛选"
          allowClear
          style={{ width: 120 }}
          value={filterStatus}
          onChange={(v) => { setFilterStatus(v); setPage(1); }}
          suffixIcon={<FilterOutlined />}
          options={[
            { value: 'active', label: '运行中' },
            { value: 'paused', label: '已暂停' },
            { value: 'inactive', label: '未激活' },
          ]}
        />
        <Select
          placeholder="运行时"
          allowClear
          style={{ width: 120 }}
          value={filterRuntime}
          onChange={(v) => { setFilterRuntime(v); setPage(1); }}
          options={[
            { value: 'python', label: 'Python' },
            { value: 'node', label: 'Node.js' },
            { value: 'shell', label: 'Shell' },
          ]}
        />
        <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>搜索</Button>
        {hasFilters && (
          <Button onClick={() => { setSearchName(''); setFilterStatus(undefined); setFilterRuntime(undefined); setPage(1); }}>
            清除筛选
          </Button>
        )}
      </Space>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Space>
          <Typography.Title level={4} style={{ margin: 0 }}>任务列表</Typography.Title>
          {selectedRowKeys.length > 0 && (
            <Typography.Text type="secondary">已选择 {selectedRowKeys.length} 项</Typography.Text>
          )}
        </Space>
        <Space>
          {selectedRowKeys.length > 0 && (
            <>
              <Button onClick={batchTrigger}>批量触发</Button>
              <Button onClick={batchPause}>批量暂停</Button>
              <Button onClick={batchResume}>批量恢复</Button>
              <Popconfirm title={`确认删除 ${selectedRowKeys.length} 个任务?`} onConfirm={batchDelete}>
                <Button danger>批量删除</Button>
              </Popconfirm>
            </>
          )}
          <Button type="primary" icon={<PlusOutlined />} onClick={() => nav('/tasks/new')}>新建任务</Button>
        </Space>
      </div>

      <Table
        rowKey="id"
        onRow={(r) => ({ onClick: () => nav(`/tasks/${r.id}`), style: { cursor: 'pointer' } })}
        columns={columns}
        dataSource={data?.list}
        loading={loading}
        rowSelection={rowSelection}
        pagination={{ current: page, pageSize: 20, total: data?.total, onChange: setPage, showTotal: t => `共 ${t} 条` }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                hasFilters ? (
                  <Space direction="vertical" size={4}>
                    <span>未找到匹配的任务</span>
                    <Button
                      type="link"
                      size="small"
                      onClick={() => { setSearchName(''); setFilterStatus(undefined); setFilterRuntime(undefined); setPage(1); }}
                    >
                      清除筛选条件
                    </Button>
                  </Space>
                ) : '暂无任务，点击「新建任务」开始'
              }
            />
          ),
        }}
      />
    </div>
  );
}
