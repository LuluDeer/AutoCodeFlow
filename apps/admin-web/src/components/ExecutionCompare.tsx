import { useState } from 'react';
import { Card, Table, Tag, Button, Space, Typography, Row, Col, Statistic, Modal, Select, message } from 'antd';
import { useRequest } from 'ahooks';
import { TaskExecution } from '../api/tasks';

const { Text } = Typography;

interface ExecutionCompareProps {
  taskId: string;
  executions: TaskExecution[];
}

export default function ExecutionCompare({ taskId, executions }: ExecutionCompareProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);

  const columns = [
    { title: '执行ID', dataIndex: 'id', key: 'id', width: 280, render: (v: string) => <Text copyable={{ text: v }}>{v.slice(0, 8)}...</Text> },
    { title: '状态', dataIndex: 'status', key: 'status', render: (v: string) => {
      const color = v === 'success' ? 'green' : v === 'failed' ? 'red' : v === 'running' ? 'blue' : 'default';
      return <Tag color={color}>{v}</Tag>;
    }},
    { title: '触发方式', dataIndex: 'triggerType', key: 'triggerType' },
    { title: '开始时间', dataIndex: 'startTime', key: 'startTime', render: (v: string) => v ? new Date(v).toLocaleString() : '-' },
    { title: '耗时(ms)', dataIndex: 'duration', key: 'duration', render: (v: number) => v ?? '-' },
    { title: '执行人', dataIndex: 'triggeredBy', key: 'triggeredBy', render: (v: string) => v || '系统' },
  ];

  const rowSelection = {
    selectedRowKeys: selectedIds,
    onChange: (keys: React.Key[]) => setSelectedIds(keys as string[]),
  };

  const handleCompare = () => {
    if (selectedIds.length < 2) {
      message.warning('请选择至少2条执行记录进行对比');
      return;
    }
    if (selectedIds.length > 5) {
      message.warning('最多对比5条执行记录');
      return;
    }
    setCompareIds(selectedIds);
    setCompareOpen(true);
  };

  const selectedExecutions = executions.filter(e => compareIds.includes(e.id));

  const renderCompareTable = () => {
    const cols = [
      { title: '指标', dataIndex: 'metric', key: 'metric' },
      ...compareIds.map(id => {
        const exec = selectedExecutions.find(e => e.id === id);
        return {
          title: <Text copyable={{ text: id }}>{exec?.startTime ? new Date(exec.startTime).toLocaleString() : id.slice(0, 8)}</Text>,
          key: id,
          render: (_: any, record: any) => {
            const val = exec?.[record.key as keyof TaskExecution];
            if (record.key === 'status') {
              const color = val === 'success' ? 'green' : val === 'failed' ? 'red' : 'default';
              return <Tag color={color}>{String(val)}</Tag>;
            }
            return String(val ?? '-');
          },
        };
      }),
    ];

    const rows = [
      { metric: '状态', status: true },
      { metric: '触发方式', triggerType: true },
      { metric: '开始时间', startTime: true },
      { metric: '结束时间', endTime: true },
      { metric: '耗时(ms)', duration: true },
      { metric: '执行人', triggeredBy: true },
      { metric: '错误信息', errorMessage: true },
    ];

    return <Table columns={cols} dataSource={rows} rowKey="metric" pagination={false} size="small" />;
  };

  return (
    <>
      <Space style={{ marginBottom: 16 }}>
        <Button onClick={() => setSelectedIds([])}>清除选择</Button>
        <Button type="primary" disabled={selectedIds.length < 2} onClick={handleCompare}>
          对比 {selectedIds.length > 0 ? `(${selectedIds.length})` : ''}
        </Button>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={executions}
        rowSelection={rowSelection}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title="执行历史对比"
        open={compareOpen}
        onCancel={() => setCompareOpen(false)}
        footer={null}
        width={800}
      >
        <Row gutter={16} style={{ marginBottom: 16 }}>
          {selectedExecutions.map((exec, idx) => (
            <Col span={24 / selectedExecutions.length} key={exec.id}>
              <Card size="small" title={`执行 ${idx + 1}`}>
                <Statistic
                  title="状态"
                  value={exec.status}
                  valueStyle={{ color: exec.status === 'success' ? '#3f8600' : exec.status === 'failed' ? '#cf1322' : '#1890ff' }}
                />
                <Statistic title="耗时" value={exec.duration ?? 0} suffix="ms" />
              </Card>
            </Col>
          ))}
        </Row>
        {renderCompareTable()}
      </Modal>
    </>
  );
}
