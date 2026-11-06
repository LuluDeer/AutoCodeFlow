/**
 * R139 / P2-1：模型列表三态的**呈现**（与 `useVideoProviders` 配对）。
 *
 * 三种状态各自有独立的界面，且**互不冒充**：
 *   · `loading` → 加载态（骨架/转圈），不出现任何「没有模型」的判断；
 *   · `error`   → `StateError`（本地化错误 + 重试按钮），可恢复；
 *   · `ready` 且集合为空 → 「没有可用的视频模型」预警（这才是真空列表）。
 *
 * 修复前这三种状态被渲染成同一条 warning 预警，失败态还给出错误的处置建议
 * （「先去设置 → AI 接入」，而真实根因是一次失败的读请求）。
 */
import { Alert, Spin, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import StateError from '../../components/StateError';
import type { VideoProvidersResult } from './useVideoProviders';

const { Text } = Typography;

export interface ProviderStatusAlertProps {
  providers: VideoProvidersResult;
}

export default function ProviderStatusAlert({ providers }: ProviderStatusAlertProps) {
  const { t } = useTranslation();
  const { state, error, video, reload } = providers;

  if (state === 'error') {
    return (
      <StateError
        error={error}
        title={t('sopFromVideo.model.loadFailed')}
        onRetry={reload}
        style={{ marginBottom: 16 }}
      />
    );
  }

  if (state === 'loading') {
    return (
      <div data-testid="sopFromVideo-model-loading" style={{ marginBottom: 16 }}>
        <Spin size="small" />
        <Text type="secondary" style={{ marginLeft: 8 }}>
          {t('sopFromVideo.model.loading')}
        </Text>
      </div>
    );
  }

  // ready 且非空 ⇒ 无需任何提示（配置齐全的租户不该看到任何横幅）
  if (video.length > 0) return null;

  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 16 }}
      title={t('sopFromVideo.model.none')}
      description={t('sopFromVideo.model.hint')}
    />
  );
}
