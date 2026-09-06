import { Card, Descriptions, Tag, Typography, Button, Space, Badge, Spin, Breadcrumb, message, Alert, Popconfirm, Result } from 'antd';
import { ArrowLeftOutlined, SyncOutlined, RedoOutlined, CopyOutlined, StopOutlined, RobotOutlined, DownloadOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { useRequest } from 'ahooks';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { tasksApi } from '../api/tasks';
import { getApiBaseUrl } from '../api/client';
import { getErrMsg } from '../utils/error';
import { useAuthStore } from '../store/auth';
import { formatDateTime, formatDuration } from '../utils/timeFormat';

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

const FAILURE_REASON_MAP: Record<string, { color: string; label: string; hint: string }> = {
  package_fetch_failed: { color: 'gold', label: '包拉取失败', hint: '检查代码仓库、依赖安装与网络连通性。' },
  // BUG-10 细化分类
  git_fetch_failed: { color: 'gold', label: 'Git 拉取失败', hint: '检查 gitRepo 地址、凭据、分支/commit 是否存在与网络连通性。' },
  dependency_install_failed: { color: 'gold', label: '依赖安装失败', hint: '检查 requirements 是否可解析、私服可达性与版本冲突。' },
  runtime_missing: { color: 'gold', label: '运行时缺失', hint: '执行器缺少任务运行时（node/python/uv）——安装运行时或改派到支持该 runtime 的执行器。' },
  script_error: { color: 'red', label: '脚本错误', hint: '检查任务脚本异常、退出码和运行时日志。' },
  timeout: { color: 'orange', label: '执行超时', hint: '检查任务耗时并调整超时配置。' },
  executor_offline: { color: 'volcano', label: '执行器离线', hint: '检查执行器在线状态、地址和网络。' },
  executor_restart: { color: 'volcano', label: '执行器重启', hint: '执行器重启导致运行中任务中断，检查执行器重启原因并按需重试。' },
  stale_recovered: { color: 'volcano', label: '失联回收', hint: '执行长时间无回调被中台回收；若任务仍有重试预算，中台已自动创建新执行（见同任务的后续执行）。' },
  killed: { color: 'default', label: '手动终止', hint: '执行被管理员手动终止。' },
  unknown: { color: 'default', label: '未知原因', hint: '查看错误信息和执行日志定位根因。' },
};

// U1: SSE 与 axios API 必须同源——复用 client.ts 的 getApiBaseUrl
// （含 localStorage 内/外网开关 autoflow_use_external_api）。
// 旧实现恒优先 VITE_API_URL_EXTERNAL，双地址配置时内网环境 SSE 永远打外网。
function getSseBase(): string {
  return getApiBaseUrl();
}

/**
 * U2: 与 admin-api task.service.ts 的 LOG_TRUNCATION_MARKER 对齐——执行器回调
 * 载荷超限时插入的截断标记（后端不返回 truncated 标志，只嵌在日志文本里）：
 * Node:   "... [logs truncated, original length N chars] ..."
 * Python: "...[truncated, total N chars]..."
 */
const LOG_TRUNCATION_MARKER = /\[\s*(?:logs\s+)?truncated\b/i;
// 后端 getExecutionLogs 单页上限（task.controller.ts limit 封顶 2000）
const LOG_PAGE_LIMIT = 2000;
// 兜底页数上限，与后端 backfill MAX_PAGES 对齐，防 hasMore 异常导致死循环
const LOG_MAX_PAGES = 200;

export default function ExecutionDetailPage() {
  const { taskId, execId } = useParams<{ taskId: string; execId: string }>();
  const nav = useNavigate();
  const logRef = useRef<HTMLPreElement>(null);
  const [retrying, setRetrying] = useState(false);
  const [killing, setKilling] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [streamLines, setStreamLines] = useState<string[] | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamDisconnected, setStreamDisconnected] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);
  // U2: 截断日志兜底——"加载完整日志"成功后覆盖显示（null=未加载）
  const [fullLogs, setFullLogs] = useState<string | null>(null);
  const [loadingFullLogs, setLoadingFullLogs] = useState(false);
  const token = useAuthStore((s) => s.token);

  const { data, refresh, loading, error } = useRequest(
    () => tasksApi.execution(taskId!, execId!),
    { pollingInterval: undefined, refreshDeps: [execId] },
  );
  const isLive = data?.status === 'running' || data?.status === 'pending';

  // SSE log streaming when running
  useEffect(() => {
    if (data?.status !== 'running' && data?.status !== 'pending') return;
    const base = getSseBase().replace(/\/$/, '');
    const url = `${base}/tasks/${taskId}/executions/${execId}/logs/stream`;
    // EventSource 无法设置请求头；后端仅对日志流路由支持 access_token 查询参数鉴权
    const es = new EventSource(url + (token ? `?access_token=${encodeURIComponent(token)}` : ''));
    setStreaming(true);
    setStreamDisconnected(false);
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
      setStreamDisconnected(false);
      refresh(); // final status refresh
    });
    const handleStreamError = () => {
      es.close();
      setStreaming(false);
      // 执行仍未终态：标记断流，交由轮询兜底并提示用户
      if (data?.status === 'running' || data?.status === 'pending') setStreamDisconnected(true);
    };
    es.addEventListener('error', handleStreamError);
    es.onerror = handleStreamError;
    return () => { es.close(); setStreaming(false); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.status, execId, taskId, reconnectKey]);

  // SSE 断流后的轮询兜底：仅对未终态执行刷新，到达终态后自动停止。
  // U3: 标签页不可见时跳过请求（与 useRequest pollingWhenHidden:false 语义一致），
  // 定时器保留，回到前台后下一拍即恢复刷新。
  useEffect(() => {
    if (!streamDisconnected || !isLive) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 8000);
    return () => clearInterval(timer);
  }, [streamDisconnected, isLive, refresh]);

  // 日志滚动到底部
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [data?.logs, streamLines]);

  // U2: 切换执行记录时丢弃上一条已加载的完整日志
  useEffect(() => {
    setFullLogs(null);
  }, [execId]);

  // U2: 当前展示的日志：完整日志 > SSE 流 > 实体回调日志
  const rawLogs = streamLines ? streamLines.join('\n') : (data?.logs ?? '');
  const displayLogs = fullLogs ?? rawLogs;
  const logsTruncated = fullLogs === null && LOG_TRUNCATION_MARKER.test(rawLogs);

  // U2: 回调日志被执行器截断时，从全量日志端点按行分页拉全（后端 limit 上限
  // 2000/页，hasMore 驱动翻页）。成功替换显示与复制/下载内容；失败 toast 保留现状。
  const handleLoadFullLogs = async () => {
    if (!taskId || !execId) return;
    setLoadingFullLogs(true);
    try {
      const all: string[] = [];
      let fromLine = 0;
      for (let page = 0; page < LOG_MAX_PAGES; page++) {
        const resp = await tasksApi.executionLogs(taskId, execId, { fromLine, limit: LOG_PAGE_LIMIT });
        const lines = Array.isArray(resp?.lines) ? resp.lines : [];
        if (lines.length === 0) break;
        all.push(...lines);
        fromLine += lines.length;
        if (!resp?.hasMore) break;
      }
      if (all.length === 0) {
        throw new Error('全量日志端点未返回日志行');
      }
      setFullLogs(all.join('\n'));
      message.success('已加载完整日志');
    } catch (err: unknown) {
      message.error(getErrMsg(err, '加载完整日志失败'));
    } finally {
      setLoadingFullLogs(false);
    }
  };

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

  // U7: 请求失败 ≠ 记录不存在——给出错误态与重试，而非全 '-' 空壳
  if (!data && error) {
    return (
      <Result
        status="error"
        title="执行详情加载失败"
        subTitle={getErrMsg(error, '请求失败，请重试')}
        extra={
          <Space>
            <Button onClick={() => nav(`/tasks/${taskId}`)}>返回任务</Button>
            <Button type="primary" icon={<SyncOutlined />} onClick={refresh}>重试</Button>
          </Space>
        }
      />
    );
  }

  const status = STATUS_MAP[data?.status || ''] || { color: 'default', label: data?.status };
  const failureReason = data?.failureReason
    ? FAILURE_REASON_MAP[data.failureReason] || {
        color: 'default',
        label: data.failureReason,
        hint: '未识别的失败分类，请查看错误信息和执行日志。',
      }
    : undefined;

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
          {data?.status === 'running' && !streamDisconnected && (
            <Badge status="processing" text={<Text type="secondary">实时更新中</Text>} />
          )}
        </Space>
        <Space>
          {(data?.status === 'running' || data?.status === 'pending') && (
            <Popconfirm
              title="确认终止此执行？"
              description="终止后执行将中断且不可恢复。"
              onConfirm={handleKill}
              okText="终止" okButtonProps={{ danger: true }}
            >
              <Button
                icon={<StopOutlined />}
                danger
                loading={killing}
              >
                终止执行
              </Button>
            </Popconfirm>
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

      {streamDisconnected && isLive && (
        <Alert
          type="warning"
          showIcon
          title="实时日志流已断开，已切换为轮询刷新"
          style={{ marginBottom: 16 }}
          action={
            <Button
              size="small"
              icon={<SyncOutlined />}
              onClick={() => { setStreamDisconnected(false); setReconnectKey((k) => k + 1); refresh(); }}
            >
              重新连接
            </Button>
          }
        />
      )}

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
            {data?.startTime ? formatDateTime(data.startTime) : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="结束时间">
            {data?.endTime ? formatDateTime(data.endTime) : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="耗时">
            {data?.duration != null ? formatDuration(data.duration) : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="退出码">
            {data?.exitCode != null ? (
              <Text type={data.exitCode !== 0 ? 'danger' : undefined} code>
                {data.exitCode}
              </Text>
            ) : '-'}
          </Descriptions.Item>
          {failureReason && (
            <Descriptions.Item label="失败分类" span={3}>
              <Space>
                <Tag color={failureReason.color}>{failureReason.label}</Tag>
                <Text type="secondary">{failureReason.hint}</Text>
              </Space>
            </Descriptions.Item>
          )}
          {data?.errorMessage && (
            <Descriptions.Item label="错误信息" span={3}>
              <Text type="danger">{data.errorMessage}</Text>
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      {['failed', 'timeout', 'killed'].includes(data?.status || '') && (data?.errorMessage || failureReason) && (
        <Alert
          type={data?.status === 'timeout' ? 'warning' : 'error'}
          title={failureReason ? `${status.label}：${failureReason.label}` : status.label}
          description={failureReason
            ? [failureReason.hint, data?.errorMessage].filter(Boolean).join('\n')
            : data?.errorMessage}
          style={{ marginBottom: 16, whiteSpace: 'pre-line' }}
          action={
            data?.status !== 'killed' ? (
              <Button size="small" danger icon={<RedoOutlined />} onClick={handleRetry} loading={retrying}>
                重新触发
              </Button>
            ) : undefined
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
                  navigator.clipboard.writeText(displayLogs);
                  message.success('已复制');
                }}
              >
                复制
              </Button>
              <Button
                size="small"
                icon={<DownloadOutlined />}
                onClick={() => {
                  const blob = new Blob([displayLogs], { type: 'text/plain;charset=utf-8' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `exec-${execId}-${new Date().toISOString().slice(0, 10)}.log`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                下载
              </Button>
            </Space>
          }
        >
          {logsTruncated && (
            <Alert
              type="warning"
              showIcon
              title="日志已截断：回调载荷超过执行器上报上限，当前仅保留了截断片段"
              description="可从执行器侧持久化的全量日志分页加载完整内容；若仍失败请检查执行器可达性与本地日志文件。"
              style={{ marginBottom: 12 }}
              action={
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  loading={loadingFullLogs}
                  onClick={handleLoadFullLogs}
                >
                  加载完整日志
                </Button>
              }
            />
          )}
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
            {displayLogs}
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
