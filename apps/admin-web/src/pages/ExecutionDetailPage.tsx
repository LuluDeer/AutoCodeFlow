import { Card, Descriptions, Tag, Typography, Button, Space, Progress, Badge, Spin, Breadcrumb } from 'antd';
import { ArrowLeftOutlined, SyncOutlined } from '@ant-design/icons';
import { useEffect, useRef } from 'react';
import { useRequest } from 'ahooks';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { tasksApi } from '../api/tasks';

const statusColor: Record<string, string> = {
  pending: 'default', running: 'processing', success: 'green', failed: 'red',
};

export default function ExecutionDetailPage() {
  const { taskId, execId } = useParams<{ taskId: string; execId: string }>();
  const nav = useNavigate();
  const logRef = useRef<HTMLPreElement>(null);
  const { data, refresh } = useRequest(() => tasksApi.execution(taskId!, execId!), {
    pollingInterval: undefined,
    refreshDeps: [execId],
  });

  // 运行中自动刷新
  useEffect(() => {
    if (data?.status !== 'running') return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [data?.status, refresh]);

  // 日志更新后滚动到底部
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [data?.logs]);

  return (
    <div>
      <Breadcrumb
        items={[
          { title: <Link to="/dashboard">首页</Link> },
          { title: <Link to="/executions">执行记录</Link> },
          { title: '执行详情' },
        ]}
        style={{ marginBottom: 16 }}
      />
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav(`/tasks/${taskId}`)}>返回</Button>
        <Typography.Title level={4} style={{ margin: 0 }}>执行详情</Typography.Title>
        {data?.status === 'running' && (
          <Badge status="processing" text={<Spin size="small" indicator={<SyncOutlined spin />} />} />
        )}
      </Space>

      {data?.status === 'running' && (
        <Progress percent={99} status="active" showInfo={false} style={{ marginBottom: 16 }} />
      )}

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
        <Card
          title="执行日志"
          style={{ marginBottom: 16 }}
          extra={data?.status === 'running' && <Badge status="processing" text="实时更新中" />}
        >
          <pre
            ref={logRef}
            style={{ background: '#1a1a1a', color: '#00ff00', padding: 16, borderRadius: 4, maxHeight: 400, overflow: 'auto', fontSize: 12, margin: 0 }}
          >
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
