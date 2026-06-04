import { Card, Descriptions, Tag, Typography, Button, Space } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { useParams, useNavigate } from 'react-router-dom';
import { tasksApi } from '../api/tasks';

const statusColor: Record<string, string> = {
  pending: 'default', running: 'processing', success: 'green', failed: 'red',
};

export default function ExecutionDetailPage() {
  const { taskId, execId } = useParams<{ taskId: string; execId: string }>();
  const nav = useNavigate();
  const { data } = useRequest(() => tasksApi.execution(taskId!, execId!));

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav(`/tasks/${taskId}`)}>返回</Button>
        <Typography.Title level={4} style={{ margin: 0 }}>执行详情</Typography.Title>
      </Space>

      <Card title="基本信息" style={{ marginBottom: 16 }}>
        <Descriptions column={2}>
          <Descriptions.Item label="执行ID">{data?.id}</Descriptions.Item>
          <Descriptions.Item label="任务名">{data?.taskName}</Descriptions.Item>
          <Descriptions.Item label="状态"><Tag color={statusColor[data?.status || '']}>{data?.status}</Tag></Descriptions.Item>
          <Descriptions.Item label="触发方式">{data?.triggerType}</Descriptions.Item>
          <Descriptions.Item label="开始时间">{data?.startTime ? new Date(data.startTime).toLocaleString() : '-'}</Descriptions.Item>
          <Descriptions.Item label="结束时间">{data?.endTime ? new Date(data.endTime).toLocaleString() : '-'}</Descriptions.Item>
          <Descriptions.Item label="耗时">{data?.duration ? `${data.duration}ms` : '-'}</Descriptions.Item>
          <Descriptions.Item label="错误信息">{data?.errorMessage || '-'}</Descriptions.Item>
        </Descriptions>
      </Card>

      {data?.logs && (
        <Card title="执行日志" style={{ marginBottom: 16 }}>
          <pre style={{ background: '#1a1a1a', color: '#00ff00', padding: 16, borderRadius: 4, maxHeight: 400, overflow: 'auto', fontSize: 12 }}>
            {data.logs}
          </pre>
        </Card>
      )}

      {data?.aiAnalysis && (
        <Card title="AI 分析" style={{ borderColor: '#1677ff' }}>
          <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>{data.aiAnalysis}</Typography.Text>
        </Card>
      )}
    </div>
  );
}
