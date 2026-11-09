/**
 * P3-1（SOP 指派弹窗）：可接指派执行器的**三态**渲染（loading / ready / error）。
 *
 * ## 为什么独立成文件
 *
 * ① **体量**：`apps/admin-web/src/pages/SopsPage.tsx` 在体量棘轮顶格
 *    （scripts/source-size-baseline.json：nonCommentLines=996 / functionLines=1062，
 *    只减不增）——新增的取数状态机必须外提，本组件是「页面只留调用与渲染」的落点。
 * ② **语义独立**：这段 JSX 只回答一个问题——「可接指派的执行器现在是什么状态」。
 *    判据见 useAssignableExecutors.ts 的头注。
 *
 * ## 三态与渲染的对应（**核心纪律：读取失败 ≠ 数据为空**）
 *
 *  · `loading` ⇒ 只给一个轻量加载指示，**不渲染**空态警告。首屏不得先报空态：
 *    否则请求在途的 100–300ms 内，用户看到的是「机群里没有可接单的机器」+ 一条
 *    **可执行但错误**的处置建议（去桌面端启用 Agent），而真相只是「还没读到」。
 *  · `ready` 且列表为空 ⇒ 渲染 `sops.assignEmpty`（**真空态**才说这句话）。
 *  · `error` ⇒ 渲染 StateError 标准错误块（错误原因 + 可复制原文）+「重新加载」
 *    按钮（**可恢复路径**）。既不说「没有可接指派的执行器」，也不让用户无路可走。
 */
import { Alert, Button, Spin, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { ReloadOutlined } from '@ant-design/icons';
import StateError from '../../components/StateError';
import type { AssignableExecutors } from './useAssignableExecutors';

const { Text } = Typography;

export interface AssignableExecutorPickerProps {
  /** 三态取数结果（items / state / error / reload）。 */
  assignable: AssignableExecutors;
}

/**
 * 可接指派执行器的状态渲染（loading 指示 / 真空态警告 / 错误块 + 重新加载）。
 *
 * 单独抽出以便页面只留一行调用，也让「首屏不报空态」这条判据有**唯一**实现点。
 */
export default function AssignableExecutorPicker({ assignable }: AssignableExecutorPickerProps) {
  const { t } = useTranslation();
  const { items, state, error, reload } = assignable;

  if (state === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Spin size="small" />
        <Text type="secondary">{t('sops.assignLoading')}</Text>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* 全站统一的页内错误块：标题 + 失败原因 + 复制原文（ExecutorPackagesPage 同款） */}
        <StateError error={error} title={t('sops.assignableError.title')} style={{ padding: 12 }} />
        {/* 可恢复路径：重试按钮（重发一次取数请求），不要求用户关窗重开 */}
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={reload}
          data-testid="sop-assign-reload"
        >
          {t('sops.assignableError.retry')}
        </Button>
      </div>
    );
  }

  // ready：只有**真的读到空列表**才说「没有可接指派的执行器」
  if (items.length === 0) {
    return <Alert type="warning" showIcon title={t('sops.assignEmpty')} />;
  }

  // ready 且有候选：不在此处渲染（候选由执行器下拉承载）
  return null;
}
