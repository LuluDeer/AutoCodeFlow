/**
 * P1-15（UX-AUDIT-2026-09-21）：部署运行模式字段 + 说明，两处复用。
 *
 * 背景：AppDeploymentPage（详情页部署弹窗）与 ApplicationListPage（列表页快速部署）
 * 各自内联了一份 runMode 单选；详情页有三个模式的说明文案，列表页那个更常用的
 * 快速部署入口却**没有任何说明**——用户不知道单次/常驻/定时的区别。
 *
 * 本组件把「runMode 字段 + 模式说明 + 常驻时的启动命令」抽成一份，两处复用：
 *   · buttonStyle="solid"  → 详情页（按钮式）
 *   · buttonStyle="outline" → 列表页（普通单选）
 * 说明文案统一走 appDeploy.mode.* 既有 i18n 键，不再复制一份。
 */
import { Form, Radio, Input, Alert } from 'antd';
import { useTranslation } from 'react-i18next';

export default function DeployModeFields({
  buttonStyle = 'solid',
  showStartCommand = true,
}: {
  buttonStyle?: 'solid' | 'outline';
  showStartCommand?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Form.Item
        name="runMode"
        label={t('appDeploy.field.runMode')}
        initialValue="once"
        extra={t('appDeploy.mode.hint')}
      >
        <Radio.Group buttonStyle={buttonStyle === 'solid' ? 'solid' : undefined}>
          <Radio.Button value="once">{t('appDeploy.mode.once')}</Radio.Button>
          <Radio.Button value="daemon">{t('appDeploy.mode.daemon')}</Radio.Button>
          <Radio.Button value="scheduled">{t('appDeploy.mode.scheduled')}</Radio.Button>
        </Radio.Group>
      </Form.Item>
      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.runMode !== cur.runMode}>
        {({ getFieldValue }) => {
          const mode = getFieldValue('runMode');
          return (
            <>
              {mode === 'daemon' && (
                <>
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 12 }}
                    title={t('appDeploy.mode.hintDaemon')}
                  />
                  {showStartCommand && (
                    <Form.Item
                      name="startCommand"
                      label={t('appDeploy.field.startCommand')}
                      tooltip={t('appDeploy.field.startCommandTooltip')}
                    >
                      <Input placeholder="node dist/server.js" />
                    </Form.Item>
                  )}
                </>
              )}
              {mode === 'scheduled' && (
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 12 }}
                  title={t('appDeploy.mode.hintScheduled')}
                />
              )}
            </>
          );
        }}
      </Form.Item>
    </>
  );
}
