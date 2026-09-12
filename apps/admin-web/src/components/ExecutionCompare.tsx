import { useState } from 'react';
import { Card, Table, Tag, Button, Space, Typography, Row, Col, Statistic, Modal, message } from 'antd';
import { useTranslation } from 'react-i18next';
import '../i18n';
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
  const { t } = useTranslation();
  const selectedExecutions = executions.filter(e => compareIds.includes(e.id));
  if (selectedExecutions.length === 0) return null;

  const cols = [
    { title: t('execCompare.col.metric'), dataIndex: 'metric', key: 'metric' },
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
    { metric: t('execCompare.metric.status'), key: 'status' },
    { metric: t('execCompare.metric.triggerType'), key: 'triggerType' },
    { metric: t('execCompare.metric.taskVersion'), key: 'taskVersion' },
    { metric: t('execCompare.metric.retryCount'), key: 'retryCount' },
    { metric: t('execCompare.metric.startTime'), key: 'startTime' },
    { metric: t('execCompare.metric.endTime'), key: 'endTime' },
    { metric: t('execCompare.metric.duration'), key: 'duration' },
    { metric: t('execCompare.metric.params'), key: 'params' },
    { metric: t('execCompare.metric.exitCode'), key: 'exitCode' },
    { metric: t('execCompare.metric.failureReason'), key: 'failureReason' },
    { metric: t('execCompare.metric.errorMessage'), key: 'errorMessage' },
  ];

  return (
    <Modal
      title={t('execCompare.title')}
      open={open}
      onCancel={onClose}
      footer={null}
      width={Math.min(240 + compareIds.length * 260, 1100)}
    >
      <Row gutter={16} style={{ marginBottom: 16 }}>
        {selectedExecutions.map((exec, idx) => (
          <Col span={24 / selectedExecutions.length} key={exec.id}>
            <Card size="small" title={t('execCompare.execTitle', { idx: idx + 1 })}>
              <Statistic
                title={t('execCompare.stat.status')}
                value={exec.status}
                styles={{ content: { color: exec.status === 'success' ? '#3f8600' : exec.status === 'failed' ? '#cf1322' : '#1890ff', fontSize: 16 } }}
              />
              <Statistic title={t('execCompare.stat.duration')} value={exec.duration ?? 0} suffix="ms" />
            </Card>
          </Col>
        ))}
      </Row>
      <Table columns={cols} dataSource={rows} rowKey="metric" pagination={false} size="small" />
    </Modal>
  );
}

export default function ExecutionCompare({ executions }: ExecutionCompareProps) {
  const { t } = useTranslation();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);

  const columns = [
    { title: t('execCompare.table.id'), dataIndex: 'id', key: 'id', width: 280, render: (v: string) => <Text copyable={{ text: v }}>{v.slice(0, 8)}...</Text> },
    { title: t('execCompare.table.status'), dataIndex: 'status', key: 'status', render: (v: string) => {
      const color = v === 'success' ? 'green' : v === 'failed' ? 'red' : v === 'running' ? 'blue' : 'default';
      return <Tag color={color}>{v}</Tag>;
    }},
    { title: t('execCompare.table.triggerType'), dataIndex: 'triggerType', key: 'triggerType' },
    { title: t('execCompare.table.startTime'), dataIndex: 'startTime', key: 'startTime', render: (v: string) => v ? new Date(v).toLocaleString() : '-' },
    { title: t('execCompare.table.duration'), dataIndex: 'duration', key: 'duration', render: (v: number) => v ?? '-' },
  ];

  const rowSelection = {
    selectedRowKeys: selectedIds,
    onChange: (keys: React.Key[]) => setSelectedIds(keys as string[]),
  };

  const handleCompare = () => {
    if (selectedIds.length < 2) {
      message.warning(t('execCompare.minSelect'));
      return;
    }
    if (selectedIds.length > COMPARE_MAX) {
      message.warning(t('execCompare.maxCompare', { max: COMPARE_MAX }));
      return;
    }
    setCompareIds(selectedIds);
    setCompareOpen(true);
  };

  return (
    <>
      <Space style={{ marginBottom: 16 }}>
        <Button onClick={() => setSelectedIds([])}>{t('execCompare.clearSelection')}</Button>
        <Button type="primary" disabled={selectedIds.length < 2} onClick={handleCompare}>
          {t('execCompare.compare')} {selectedIds.length > 0 ? `(${selectedIds.length})` : ''}
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
