import { Table, Typography, Badge, Tag, Button } from 'antd';
import { useRequest } from 'ahooks';
import { useNavigate } from 'react-router-dom';
import { executorsApi } from '../api/executors';

export default function ExecutorListPage() {
  const { data, loading } = useRequest(executorsApi.list, { pollingInterval: 15000 });
  const navigate = useNavigate();

  const columns = [
    { title: 'AppName', dataIndex: 'appName', key: 'appName' },
    { title: '地址', dataIndex: 'address', key: 'address' },
    { title: '分组', dataIndex: 'groupName', key: 'groupName', render: (v: string) => v || '-' },
    { title: '标签', dataIndex: 'tags', key: 'tags', render: (v: string[]) => v?.length ? v.map(t => <Tag key={t}>{t}</Tag>) : '-' },
    { title: '类型', dataIndex: 'type', key: 'type' },
    { title: '版本', dataIndex: 'version', key: 'version' },
    {
      title: '状态', dataIndex: 'status', key: 'status',
      render: (v: string) => <Badge status={v === 'online' ? 'success' : 'default'} text={v} />,
    },
    { title: 'CPU%', dataIndex: 'cpuUsage', key: 'cpuUsage', render: (v: number) => `${v?.toFixed(1) ?? '-'}%` },
    { title: 'MEM%', dataIndex: 'memUsage', key: 'memUsage', render: (v: number) => `${v?.toFixed(1) ?? '-'}%` },
    { title: '运行任务数', dataIndex: 'runningTaskCount', key: 'runningTaskCount' },
    { title: '最后心跳', dataIndex: 'lastHeartbeat', key: 'lastHeartbeat', render: (v: string) => v ? new Date(v).toLocaleString() : '-' },
    {
      title: '操作', key: 'action', width: 80,
      render: (_: any, record: any) => <Button type="link" onClick={() => navigate(`/executors/${record.id}`)}>详情</Button>,
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 16 }}>执行器列表</Typography.Title>
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} />
    </div>
  );
}
