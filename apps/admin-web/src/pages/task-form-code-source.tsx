/**
 * REFACTOR-TASKFORM-09：代码来源切换**损失预告守卫**（原 TaskFormPage
 * handleCodeSourceChange 原样迁出为独立 hook）。
 *
 * P0（UX-AUDIT-2026-09-21 §P0-5）：切换代码来源前告知将被清空的字段。
 *
 * `applyCodeSourcePayload` 会把不适用字段置为**显式 null**（必须如此：PATCH 是
 * Object.assign 语义，不发 null 会保留旧值、任务静默带两个冲突来源），而对应
 * 的输入框是条件渲染的——用户一改单选，gitRepo/gitBranch 的框立刻从 DOM 消失。
 * 两条叠加的后果：误点一下「Glue 脚本」，gitRepo/gitBranch 就没了，用户既看不到
 * 被清的内容、也收不到提示，切回来只能凭记忆重填。属误操作不可逆。
 *
 * 判据走纯函数 `codeSourceSwitchLosses`（复用 applyCodeSourcePayload，避免
 * 弹窗承诺与实际清空漂移）；**全空时不打扰**——新建任务来回点不该弹确认。
 *
 * codeSource 的持有方与消费方（提交链路）仍是 TaskFormPage——本 hook 只承接
 * 「读取当前来源 → 计算损失 → 确认后交回 applySwitch」的交互语义。
 */
import { Typography } from 'antd';
import type { FormInstance } from 'antd';
import { useTranslation } from 'react-i18next';
// MODAL-01：命令式 Modal.* 从 utils/modal 取（吃暗色主题 + i18n locale）。
import { Modal as confirmModal } from '../utils/modal';
import { codeSourceSwitchLosses, type CodeSource } from './executor-mode';

const { Text } = Typography;

export function useCodeSourceSwitchGuard(
  form: FormInstance,
  codeSource: CodeSource,
  applySwitch: (next: CodeSource) => void,
): (next: CodeSource) => void {
  const { t } = useTranslation();

  return (next: CodeSource) => {
    if (next === codeSource) return;
    const losses = codeSourceSwitchLosses(form.getFieldsValue(true), next, codeSource);
    if (losses.length === 0) {
      applySwitch(next);
      return;
    }
    // 只列真正有值的字段，点名到值——用户才能判断"这就是我要的那份配置"
    confirmModal.confirm({
      title: t('taskForm.codeSource.switch.title'),
      content: (
        <div>
          <p style={{ marginBottom: 8 }}>{t('taskForm.codeSource.switch.intro')}</p>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {losses.map((l) => (
              <li key={l.field}>
                {l.field === 'gitRepo'
                  ? t('taskForm.field.gitRepo')
                  : l.field === 'gitBranch'
                    ? t('taskForm.field.gitBranch')
                    : l.field === 'glueSource'
                      ? t('taskForm.section.glueTitle')
                      : t('taskForm.field.applicationId')}
                ：<Text code>{l.scriptLength != null ? t('taskForm.codeSource.switch.scriptLoss', { n: l.scriptLength }) : l.value}</Text>
              </li>
            ))}
          </ul>
        </div>
      ),
      okText: t('taskForm.codeSource.switch.ok'),
      cancelText: t('taskForm.codeSource.switch.cancel'),
      okButtonProps: { danger: true },
      onOk: () => applySwitch(next),
    });
  };
}
