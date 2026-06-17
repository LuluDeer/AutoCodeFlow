import { Card, Descriptions, Tag, Typography, Button, Space, Badge, Spin, Breadcrumb, message, Alert } from 'antd';
import { ArrowLeftOutlined, SyncOutlined, RedoOutlined, CopyOutlined, StopOutlined, RobotOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { useRequest } from 'ahooks';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { tasksApi } from '../api/tasks';
import { getErrMsg } from '../utils/error';
import { useAuthStore } from '../store/auth';

const { Text } = Typography;

const STATUS_MAP: Record<string, { color: string; label: string }> = {
  pending: { color: 'default', label: '等待中' },
  running: { color: 'processing', label: '运行中' },
  success: { color: 'green', label: '成功' },
  failed: { color: 'red', label: '失败' },
  timeout: { color: 'orange', label: '超时' },
  killed: { color: 'volcano', label: '已终止' },
  cancelled: { color: 'default', label: '已取消' },
};

const TRIGGER_LABEL: Record<string, string> = {
  manual: '手动触发', cron: 'Cron 定时', fixed_rate: '固定间隔',
  dependency: '依赖触发', misfire: '补偿触发',
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.floor(ms / 60000)} 分 ${Math.floor((ms % 60000) / 1000)} 秒`;
}

// Derive SSE URL using the same base as the axios client
function getSseBase(): string {
  const ext = import.meta.env.VITE_API_URL_EXTERNAL as string | undefined;
  const int_ = (import.meta.env.VITE_API_URL_INTERNAL as string | undefined) || '/api';
  return (ext && ext.trim()) ? ext.trim() : int_;
}

export default function ExecutionDetailPage() {
  const { taskId, execId } = useParams<{ taskId: string; execId: string }>();
  const nav = useNavigate();
  const logRef = useRef<HTMLPreElement>(null);
  const [retrying, setRetrying] = useState(false);
  const [killing, setKilling] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [streamLines, setStreamLines] = useState<string[] | null>(null);
  const [streaming, setStreaming] = useState(false);
  const token = useAuthStore((s) => s.token);

  const { data, refresh, loading } = useRequest(
    () => tasksApi.execution(taskId!, execId!),
    { pollingInterval: undefined, refreshDeps: [execId] },
  );

  // SSE log streaming when running
  useEffect(() => {
    if (data?.status !== 'running' && data?.status !== 'pending') return;
    const base = getSseBase().replace(/\/$/, '');
    const url = `${base}/tasks/${taskId}/executions/${execId}/logs/stream`;
    const es = new EventSource(url + (token ? `?token=${encodeURIComponent(token)}` : ''));
    setStreaming(true);
    setStreamLines([]);
    es.onmessage = (e) => {
      try {
        const line = JSON.parse(e.data) as string;
        setStreamLines((prev) => (prev ? [...prev, line] : [line]));
      } catch { /* ignore malformed */ }
    };
    es.addEventListener('done', () => {
      es.close();
      setStreaming(false);
      refresh(); // final status refresh
    });
    es.addEventListener('error', () => {
      es.close();
      setStreaming(false);
    });
    es.onerror = () => {
      es.close();
      setStreaming(false);
    };
    return () => { es.close(); setStreaming(false); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.status, execId, taskId]);

  // 日志滚动到底部
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [data?.logs, streamLines]);

  const handleKill = async () => {
    setKilling(true);
    try {
      await tasksApi.killExecution(taskId!, execId!);
      message.success('执行已终止');
      refresh();
    } catch (err: unknown) {
      message.error(getErrMsg(err, '终止失败'));
    } finally {
      setKilling(false);
    }
  };

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await tasksApi.trigger(taskId!);
      message.success('已重新触发，新的执行记录将在任务详情中显示');
      nav(`/tasks/${taskId}`);
    } catch (err: unknown) {
      message.error(getErrMsg(err, '触发失败'));
    } finally {
      setRetrying(false);
    }
  };

  if (loading && !data) {
    return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>;
  }

  const status = STATUS_MAP[data?.status || ''] || { color: 'default', label: data?.status };

  return (
    <div>
      <Breadcrumb
        items={[
          { title: <Link to="/executions">执行记录</Link> },
          { title: data?.taskName || '任务' },
          { title: '执行详情' },
        ]}
        style={{ marginBottom: 16 }}
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => nav(`/tasks/${taskId}`)}>返回任务</Button>
          <Tag color={status.color} style={{ fontSize: 14, padding: '2px 10px' }}>
            {status.label}
          </Tag>
          {data?.status === 'running' && (
            <Badge status="processing" text={<Text type="secondary">实时更新中</Text>} />
          )}
        </Space>
        <Space>
          {(data?.status === 'running' || data?.status === 'pending') && (
            <Button
              icon={<StopOutlined />}
              danger
              loading={killing}
              onClick={handleKill}
            >
              终止执行
            </Button>
          )}
          {data?.status === 'failed' && (
            <Button
              icon={<RedoOutlined />}
              type="primary"
              danger
              loading={retrying}
              onClick={handleRetry}
            >
              重新触发
            </Button>
          )}
          {(data?.status === 'failed' || data?.status === 'timeout') && (
            <Button
              icon={<RobotOutlined />}
              loading={analyzing}
              onClick={async () => {
                setAnalyzing(true);
                try {
                  await tasksApi.analyzeExecution(taskId!, execId!);
                  message.success('AI 分析完成');
                  refresh();
                } catch (err: unknown) {
                  message.error(getErrMsg(err, 'AI 分析失败'));
                } finally {
                  setAnalyzing(false);
                }
              }}
            >
              AI 分析
            </Button>
          )}
          <Button icon={<SyncOutlined />} onClick={refresh} loading={loading}>刷新</Button>
        </Space>
      </div>

      <Card title="执行信息" style={{ marginBottom: 16 }}>
        <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
          <Descriptions.Item label="任务名">
            <a onClick={() => nav(`/tasks/${taskId}`)}>{data?.taskName}</a>
          </Descriptions.Item>
          <Descriptions.Item label="触发方式">
            {TRIGGER_LABEL[data?.triggerType || ''] ?? data?.triggerType ?? '-'}
          </Descriptions.Item>
          <Descriptions.Item label="执行节点">
            {data?.executorAddress ? (
              <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{data.executorAddress}</span>
            ) : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="任务版本">{data?.taskVersion || '-'}</Descriptions.Item>
          <Descriptions.Item label="重试次数">{data?.retryCount ?? 0}</Descriptions.Item>
          <Descriptions.Item label="开始时间">
            {data?.startTime ? new Date(data.startTime).toLocaleString('zh-CN') : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="结束时间">
            {data?.endTime ? new Date(data.endTime).toLocaleString('zh-CN') : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="耗时">
            {data?.duration != null ? formatDuration(data.duration) : '-'}
          </Descriptions.Item>
          {data?.errorMessage && (
            <Descriptions.Item label="错误信息" span={3}>
              <Text type="danger">{data.errorMessage}</Text>
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      {data?.status === 'failed' && data.errorMessage && (
        <Alert
          type="error"
          message="执行失败"
          description={data.errorMessage}
          style={{ marginBottom: 16 }}
          action={
            <Button size="small" danger icon={<RedoOutlined />} onClick={handleRetry} loading={retrying}>
              重新触发
            </Button>
          }
        />
      )}

      {(data?.logs || (streamLines && streamLines.length > 0)) && (
        <Card
          title="执行日志"
          style={{ marginBottom: 16 }}
          extra={
            <Space>
              {streaming && <Badge status="processing" text="实时推送" />}
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => {
                  const txt = streamLines ? streamLines.join('\n') : (data?.logs ?? '');
                  navigator.clipboard.writeText(txt);
                  message.success('已复制');
                }}
              >
                复制
              </Button>
            </Space>
          }
        >
          <pre
            ref={logRef}
            style={{
              background: '#1e1e1e',
              color: '#d4d4d4',
              padding: 16,
              borderRadius: 8,
              maxHeight: 500,
              overflow: 'auto',
              fontSize: 12,
              margin: 0,
              fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {streamLines ? streamLines.join('\n') : data?.logs}
          </pre>
        </Card>
      )}

      {data?.aiAnalysis && (
        <Card
          title="🤖 AI 故障分析"
          style={{ borderColor: '#1677ff' }}
          styles={{ header: { background: 'linear-gradient(90deg, #e6f7ff, #f0f5ff)', color: '#1677ff' } }}
        >
          <Text style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.8 }}>
            {data.aiAnalysis}
          </Text>
        </Card>
      )}
    </div>
  );
}
