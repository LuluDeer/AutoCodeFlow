/**
 * REFACTOR-TASKFORM-02：「Glue 脚本」分区（原 TaskFormPage 内联区块原样迁出）。
 *
 * 既有行为语义保持：创建态在提交成功前不渲染 GlueEditor（glueTaskId 为空时
 * 显示锁定提示）——taskId 来自 createdTaskId（创建成功后设置）或编辑态的
 * editId，由父页传入。
 */
import { Alert, Card, Button, Space, Typography, Divider } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import '../../i18n';
import GlueEditor from '../GlueEditor';
import { LAYOUT_TOKENS } from '../../theme/tokens';

const { Text } = Typography;
const TITLE_STYLE = { margin: '0 0 4px' } as const;

export default function TaskFormGlueSection({ glueTaskId, isEdit, createdTaskId, glueSource, glueLanguage, savedRuntime }: {
  /** 创建成功后的新任务 id 或编辑态任务 id；null = 尚不可编辑脚本 */
  glueTaskId: string | null;
  isEdit: boolean;
  /** 仅创建态：刚创建成功时的成功提示 */
  createdTaskId: string | null;
  glueSource: string | undefined;
  glueLanguage: string | undefined;
  savedRuntime: string;
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
          <GlueEditor
            taskId={glueTaskId}
            // P0-1：回填已有脚本与语言。漏传 → 编辑器空白 + 一次保存即清空
            // 用户代码（后端 updateGlue 无校验、空串照收，见审计报告 §P0-1）。
            initialSource={glueSource}
            initialLanguage={glueLanguage}
            taskRuntime={savedRuntime}
          />
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
