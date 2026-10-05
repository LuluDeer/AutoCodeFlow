/**
 * REFACTOR-TASKFORM-04：「触发与告警」分区（原 TaskFormPage 内联区块原样迁出）。
 *
 * 覆盖：触发方式单选 / blockStrategy / cron + timezone / fixed_rate / 触发预览
 * （TriggerPreview）/ 任务级维护窗口（FEAT-06 Form.List）/ 告警配置（AlarmConfig，
 * alarmEmail/alarmChannels 是任务级失败通知的唯一来源）/ 运行手册（FEAT-11）。
 *
 * Form.Item 依赖外层 <Form> 上下文——本组件必须渲染在 TaskFormPage 的 <Form>
 * 内部（与原先内联形态一致），字段路径不变。triggerType 是页面自持 state
 * （编辑态/模板回填时由页面 setState），经 props 受控下传控制 cron/fixed_rate
 * 条件渲染；cronExpression/fixedRate/timezone 三个 useWatch 订阅随之迁入本
 * 分区（仅 TriggerPreview 消费，页面不再重复订阅）。
 */
import { Form, Input, InputNumber, Radio, Button, Card, Divider, Select, Space, theme, Tooltip, Typography } from 'antd';
import type { FormInstance } from 'antd';
import { InfoCircleOutlined, ToolOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import '../../i18n';
// F-28（DEEP_REVIEW 0ef3bbe）：fixed_rate 输入框的分钟/秒换算纯逻辑层
import { fixedRateToMinutesLabel, parseFixedRateSeconds } from '../../pages/fixed-rate';
import { parseCronExpression } from '../../utils/trigger-preview';
import { MAINTENANCE_WINDOWS_MAX } from '../../pages/maintenance-windows';
import AlarmConfig from '../AlarmConfig';
import TriggerPreview from './TriggerPreview';
import { LAYOUT_TOKENS } from '../../theme/tokens';

const { Text } = Typography;

const TRIGGER_OPTIONS = (t: (k: string) => string) => [
  { value: 'manual', label: t('taskForm.trigger.manual'), desc: t('taskForm.trigger.manualDesc') },
  { value: 'cron', label: t('taskForm.trigger.cron'), desc: t('taskForm.trigger.cronDesc') },
  { value: 'fixed_rate', label: t('taskForm.trigger.fixedRate'), desc: t('taskForm.trigger.fixedRateDesc') },
];

/**
 * Cron 结构校验（前端即时反馈）：结构不可解析时在输入旁直接标红，不再等
 * 提交后的笼统 400。裸 `n/step`（如 `12/20`）**放行**——后端写边界会做等价
 * 规范化（POSIX n/step ≡ n-max/step，admin-api cron-normalize.util），提交
 * 时 handleSubmit 也前置同一规范化并 toast 告知实际存储形态，故这里无需
 * （也不应）拦截。
 * （admin-web 不引 node-cron，判定复用预览器 parseCronExpression。）
 * 主 cron 与维护窗口 start/end 三个字段共用。
 */
const cronGateValidator =
  (t: (k: string, opts?: Record<string, unknown>) => string) =>
  (_rule: unknown, value: string | undefined) => {
    const v = (value ?? '').trim();
    if (!v) return Promise.resolve(); // 空值交给 required 规则
    if (!parseCronExpression(v)) {
      return Promise.reject(new Error(t('taskForm.field.cron.invalid')));
    }
    return Promise.resolve();
  };

export default function TaskFormTriggerSection({
  form,
  triggerType,
  onOpenCronHelper,
}: {
  /** 外层 <Form> 实例（fixed_rate parser 需读当前值；useWatch 共享字段树） */
  form: FormInstance;
  /** 触发方式（页面自持 state，受控下传驱动 cron/fixed_rate 条件渲染） */
  triggerType: string;
  /** cron 助手按钮 → 页面级 CronHelper 弹窗 */
  onOpenCronHelper: () => void;
}) {
  const { t } = useTranslation();
  // UI-06 ③：触发方式/时区经 Form.useWatch 订阅供预览组件消费（保持 render
  // 同步且不整表单重渲）。均为无条件 hook 调用（本分区每次渲染必然挂载）。
  const cronExpression = Form.useWatch('cronExpression', form);
  const fixedRateWatch = Form.useWatch('fixedRate', form);
  const timezoneWatch = Form.useWatch('timezone', form);
  // 维护窗口标题旁的提示图标用主题色（原页面 theme.useToken() 同款）。
  const { token } = theme.useToken();

  const sectionTitleStyle = { margin: '0 0 4px' };

  return (
    <div id="sec-trigger" data-testid="section-trigger" role="region" aria-label={t('taskForm.section.trigger')} style={{ scrollMarginTop: LAYOUT_TOKENS.anchorScrollOffset }}>
      <Typography.Title level={5} style={sectionTitleStyle}>{t('taskForm.section.trigger')}</Typography.Title>
      <Card style={{ marginBottom: 20 }}>
        <Form.Item name="triggerType" label={t('taskForm.field.triggerType')}>
          <Radio.Group>
            <Space orientation="vertical">
              {TRIGGER_OPTIONS(t).map(o => (
                <Radio key={o.value} value={o.value}>
                  <Space>
                    <span style={{ fontWeight: 500 }}>{o.label}</span>
                    <Text type="secondary" style={{ fontSize: 12 }}>{o.desc}</Text>
                  </Space>
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        </Form.Item>

        {/* A4（第三轮审计）：上一轮触发未结束时，新触发的处置策略。
            以前只有后端默认 serial 生效，表单不暴露；三个取值语义差异
            大（排队/丢弃/覆盖），用户需要可见、可选。取值与后端
            task.entity.ts BlockStrategy / api/tasks.ts 类型逐一对齐。 */}
        <Form.Item
          name="blockStrategy"
          label={t('taskForm.field.blockStrategy')}
          extra={t('taskForm.field.blockStrategy.hint')}
        >
          <Select
            options={[
              { value: 'serial', label: t('taskForm.field.blockStrategy.serial') },
              { value: 'discard', label: t('taskForm.field.blockStrategy.discard') },
              { value: 'cover_early', label: t('taskForm.field.blockStrategy.coverEarly') },
            ]}
          />
        </Form.Item>

        {triggerType === 'cron' && (
          <Form.Item
            name="cronExpression"
            label={t('taskForm.field.cron')}
            rules={[
              { required: true, message: t('taskForm.field.cron.required') },
              { validator: cronGateValidator(t) },
            ]}
            extra={
              <Button type="link" size="small" onClick={onOpenCronHelper}>
                {t('taskForm.field.cron.helper')}
              </Button>
            }
          >
            <Input placeholder={t('taskForm.field.cron.placeholder')} style={{ fontFamily: 'monospace' }} />
          </Form.Item>
        )}

        {triggerType === 'cron' && (
          <Form.Item
            name="timezone"
            label={t('taskForm.field.timezone')}
            tooltip={{ title: t('taskForm.field.timezone.tooltip'), icon: <InfoCircleOutlined /> }}
          >
            <Input placeholder="Asia/Shanghai" />
          </Form.Item>
        )}

        {triggerType === 'fixed_rate' && (
          <Form.Item
            name="fixedRate"
            label={t('taskForm.field.fixedRate')}
            rules={[{ required: true, message: t('taskForm.field.fixedRate.required') }]}
          >
            <InputNumber<number>
              min={60}
              step={60}
              style={{ width: 200 }}
              formatter={v => v ? t('taskForm.field.fixedRate.minutes', { n: fixedRateToMinutesLabel(Number(v)) }) : ''}
              // F-28（DEEP_REVIEW 0ef3bbe）：原 parser 用 t('taskForm.field.fixedRate.minuteUnit')
              // 的**翻译文本**做 String.replace 反解数字——文案一变（如英文 "minutes"）或
              // 语序变化即解析成 NaN，属"解析依赖 i18n 文案"的坏味道。现改走
              // pages/fixed-rate.ts 的与语言无关数字抽取（纯函数，已单测）。
              //
              // 本轮审计修复：额外把**当前表单值**传给 parser。输入框以分钟呈现
              // 而表单值单位是秒，非 60 整数倍的值（90s/45s）向下取整后展示为
              // 「1 分钟」；仅 parser(text) 会把展示文本回读成 60s，用户聚焦后
              // 失焦（未改一个字符）就把 90s 静默改成 60s。传当前值后 parser 能
              // 判定"是否跨分钟"——未改则原样保留精确秒值。
              parser={(v) => parseFixedRateSeconds(v, form.getFieldValue('fixedRate'))}
              placeholder={t('taskForm.field.fixedRate.placeholder')}
            />
          </Form.Item>
        )}

        {/* UI-06 ②：触发预览（cron/fixed_rate 未来 5 次，timezone 感知；
            manual 不渲染）。纯展示，不影响校验/提交。 */}
        {(triggerType === 'cron' || triggerType === 'fixed_rate') && (
          <TriggerPreview
            triggerType={triggerType}
            cronExpression={cronExpression}
            fixedRate={fixedRateWatch}
            timezone={timezoneWatch}
          />
        )}

        {/* FEAT-06: 任务级维护窗口——发布冻结期跳过计划触发（手动触发不受限） */}
        <Divider style={{ margin: '16px 0' }} />
        <div style={{ marginBottom: 8 }}>
          <Space size={4}>
            <ToolOutlined />
            <Typography.Text strong>{t('taskForm.window.title')}</Typography.Text>
            <Tooltip title={t('taskForm.window.tooltip')}>
              <InfoCircleOutlined style={{ color: token.colorPrimary }} />
            </Tooltip>
          </Space>
        </div>
        <Form.List name="maintenanceWindows">
          {(fields, { add, remove }) => (
            <>
              {fields.map(field => (
                // A4（第三轮审计）：固定 200px 的 start/end 双输入并排在
                // 375px 视口横向溢出——改 flex wrap 布局：窄屏按 flex-basis
                // 折行、条目可收缩（minWidth 0 + Input width 100%），
                // 宽屏仍一行三列，字段与校验语义不变。
                <div
                  key={field.key}
                  style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}
                >
                  <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                    <Form.Item
                      name={[field.name, 'start']}
                      noStyle
                      rules={[
                        { required: true, message: t('taskForm.window.startRequired') },
                        { pattern: /^(\*|([0-5]?\d))(\/(\d+))? (\*|([01]?\d|2[0-3]))(\/(\d+))? (\*|([012]?\d|3[01]))(\/(\d+))? (\*|(1[0-2]|0?[1-9]))(\/(\d+))? (\*|[0-7])(\/(\d+))?$/, message: t('taskForm.window.cronFormat') },
                        { validator: cronGateValidator(t) },
                      ]}
                    >
                      <Input placeholder={t('taskForm.window.startPlaceholder')} style={{ width: '100%', fontFamily: 'monospace' }} />
                    </Form.Item>
                  </div>
                  <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                    <Form.Item
                      name={[field.name, 'end']}
                      noStyle
                      rules={[
                        { required: true, message: t('taskForm.window.endRequired') },
                        { pattern: /^(\*|([0-5]?\d))(\/(\d+))? (\*|([01]?\d|2[0-3]))(\/(\d+))? (\*|([012]?\d|3[01]))(\/(\d+))? (\*|(1[0-2]|0?[1-9]))(\/(\d+))? (\*|[0-7])(\/(\d+))?$/, message: t('taskForm.window.cronFormat') },
                        { validator: cronGateValidator(t) },
                      ]}
                    >
                      <Input placeholder={t('taskForm.window.endPlaceholder')} style={{ width: '100%', fontFamily: 'monospace' }} />
                    </Form.Item>
                  </div>
                  <div style={{ flex: '1 1 140px', minWidth: 0 }}>
                    <Form.Item name={[field.name, 'description']} noStyle>
                      <Input placeholder={t('taskForm.window.descPlaceholder')} style={{ width: '100%' }} />
                    </Form.Item>
                  </div>
                  <Button
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label={t('taskForm.window.deleteAria', { n: field.name + 1 })}
                    onClick={() => remove(field.name)}
                  />
                </div>
              ))}
              <Form.Item style={{ marginBottom: 0 }}>
                <Button
                  type="dashed"
                  icon={<PlusOutlined />}
                  onClick={() => add()}
                  disabled={fields.length >= MAINTENANCE_WINDOWS_MAX}
                >
                  {t('taskForm.window.add')}（{fields.length}/{MAINTENANCE_WINDOWS_MAX}）
                </Button>
              </Form.Item>
            </>
          )}
        </Form.List>

        <Divider style={{ margin: '20px 0 16px' }} />
        <div style={{ marginBottom: 8 }}>
          <Typography.Text strong>{t('taskForm.alarm.title')}</Typography.Text>
        </div>
        <AlarmConfig />

        <Divider style={{ margin: '20px 0 16px' }} />
        <div style={{ marginBottom: 8 }}>
          <Typography.Text strong>{t('taskForm.runbook.title')}</Typography.Text>
        </div>
        <Form.Item
          name="runbook"
          label={t('taskForm.runbook.label')}
          tooltip={{ title: t('taskForm.runbook.tooltip'), icon: <InfoCircleOutlined /> }}
        >
          <Input.TextArea
            rows={6}
            placeholder={t('taskForm.runbook.placeholder')}
          />
        </Form.Item>
      </Card>
    </div>
  );
}
