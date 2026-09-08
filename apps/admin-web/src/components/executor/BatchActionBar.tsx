/**
 * UI-07 ③：批量操作条（ADMIN 门控对齐 W2 既有前端门控模式）。
 *
 * 两个 ADMIN-only 操作，均复用既有单台端点（POST /executors/:id/reload-config、
 * /executors/:id/rotate-token），Promise.allSettled 并行 + 逐台结果反馈：
 * - 批量配置热更新：空配置体推送（执行器按服务端默认配置 reload——单台
 *   配置热更新表单的空表单等价语义），在线台才可执行；
 * - 批量 Token 轮换：高危——二次确认 Modal 列出受影响执行器并明示
 *   「执行器将短暂重新注册」；确认后并行执行，逐台新 token 收集展示一次。
 *
 * 门控语义：isAdmin=false 时本组件整体不渲染（由父级控制），组件内部仍
 * 保留 isAdmin 入参防御（测试断言门控用）。
 */
import { useState } from 'react';
import { Alert, Button, Modal, Space, Typography, Tag, message } from 'antd';
import { ControlOutlined, KeyOutlined } from '@ant-design/icons';
import type { Executor } from '../../api/executors';
import { executorsApi } from '../../api/executors';
import { getErrMsg } from '../../utils/error';

const { Text } = Typography;

export interface BatchOutcome {
  executor: Executor;
  ok: boolean;
  /** rotate 成功时的明文 token（Modal 一次性展示） */
  token?: string;
  error?: string;
}

export interface BatchSummary {
  total: number;
  succeeded: number;
  failed: number;
  outcomes: BatchOutcome[];
}

/** 并行执行单台操作并收集逐台结果（allSettled：单台失败不中断其余） */
export async function runBatch(
  executors: Executor[],
  action: (ex: Executor) => Promise<{ token?: string }>,
): Promise<BatchSummary> {
  const settled = await Promise.allSettled(
    executors.map(async (ex) => {
      const res = await action(ex);
      return { executor: ex, ok: true, token: res?.token } as BatchOutcome;
    }),
  );
  const outcomes: BatchOutcome[] = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          executor: executors[i],
          ok: false,
          error: getErrMsg(r.reason, '操作失败'),
        },
  );
  return {
    total: executors.length,
    succeeded: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    outcomes,
  };
}

interface BatchActionBarProps {
  selected: Executor[];
  isAdmin: boolean;
  onDone: () => void;
}

export default function BatchActionBar({ selected, isAdmin, onDone }: BatchActionBarProps) {
  const [batchLoading, setBatchLoading] = useState(false);
  const [tokenResult, setTokenResult] = useState<BatchSummary | null>(null);

  // 保留结果弹窗：轮换完成后 onDone 会清空选择（selected 变空会触发本组件
  // 早退卸载），tokenResult 一次性展示不能跟着消失——故仅在「无结果待展示」
  // 时早退。
  if (tokenResult === null && (!isAdmin || selected.length === 0)) return null;

  const online = selected.filter((ex) => ex.status === 'online');

  const finish = (summary: BatchSummary, okText: string) => {
    if (summary.failed === 0) {
      message.success(`${okText}成功 ${summary.succeeded}/${summary.total} 台`);
    } else if (summary.succeeded === 0) {
      message.error(`${okText}失败：${summary.outcomes.find((o) => !o.ok)?.error ?? '全部失败'}`);
    } else {
      message.warning(`${okText}完成：成功 ${summary.succeeded} 台，失败 ${summary.failed} 台`);
      // 部分失败时逐台 error 反馈（成功台不重复打扰）
      summary.outcomes.filter((o) => !o.ok).forEach((o) => {
        message.error(`${o.executor.appName}：${o.error}`);
      });
    }
    setBatchLoading(false);
    onDone();
  };

  const handleBatchReloadConfig = () => {
    if (batchLoading || online.length === 0) {
      message.warning('所选执行器均不在线，无法推送配置');
      return;
    }
    Modal.confirm({
      title: `批量配置热更新（${online.length} 台在线）`,
      content: '将向所选在线执行器推送配置热更新请求（空配置=按服务端默认值重载）。离线执行器自动跳过。确认继续？',
      okText: '确认推送',
      cancelText: '取消',
      onOk: async () => {
        setBatchLoading(true);
        try {
          const summary = await runBatch(online, async (ex) => {
            await executorsApi.reloadConfig(ex.id, {});
            return {};
          });
          finish(summary, '批量配置热更新');
        } catch (err) {
          message.error(getErrMsg(err, '批量配置热更新失败'));
          setBatchLoading(false);
        }
      },
    });
  };

  const handleBatchRotateToken = () => {
    if (batchLoading) return;
    Modal.confirm({
      title: `批量轮换 Token（${selected.length} 台）`,
      width: 560,
      content: (
        <div>
          <Alert
            type="warning"
            showIcon
            message="高危操作"
            description="轮换后旧 Token 立即失效，执行器将短暂重新注册后恢复连接。新 Token 仅在结果弹窗中展示一次。"
            style={{ marginBottom: 12 }}
          />
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {selected.map((ex) => (
              <div key={ex.id} style={{ padding: '2px 0' }}>
                <Text strong>{ex.appName}</Text>{' '}
                <Text type="secondary" style={{ fontSize: 12 }}>{ex.address}</Text>{' '}
                {ex.status !== 'online' && <Tag color="orange">离线</Tag>}
              </div>
            ))}
          </div>
        </div>
      ),
      okText: '确认轮换',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setBatchLoading(true);
        try {
          const summary = await runBatch(selected, (ex) => executorsApi.rotateToken(ex.id));
          if (summary.succeeded > 0) {
            // 新 token 一次性展示（关闭后不再显示——与单台轮换同语义）
            setTokenResult(summary);
          }
          finish(summary, '批量 Token 轮换');
        } catch (err) {
          message.error(getErrMsg(err, '批量 Token 轮换失败'));
          setBatchLoading(false);
        }
      },
    });
  };

  return (
    <>
      <Space
        data-testid="executor-batch-bar"
        size={8}
        wrap
        style={{ marginBottom: 12, padding: '6px 12px', background: '#fafafa', borderRadius: 6 }}
      >
        <Text type="secondary" style={{ fontSize: 12 }}>
          已选 {selected.length} 台
        </Text>
        <Button
          size="small"
          icon={<ControlOutlined />}
          loading={batchLoading}
          disabled={batchLoading || online.length === 0}
          onClick={handleBatchReloadConfig}
        >
          批量配置热更新
        </Button>
        <Button
          size="small"
          danger
          icon={<KeyOutlined />}
          loading={batchLoading}
          disabled={batchLoading}
          onClick={handleBatchRotateToken}
        >
          批量轮换 Token
        </Button>
        {online.length < selected.length && (
          <Text type="warning" style={{ fontSize: 12 }}>
            {online.length} 台在线（离线台仅可轮换 Token）
          </Text>
        )}
      </Space>

      <Modal
        title="批量轮换结果（新 Token 请妥善保存，关闭后不再显示）"
        open={tokenResult !== null}
        width={640}
        footer={<Button type="primary" onClick={() => setTokenResult(null)}>我已保存，关闭</Button>}
        onCancel={() => setTokenResult(null)}
      >
        {tokenResult && (
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            {tokenResult.outcomes.map((o) => (
              <div key={o.executor.id} style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
                <Space>
                  <Text strong>{o.executor.appName}</Text>
                  {o.ok ? (
                    o.token
                      ? <Text code copyable={{ text: o.token }} style={{ fontSize: 12 }}>{o.token.slice(0, 8)}…</Text>
                      : <Text type="secondary">成功</Text>
                  ) : (
                    <Tag color="red">失败：{o.error}</Tag>
                  )}
                </Space>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </>
  );
}
