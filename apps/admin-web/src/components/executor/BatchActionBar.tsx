/**
 * UI-07 ③：批量操作条（ADMIN 门控对齐 W2 既有前端门控模式）。
 *
 * 两个 ADMIN-only 操作，均复用既有单台端点（POST /executors/:id/reload-config、
 * /executors/:id/rotate-token），并行 + 逐台结果反馈：
 * - 批量配置热更新：空配置体推送（执行器按服务端默认配置 reload——单台
 *   配置热更新表单的空表单等价语义），在线台才可执行；
 * - 批量 Token 轮换：高危——二次确认 Modal 列出受影响执行器并明示
 *   「执行器将短暂重新注册」；确认后并行执行，逐台新 token 收集展示一次。
 *
 * B-13：confirm 弹窗 + 执行 + 汇总反馈的公共实现抽到 batchActions.tsx，
 * 卡片视图快捷按钮（单台直达）与本条复用同一流程；本组件只保留操作条
 * UI 与 loading 状态。rotate 成功台的 token 结果弹窗由父级
 * （ExecutorListPage）持有渲染——批量条在选中清空后会卸载，不能承载它。
 *
 * 门控语义：isAdmin=false 时本组件整体不渲染（由父级控制），组件内部仍
 * 保留 isAdmin 入参防御（测试断言门控用）。
 */
import { useState } from 'react';
import { Button, Space, Typography, theme } from 'antd';
import { ControlOutlined, KeyOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { Executor } from '../../api/executors';
import {
  confirmBatchReloadConfig,
  confirmBatchRotateToken,
  type BatchSummary,
} from './batchActions';
import '../../i18n';

// 向后兼容既有导入面（executor-ui07 等测试从本文件 import runBatch）
export { runBatch } from './batchActions';
export type { BatchOutcome, BatchSummary } from './batchActions';

const { Text } = Typography;

interface BatchActionBarProps {
  selected: Executor[];
  isAdmin: boolean;
  onDone: () => void;
  /** B-13：rotate 有成功台时回调（token 结果弹窗由父级渲染） */
  onTokenSummary?: (summary: BatchSummary) => void;
}

export default function BatchActionBar({ selected, isAdmin, onDone, onTokenSummary }: BatchActionBarProps) {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：浅填充/分隔线走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
  const [batchLoading, setBatchLoading] = useState(false);

  if (!isAdmin || selected.length === 0) return null;

  const online = selected.filter((ex) => ex.status === 'online');

  const shared = {
    t,
    onStart: () => setBatchLoading(true),
    onSettle: () => setBatchLoading(false),
    onTokenSummary,
    onDone,
  };

  return (
    <Space
      data-testid="executor-batch-bar"
      size={8}
      wrap
      style={{ marginBottom: 12, padding: '6px 12px', background: token.colorFillQuaternary, borderRadius: 6 }}
    >
      <Text type="secondary" style={{ fontSize: 12 }}>
        {t('batchAction.selected', { count: selected.length })}
      </Text>
      <Button
        size="small"
        icon={<ControlOutlined />}
        loading={batchLoading}
        disabled={batchLoading || online.length === 0}
        onClick={() => confirmBatchReloadConfig({ executors: online, ...shared })}
      >
        {t('batchAction.batchReload')}
      </Button>
      <Button
        size="small"
        danger
        icon={<KeyOutlined />}
        loading={batchLoading}
        disabled={batchLoading}
        onClick={() => confirmBatchRotateToken({ executors: selected, ...shared })}
      >
        {t('batchAction.batchRotate')}
      </Button>
      {online.length < selected.length && (
        <Text type="warning" style={{ fontSize: 12 }}>
          {t('batchAction.onlineHint', { count: online.length })}
        </Text>
      )}
    </Space>
  );
}
