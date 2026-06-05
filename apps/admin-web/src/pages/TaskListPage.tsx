import { useState } from 'react';
import { Table, Button, Tag, Space, Popconfirm, message, Typography, Dropdown } from 'antd';
import { PlusOutlined, PlayCircleOutlined, DeleteOutlined, PauseCircleOutlined, PlaySquareOutlined, MoreOutlined } from '@ant-design/icons';
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
  const { data, loading, refresh } = useRequest(() => tasksApi.list({ page, pageSize: 20 }), { refreshDeps: [page] });

  const trigger = async (id: string) => {
    try { await tasksApi.trigger(id); message.success('已触发'); } catch { message.error('触发失败'); }
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
      setSelectedRowKeys([]);
      refresh();
    } catch { message.error('批量触发失败'); }
  };

  const batchPause = async () => {
    if (selectedRowKeys.length === 0) { message.warning('请选择任务'); return; }
    try {
      await tasksApi.batchPause(selectedRowKeys);
      message.success(`已暂停 ${selectedRowKeys.length} 个任务`);
      setSelectedRowKeys([]);
      refresh();
    } catch { message.error('批量暂停失败'); }
  };

  const batchResume = async () => {
    if (selectedRowKeys.length === 0) { message.warning('请选择任务'); return; }
    try {
      await tasksApi.batchResume(selectedRowKeys);
      message.success(`已恢复 ${selectedRowKeys.length} 个任务`);
      setSelectedRowKeys([]);
      refresh();
    } catch { message.error('批量恢复失败'); }
  };

  const batchDelete = async () => {
    if (selectedRowKeys.length === 0) { message.warning('请选择任务'); return; }
    try {
      await tasksApi.batchDelete(selectedRowKeys);
      message.success(`已删除 ${selectedRowKeys.length} 个任务`);
      setSelectedRowKeys([]);
      refresh();
    } catch { message.error('批量删除失败'); }
  };

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: React.Key[]) => setSelectedRowKeys(keys as string[]),
  };

  const columns = [
    { title: '任务名', dataIndex: 'name', key: 'name', render: (v: string, r: Task) => <a onClick={() => nav(`/tasks/${r.id}`)}>{v}</a> },
    { title: '运行时', dataIndex: 'runtime', key: 'runtime' },
    { title: '触发方式', dataIndex: 'triggerType', key: 'triggerType' },
    { title: '状态', dataIndex: 'status', key: 'status', render: (v: string) => <Tag color={statusColor[v]}>{v}</Tag> },
    { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', render: (v: string) => new Date(v).toLocaleString() },
    {
      title: '操作', key: 'action',
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

  return (
    <div>
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
        columns={columns}
        dataSource={data?.list}
        loading={loading}
        rowSelection={rowSelection}
        pagination={{ current: page, pageSize: 20, total: data?.total, onChange: setPage }}
      />
    </div>
  );
}
