import { useState } from 'react';
import { Table, Button, Tag, Space, Popconfirm, message, Typography } from 'antd';
import { PlusOutlined, PlayCircleOutlined, DeleteOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { useNavigate } from 'react-router-dom';
import { tasksApi, Task } from '../api/tasks';

const statusColor: Record<string, string> = {
  active: 'green', inactive: 'default', deleted: 'red',
};

export default function TaskListPage() {
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const { data, loading, refresh } = useRequest(() => tasksApi.list({ page, pageSize: 20 }), { refreshDeps: [page] });

  const trigger = async (id: string) => {
    try { await tasksApi.trigger(id); message.success('已触发'); } catch { message.error('触发失败'); }
  };

  const remove = async (id: string) => {
    try { await tasksApi.delete(id); message.success('已删除'); refresh(); } catch { message.error('删除失败'); }
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
        <Typography.Title level={4} style={{ margin: 0 }}>任务列表</Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => nav('/tasks/new')}>新建任务</Button>
      </div>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={data?.list}
        loading={loading}
        pagination={{ current: page, pageSize: 20, total: data?.total, onChange: setPage }}
      />
    </div>
  );
}
