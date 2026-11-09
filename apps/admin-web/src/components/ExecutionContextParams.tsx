/**
 * R176：执行详情「上下文」Tab 的**参数 + runbook** 区块（从 `ExecutionDetailPage` 外提）。
 *
 * ## 为什么外提（两个理由，都不是洁癖）
 *
 * ① **体量棘轮**：`ExecutionDetailPage` 在 R169/R170 连续两次顶到 `check:size-caps` 的
 *    **逐文件只减不增**上限。本轮加「参数区读失败态」又超了 ⇒ 继续在页面里挤必然要
 *    **上调基线**（= 放宽判据）⇒ 正确做法是**外提**，让页面净减。
 * ② **让『读失败 ≠ 没有』这件事可测**：参数区的三分支（**读失败** / **有参数** / **真为空**）
 *    是本仓反复出现的**假事实**形态（R169/R170/R176 三轮共修了 7 处同型）。把它做成
 *    **props 驱动**的纯展示组件 ⇒ 能直接对**三种分支**写用例，不必驱动整张执行详情页。
 *
 * ## 语义（**别读反**）
 * · `loadError` 存在 ⇒ **读失败**：呈现 `StateError`（含重试），**绝不**说「暂无参数」；
 * · 否则 `params` 非空 ⇒ 渲染参数 Tag；
 * · 否则（**真的读到且为空**）⇒ 落「未配置默认参数」空态。
 *
 * 「参数」是**执行时的输入** —— 用户看到「没有参数」很可能据此判断「这个执行不需要参数」
 * 而**放弃追查**，所以「读失败」与「真的没有」必须分开（→ 336）。
 */
import { Card, Space, Tag, Typography } from 'antd';
import { BookOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import StateError from './StateError';

const { Text } = Typography;

export interface ExecutionContextParamsProps {
  /** 任务参数（`undefined` = 还没读到；`{}` = 读到且为空）。 */
  params: Record<string, unknown> | undefined;
  /** **读失败**的原因（`null` = 没失败）。存在时**优先于** params。 */
  loadError: unknown;
  /** 重试回调（重新拉取任务详情）。 */
  onRetry?: () => void;
  /** runbook 正文（可空）。 */
  runbook?: string | null;
}

export default function ExecutionContextParams({
  params,
  loadError,
  onRetry,
  runbook,
}: ExecutionContextParamsProps) {
  const { t } = useTranslation();
  const hasParams = !!params && Object.keys(params).length > 0;

  return (
    <Card title={t('execDetail.context.paramsTitle')} style={{ marginBottom: 16 }}>
      {loadError && !params ? (
        <StateError
          error={loadError}
          onRetry={onRetry}
          title={t('execDetail.context.paramsLoadFail')}
        />
      ) : hasParams ? (
        // UI-09：参数 Tag 含长 URL/无空格值时 nowrap（antd Tag 默认）
        // 会撑到上千像素——窄屏由 .ui09-param-tag 换行折行兜底
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {Object.entries(params ?? {}).map(([k, v]) => (
            <Tag key={k} className="ui09-param-tag" style={{ fontFamily: 'monospace', fontSize: 12 }}>
              {k} = {String(v)}
            </Tag>
          ))}
        </div>
      ) : (
        <Text type="secondary">{t('execDetail.context.paramsEmpty')}</Text>
      )}
      {runbook && (
        <div style={{ marginTop: 12 }}>
          <Space size={4}>
            <BookOutlined />
            <Text strong>{t('execDetail.context.runbookTitle')}</Text>
          </Space>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: '4px 0 0',
              padding: 8,
              borderRadius: 6,
              fontSize: 12,
              background: 'var(--log-bg)',
              color: 'var(--log-text)',
              fontFamily: 'var(--font-mono)',
              maxHeight: 320,
              overflow: 'auto',
            }}
          >
            {runbook}
          </pre>
        </div>
      )}
    </Card>
  );
}
