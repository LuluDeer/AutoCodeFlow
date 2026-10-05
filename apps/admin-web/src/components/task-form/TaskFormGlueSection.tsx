/**
 * REFACTOR-TASKFORM-02：「Glue 脚本」分区（原 TaskFormPage 内联区块原样迁出）。
 *
 * 既有行为语义保持：创建态在提交成功前不渲染 GlueEditor（glueTaskId 为空时
 * 显示锁定提示）——taskId 来自 createdTaskId（创建成功后设置）或编辑态的
 * editId，由父页传入。
 */
import { lazy, Suspense } from 'react';
import { Alert, Card, Button, Space, Typography, Divider, Spin } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import '../../i18n';
// PERF（对齐 TaskDetailPage 既有先例）：GlueEditor 拖带 monaco（约 2.5MB 的
// lazy chunk）。此前静态 import 让任务表单路由 chunk 与 GlueEditor chunk 产生
// **静态边**——创建态在提交成功前（glueTaskId 为空）本来就不渲染编辑器，路由
// 加载时却要整包预取 monaco。改 React.lazy：动态 import 只在真正渲染编辑器时
// 才发起；Suspense 给 Spin 占位（TaskDetailPage 同款 fallback）。
const GlueEditor = lazy(() => import('../GlueEditor'));
import { LAYOUT_TOKENS } from '../../theme/tokens';

const { Text } = Typography;
const TITLE_STYLE = { margin: '0 0 4px' } as const;

export default function TaskFormGlueSection({ glueTaskId, isEdit, createdTaskId, glueSource, glueLanguage, savedRuntime, onGlueDirtyChange }: {
  /** 创建成功后的新任务 id 或编辑态任务 id；null = 尚不可编辑脚本 */
  glueTaskId: string | null;
  isEdit: boolean;
  /** 仅创建态：刚创建成功时的成功提示 */
  createdTaskId: string | null;
  glueSource: string | undefined;
  glueLanguage: string | undefined;
  savedRuntime: string;
  /** GLUE-DIRTY-01：GlueEditor 有未保存改动时外抛，父级并入跳转/关闭守卫 */
  onGlueDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const nav = useNavigate();

  return (
    <div id="sec-glue" data-testid="section-glue" role="region" aria-label={t('taskForm.section.glue')} style={{ scrollMarginTop: LAYOUT_TOKENS.anchorScrollOffset }}>
      <Typography.Title level={5} style={TITLE_STYLE}>{t('taskForm.section.glueTitle')}</Typography.Title>
      {glueTaskId ? (
        <Card style={{ marginBottom: 20 }}>
          {!isEdit && createdTaskId && (
            <Alert
              type="success"
              showIcon
              title={t('taskForm.glue.createdTitle')}
              description={t('taskForm.glue.createdDesc')}
              style={{ marginBottom: 20 }}
            />
          )}
          <Suspense
            fallback={
              <div style={{ textAlign: 'center', padding: 48 }} data-testid="glue-editor-fallback">
                <Spin />
              </div>
            }
          >
            <GlueEditor
              taskId={glueTaskId}
              // P0-1：回填已有脚本与语言。漏传 → 编辑器空白 + 一次保存即清空
              // 用户代码（后端 updateGlue 无校验、空串照收，见审计报告 §P0-1）。
              initialSource={glueSource}
              initialLanguage={glueLanguage}
              taskRuntime={savedRuntime}
              onDirtyChange={onGlueDirtyChange}
            />
          </Suspense>
          <Divider />
          <Space>
            <Button type="primary" onClick={() => nav(`/tasks/${glueTaskId}`)}>{t('taskForm.glue.done')}</Button>
            {!isEdit && (
              <Button onClick={() => nav('/tasks')}>{t('taskForm.glue.skip')}</Button>
            )}
          </Space>
        </Card>
      ) : (
        <Card style={{ marginBottom: 20 }}>
          <Text type="secondary" data-testid="glue-locked-hint">
            {t('taskForm.glue.lockedHint')}
          </Text>
        </Card>
      )}
    </div>
  );
}
