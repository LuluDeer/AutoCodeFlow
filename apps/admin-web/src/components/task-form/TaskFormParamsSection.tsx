/**
 * REFACTOR-TASKFORM-01：「参数与运行手册」分区（原 TaskFormPage 内联区块原样迁出）。
 *
 * Form.Item（params/secrets）依赖外层 <Form> 上下文——本组件必须渲染在
 * TaskFormPage 的 <Form> 内部（与原先内联形态一致），字段路径不变。
 * secretsExisting 走 prop 而不是表单值的语义见 TaskFormPage SEC-02 注释。
 */
import { Alert, Card, Form, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import '../../i18n';
import ParamsEditor from '../ParamsEditor';
import SecretsEditor from '../SecretsEditor';
import { LAYOUT_TOKENS } from '../../theme/tokens';

const TITLE_STYLE = { margin: '0 0 4px' } as const;

export default function TaskFormParamsSection({ secretsExisting }: {
  /** 服务端已有凭据（掩码映射）——展示源，不进表单值 */
  secretsExisting: Record<string, string> | null;
}) {
  const { t } = useTranslation();

  return (
    <div id="sec-params" data-testid="section-params" role="region" aria-label={t('taskForm.section.params')} style={{ scrollMarginTop: LAYOUT_TOKENS.anchorScrollOffset }}>
      <Typography.Title level={5} style={TITLE_STYLE}>{t('taskForm.section.params')}</Typography.Title>
      <Card style={{ marginBottom: 20 }}>
        <Alert
          type="info"
          showIcon
          title={t('taskForm.params.alertTitle')}
          description={t('taskForm.params.alertDesc')}
          style={{ marginBottom: 20 }}
        />
        <Form.Item name="params" label={t('taskForm.field.params')}>
          <ParamsEditor />
        </Form.Item>
        {/*
          SEC-02 续（生产故障）：凭据编辑器。此前控制台**完全没有**入口，
          而执行器报错文案却在教用户「请在平台 secrets 配置
          FEISHU_APP_ID」——一条在 UI 上无法执行的指令（生产实证：用户
          按提示配不出凭据，任务报「缺少飞书凭证」）。

          放在 params 之后：两者语义相邻（都是注入子进程的键值对），但
          注入名字不同——params 加 AUTOFLOW_ 前缀，secrets 用**原名**
          （第三方 SDK 认规范名），故必须在标签与提示里说清楚。
        */}
        <Form.Item
          name="secrets"
          label={t('taskForm.field.secrets')}
          extra={t('taskForm.field.secretsHelp')}
        >
          {/*
            existing = 服务端已有凭据（掩码映射）。刻意走 prop 而不是表单值：
            表单值只表达"本次要写什么"，已存在的键由后端按逐键合并语义保留
            （见 admin-api 的 mergeSecretsOnUpdate 与 applySecretsPayload）。
          */}
          <SecretsEditor existing={secretsExisting} />
        </Form.Item>
      </Card>
    </div>
  );
}
