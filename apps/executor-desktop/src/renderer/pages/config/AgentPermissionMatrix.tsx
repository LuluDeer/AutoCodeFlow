import React from 'react';
import Icon from '../../components/Icon';
import type { RendererLocale } from '../../i18n';
import { resolveAgentAxis, resolveEffectivePreset, type AgentMatrixAxis } from './agent-matrix';

type Translate = (key: string, ...args: (string | number | boolean)[]) => string;

interface AgentPermissionMatrixProps {
  form: Record<string, unknown>;
  savedForm: Record<string, unknown>;
  locale: RendererLocale;
  agentValueLabel: (value: unknown, fallback?: string) => string;
  t: Translate;
}

const MATRIX_AXES: ReadonlyArray<{
  axis: AgentMatrixAxis;
  formKey: string;
  labelKey: string;
}> = [
  { axis: 'codeExecution', formKey: 'agentCodeExecution', labelKey: 'cfg.agent.codeExecLabel' },
  { axis: 'hostAccess', formKey: 'agentHostAccess', labelKey: 'cfg.agent.hostAccessLabel' },
  { axis: 'taskExecution', formKey: 'agentTaskExecution', labelKey: 'cfg.agent.taskExecLabel' },
];

/**
 * 设置页 Agent 分区右栏「权限生效矩阵」：
 * 将未覆盖的细粒度轴按当前预设解析为真实生效档位（如 off / sandbox / none / deploy-only），
 * 不再全表只显示「（跟随预设）」。
 */
export default function AgentPermissionMatrix({
  form,
  savedForm,
  locale,
  agentValueLabel,
  t,
}: AgentPermissionMatrixProps) {
  const localPreset = resolveEffectivePreset(form.agentPermissionProfile);
  const savedPreset = resolveEffectivePreset(savedForm.agentPermissionProfile);
  const presetSuffix = locale === 'zh' ? t('cfg.agent.followPreset') : ` ${t('cfg.agent.followPreset')}`;

  return (
    <div className="cfgx-matrix">
      <div className="cfgx-aside-title">
        <Icon name="shield" className="icon-xs" /> {t('cfgx.agent.matrixTitle')}
      </div>
      <div className="cfgx-matrix-row">
        <span className="cfgx-matrix-cap">{t('cfg.agent.profileLabel')}</span>
        <span className="cfgx-matrix-values">
          <span data-raw-enum={localPreset}>
            <em>{t('cfgx.agent.localSetting')}</em>{agentValueLabel(localPreset, 'minimal')}
          </span>
          <span data-raw-enum={savedPreset}>
            <em>{t('cfgx.agent.effective')}</em>{agentValueLabel(savedPreset, 'minimal')}
          </span>
        </span>
      </div>
      {MATRIX_AXES.map(({ axis, formKey, labelKey }) => {
        const local = resolveAgentAxis(form.agentPermissionProfile, form[formKey], axis);
        const effective = resolveAgentAxis(savedForm.agentPermissionProfile, savedForm[formKey], axis);
        return (
          <div className="cfgx-matrix-row" key={axis}>
            <span className="cfgx-matrix-cap">{t(labelKey)}</span>
            <span className="cfgx-matrix-values">
              <span data-raw-enum={local.value}>
                <em>{t('cfgx.agent.localSetting')}</em>
                {agentValueLabel(local.value)}{local.inherited ? presetSuffix : ''}
              </span>
              <span data-raw-enum={effective.value}>
                <em>{t('cfgx.agent.effective')}</em>
                {agentValueLabel(effective.value)}
              </span>
            </span>
          </div>
        );
      })}
      <div className="cfgx-matrix-note">{t('cfgx.agent.matrixNote')}</div>
    </div>
  );
}
