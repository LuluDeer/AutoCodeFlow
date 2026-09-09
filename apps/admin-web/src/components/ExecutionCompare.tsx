import { useState } from 'react';
import { Card, Table, Tag, Button, Space, Typography, Row, Col, Statistic, Modal, message } from 'antd';
import { TaskExecution } from '../api/tasks';

const { Text } = Typography;

const HIGHLIGHT_KEYS = new Set(['params', 'exitCode', 'duration', 'failureReason']);

function formatCompareValue(key: string, val: unknown): string {
  if (key === 'startTime' || key === 'endTime') {
    return val ? new Date(String(val)).toLocaleString() : '-';
  }
  if (key === 'duration' && typeof val === 'number') {
    return val >= 1000 ? `${(val / 1000).toFixed(1)}s` : `${val}ms`;
  }
  if (val === null || val === undefined || val === '') return '-';
  if (typeof val === 'object') return JSON.stringify(val, null, 2);
  return String(val);
}

function compareKeyOf(val: unknown): string {
  if (val === null || val === undefined || val === '') return '';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

interface ExecutionCompareProps {
  executions: TaskExecution[];
}

export const COMPARE_MAX = 5;

interface ExecutionCompareModalProps {
  open: boolean;
  onClose: () => void;
  /** 全量候选执行（modal 内按 compareIds 过滤取数） */
  executions: TaskExecution[];
  compareIds: string[];
}

/**
 * FEAT-03: 从孤儿组件 ExecutionCompare 拆出的纯对比视图——由调用方
 * （如 ExecutionsPage 的表格多选）提供入口与本页数据，modal 只负责渲染。
 * 独立自带的旧入口（default export）保留兼容。
 */
export function ExecutionCompareModal({ open, onClose, executions, compareIds }: ExecutionCompareModalProps) {
  const selectedExecutions = executions.filter(e => compareIds.includes(e.id));
  if (selectedExecutions.length === 0) return null;

  const cols = [
    { title: '指标', dataIndex: 'metric', key: 'metric' },
    ...compareIds.map(id => {
      const exec = selectedExecutions.find(e => e.id === id);
      return {
        title: <Text copyable={{ text: id }}>{exec?.startTime ? new Date(exec.startTime).toLocaleString() : id.slice(0, 8)}</Text>,
        key: id,
        render: (_: unknown, record: { metric: string; key: string }) => {
          const val = exec?.[record.key as keyof TaskExecution];
          if (record.key === 'status') {
            const color = val === 'success' ? 'green' : val === 'failed' ? 'red' : 'default';
            return <Tag color={color}>{String(val ?? '-')}</Tag>;
          }
          const display = formatCompareValue(record.key, val);
          const shouldHighlight =
            HIGHLIGHT_KEYS.has(record.key) &&
            new Set(
              selectedExecutions.map(item => compareKeyOf(item[record.key as keyof TaskExecution])),
            ).size > 1;
          return (
            <Text mark={shouldHighlight} style={{ whiteSpace: 'pre-wrap' }}>
              {display}
            </Text>
          );
        },
      };
    }),
  ];

  const rows = [
    { metric: '状态', key: 'status' },
    { metric: '触发方式', key: 'triggerType' },
    { metric: '任务版本', key: 'taskVersion' },
    { metric: '重试次数', key: 'retryCount' },
    { metric: '开始时间', key: 'startTime' },
    { metric: '结束时间', key: 'endTime' },
    { metric: '耗时', key: 'duration' },
    { metric: '参数', key: 'params' },
    { metric: '退出码', key: 'exitCode' },
    { metric: '失败分类', key: 'failureReason' },
    { metric: '错误信息', key: 'errorMessage' },
  ];

  return (
    <Modal
      title="执行对比"
      open={open}
      onCancel={onClose}
      footer={null}
      width={Math.min(240 + compareIds.length * 260, 1100)}
    >
      <Row gutter={16} style={{ marginBottom: 16 }}>
        {selectedExecutions.map((exec, idx) => (
          <Col span={24 / selectedExecutions.length} key={exec.id}>
            <Card size="small" title={`执行 ${idx + 1}`}>
              <Statistic
                title="状态"
                value={exec.status}
                styles={{ content: { color: exec.status === 'success' ? '#3f8600' : exec.status === 'failed' ? '#cf1322' : '#1890ff', fontSize: 16 } }}
              />
              <Statistic title="耗时" value={exec.duration ?? 0} suffix="ms" />
            </Card>
          </Col>
        ))}
      </Row>
      <Table columns={cols} dataSource={rows} rowKey="metric" pagination={false} size="small" />
    </Modal>
  );
}

export default function ExecutionCompare({ executions }: ExecutionCompareProps) {
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
    if (selectedIds.length > COMPARE_MAX) {
      message.warning(`最多对比${COMPARE_MAX}条执行记录`);
      return;
    }
    setCompareIds(selectedIds);
    setCompareOpen(true);
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

      <ExecutionCompareModal
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
        executions={executions}
        compareIds={compareIds}
      />
    </>
  );
}
