/**
 * FEAT-05（UI 半场）：执行产物列表 + 逐条下载。
 *
 * 独立组件（不内联进 TaskDetailPage/ExecutionDetailPage），零跨会话足迹冲突。
 * 数据可来自两个渠道：
 *  - 已随执行对象提供 → 直接传 `artifacts` prop 渲染；
 *  - 未提供 → 组件用 `execId` 自行 GET /tasks/executions/:execId/artifacts 拉取。
 * 空清单返回 null（整段不渲染，作为详情页的兜底策略）。
 */
import { useState } from 'react';
import { Button, List, Space, Spin, Typography, message } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { artifactsApi, ExecutionArtifact } from '../api/artifacts';
import { useExecutionArtifacts } from '../api/queries';
import { getErrMsg } from '../utils/error';
import { formatArtifactSize } from '../utils/artifactSize';

interface ArtifactsListProps {
  /** 所属执行记录 id：下载与自取数都需要它 */
  execId: string;
  /** 已知的产物清单（如随执行对象带出）；省略时组件自行拉取 */
  artifacts?: ExecutionArtifact[];
}

export default function ArtifactsList({ execId, artifacts }: ArtifactsListProps) {
  const [busyName, setBusyName] = useState<string | null>(null);

  // 外部未提供清单时才自取数，避免与上层重复请求。
  // FEAT-17: useRequest 换 useExecutionArtifacts（queryKey 带 execId，
  // enabled 门控等价原 ready 语义）。
  const { data: fetched, isLoading: loading } = useExecutionArtifacts(
    execId,
    artifacts === undefined,
  );

  const list = artifacts ?? fetched ?? [];

  const handleDownload = async (name: string) => {
    if (busyName) return;
    setBusyName(name);
    try {
      await artifactsApi.downloadArtifact(execId, name);
    } catch (err: unknown) {
      message.error(getErrMsg(err, '产物下载失败'));
    } finally {
      setBusyName(null);
    }
  };

  if (list.length === 0) {
    // 自取数进行中 → 短暂 loading，避免闪现「无产物」再跳出内容
    if (loading && artifacts === undefined) {
      return (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin size="small" />
        </div>
      );
    }
    return null; // 空态：整段不渲染
  }

  return (
    <div>
      <Typography.Text strong style={{ fontSize: 13 }}>
        产物（{list.length}）
      </Typography.Text>
      <List
        size="small"
        style={{ marginTop: 8 }}
        dataSource={list}
        renderItem={(a) => (
          <List.Item
            actions={[
              <Button
                key="download"
                type="link"
                size="small"
                icon={<DownloadOutlined />}
                aria-label={`下载产物 ${a.name}`}
                loading={busyName === a.name}
                disabled={busyName !== null && busyName !== a.name}
                onClick={() => handleDownload(a.name)}
              >
                下载
              </Button>,
            ]}
          >
            <Space size={8} wrap>
              <Typography.Text style={{ fontFamily: 'monospace', fontSize: 12 }}>
                {a.name}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatArtifactSize(a.size)}
              </Typography.Text>
              {a.sha256 && (
                <Typography.Text type="secondary" style={{ fontSize: 11 }} title={a.sha256}>
                  sha256:{a.sha256.slice(0, 8)}
                </Typography.Text>
              )}
            </Space>
          </List.Item>
        )}
      />
    </div>
  );
}
