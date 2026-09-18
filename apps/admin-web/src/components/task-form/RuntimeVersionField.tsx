/**
 * python_task_multiversion（FR-06 / AC-06a / AC-06b）：任务声明的 Python
 * 解释器版本选择器。
 *
 * 独立成组件的**唯一原因**：TaskFormPage 在 `loadingTask` 时提前 return
 * <PageSkeleton/>（编辑态首屏），若把 `Form.useWatch('runtime', form)` 放在
 * 页面体内就会违反 react-hooks/rules-of-hooks（hook 数随渲染分支变化）。
 * 本组件在**每次渲染都必然挂载**的 Card 内，hook 调用无条件，天然安全。
 *
 * 交互形态（组合框 = 可选 + 可手输）：
 *  - 下拉候选按 Tier 1 / Tier 2 / Tier 3 分组（CONTRACT §0.1 支持矩阵）；
 *  - 手输 `X.Y` 后按 Enter 或点浮层底部「使用输入的值」确认；
 *  - 非法输入（格式不符或超出 3.7~3.14）→ **就地清空并常驻红字**，
 *    绝不把脏值带进提交（NG-08：前端只是便利层，服务端权威）；
 *  - 选中 3.7 → 显著警示（Tag + Alert）：3.7 **无法在线下载**，必须由部署方
 *    离线预填解释器缓存卷；
 *  - allowClear / 清空 = 不声明版本 → 走宿主默认解释器（FR-10），提交侧发
 *    显式 null（见 executor-mode.applyRuntimeVersionPayload）。
 *
 * 只读性：仅 `runtime === 'python'` 时渲染（FR-06；node/shell 声明版本会被
 * 后端拒绝，NG-02）。runtime 由父级通过 form 实例共享。
 */
import { useState } from 'react';
import { Button, Divider, Form, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { InfoCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { FormInstance, SelectProps } from 'antd';
import {
  getRuntimeVersionConfig,
  normalizeRuntimeVersion,
  runtimeVersionIsOfflineTier,
  runtimeVersionOptions,
} from '../../pages/executor-mode';

const { Text } = Typography;

/** 3.7 警示标记的 testid（测试与读屏定位锚点） */
export const RUNTIME_VERSION_OFFLINE_TESTID = 'runtime-version-37-warning';
/** 非法输入红字的 testid */
export const RUNTIME_VERSION_ERROR_TESTID = 'runtime-version-error';
/** 选择器本体 testid */
export const RUNTIME_VERSION_SELECT_TESTID = 'runtime-version-select';
/** 非法红字的 DOM id（供 Select 的 aria-describedby 关联，读屏可得知字段错误态） */
const RUNTIME_VERSION_ERROR_MSG_ID = 'runtime-version-error-msg';

/** Tier → i18n 组名键 */
const TIER_GROUP_T_KEY: Record<1 | 2 | 3, string> = {
  1: 'taskForm.field.runtimeVersion.tier1',
  2: 'taskForm.field.runtimeVersion.tier2',
  3: 'taskForm.field.runtimeVersion.tier3',
};

/**
 * 下拉**叶子**候选的形态（`filterOption` 实际收到的就是它；分组节点只是它的
 * 一层包装）。从 antd 公开的 SelectProps 取，避免直接依赖传递依赖
 * @rc-component/select：
 *  - `options` 用分组形态（label + options 子数组），`filterOption` 用叶子形态，
 *    antd 的类型却把两者绑在同一个 OptionType 上——写死叶子形态后 `options`
 *    会因"与分组节点无公共属性"报错。用 antd 自己的 DefaultOptionType 同时兼容
 *    两种形态（其 `[name: string]: any` 索引签名接纳分组节点的额外键）。
 */
type RuntimeVersionFilterOption = NonNullable<SelectProps['options']>[number];

interface RuntimeVersionFieldProps {
  /** 页面级 form 实例（共享 store；本字段的值由本组件自持，不入字段树） */
  form: FormInstance;
  /** 当前选中的 主.次 版本；null = 不声明（宿主默认解释器） */
  value: string | null;
  /** 值变更回调（已归一；非法输入也会回调 null，由本组件负责报错） */
  onChange: (value: string | null) => void;
  /** 外部（编辑态加载）注入的初始非法值标记复位用 */
  disabled?: boolean;
}

export default function RuntimeVersionField({
  form,
  value,
  onChange,
  disabled,
}: RuntimeVersionFieldProps) {
  const { t } = useTranslation();
  // FR-06：仅 python 渲染。useWatch 必须在组件顶层无条件调用。
  const runtime = Form.useWatch('runtime', form);
  // 手输但未确认/非法的原文——用于常驻红字里回显"你输入了什么"
  const [typed, setTyped] = useState('');
  const [searchValue, setSearchValue] = useState('');

  if (runtime !== 'python') return null;

  // G-1：区间/在线下界取自可注入配置（默认即 3.7/3.14/3.8），后端下发后 UI 自动跟随。
  const { min: cfgMin, max: cfgMax, onlineMin: cfgOnlineMin } = getRuntimeVersionConfig();
  const options = runtimeVersionOptions();
  // 分组下拉：antd 的 grouped options 形态（label + options 子数组）
  const grouped = ([1, 2, 3] as const).map((tier) => ({
    label: t(TIER_GROUP_T_KEY[tier]),
    options: options
      .filter((o) => o.tier === tier)
      .map((o) => ({
        value: o.value,
        label: o.offlineOnly ? `${o.value} ⚠` : o.value,
        // 携带分层信息供 optionRender 渲染警示 Tag
        offlineOnly: o.offlineOnly,
      })),
  }));

  /** 手输确认：归一成功即采纳，失败则清空值 + 记录原文供红字回显 */
  const commitTyped = (raw: string) => {
    const normalized = normalizeRuntimeVersion(raw);
    setTyped(normalized === null ? raw.trim() : '');
    onChange(normalized);
    setSearchValue('');
  };

  const showError = typed.length > 0;
  const offlineSelected = runtimeVersionIsOfflineTier(value);

  return (
    <Form.Item
      label={t('taskForm.field.runtimeVersion')}
      tooltip={{
        title: t('taskForm.field.runtimeVersion.tooltip', {
          min: cfgMin,
          max: cfgMax,
        }),
        icon: <InfoCircleOutlined />,
      }}
      // 非法输入的红字由下方 Alert 常驻呈现（本字段不在字段树内，
      // 无法用 Form.Item 的 rules 校验，故手写等价反馈）。
      validateStatus={showError ? 'error' : undefined}
    >
      <Space orientation="vertical" style={{ width: '100%' }} size={4}>
        <Select
          data-testid={RUNTIME_VERSION_SELECT_TESTID}
          // O-3：本字段不挂 Form.Item 的 name（值由本组件自持），故 Form.Item 的
          // validateStatus 只渲染红框，不带 aria。这里显式把错误态与红字文案关联，
          // 读屏用户聚焦字段时能感知「当前为错误态 + 错误原因」。
          aria-invalid={showError || undefined}
          aria-describedby={showError ? RUNTIME_VERSION_ERROR_MSG_ID : undefined}
          value={value ?? undefined}
          placeholder={t('taskForm.field.runtimeVersion.placeholder', {
            min: cfgMin,
            max: cfgMax,
          })}
          allowClear
          disabled={disabled}
          options={grouped}
          // 组合框语义：可选可输。showSearch 用对象形态拿到 searchValue，
          // 供浮层底部「使用输入的值」按钮回显。
          showSearch={{
            searchValue,
            onSearch: setSearchValue,
            optionFilterProp: 'value',
            filterOption: (input: string, opt?: RuntimeVersionFilterOption) =>
              String(opt?.value ?? '').toLowerCase().includes(input.trim().toLowerCase()),
          }}
          // 手输任意值时不显示 "无匹配" 空态——浮层底部始终有确认入口
          notFoundContent={null}
          // 浮层底部追加"使用输入的值"：把纯手输（如 3.13 不在候选里也允许）
          // 变成一次显式确认；onMouseDown preventDefault 保证点击不先关浮层。
          popupRender={(menu) => (
            <>
              {menu}
              <Divider style={{ margin: '4px 0' }} />
              <Button
                type="text"
                block
                disabled={normalizeRuntimeVersion(searchValue) === null}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commitTyped(searchValue)}
                data-testid="runtime-version-use-typed"
                // O-3：可见文案已含版本号，aria-label 再补语义（确认操作），读屏更明确。
                aria-label={
                  searchValue.trim()
                    ? t('taskForm.field.runtimeVersion.useTypedAria', { value: searchValue.trim() })
                    : t('taskForm.field.runtimeVersion.typedHint')
                }
              >
                {searchValue.trim()
                  ? t('taskForm.field.runtimeVersion.useTyped', { value: searchValue.trim() })
                  : t('taskForm.field.runtimeVersion.typedHint')}
              </Button>
            </>
          )}
          onChange={(v: string | null | undefined) => {
            // 选中候选 → 一定合法；清空 → null（宿主默认解释器）
            setTyped('');
            setSearchValue('');
            onChange(normalizeRuntimeVersion(v));
          }}
          onInputKeyDown={(e) => {
            // Enter 确认手输值（antd 默认会尝试匹配候选项，这里显式接管）
            if (e.key === 'Enter' && searchValue.trim()) {
              e.preventDefault();
              commitTyped(searchValue);
            }
          }}
        />
        {/* AC-06b：3.7 需离线预填——可见警示 + 悬停详情 */}
        {offlineSelected && (
          <Tooltip title={t('taskForm.field.runtimeVersion.offlineWarningDetail')}>
            <Tag
              icon={<WarningOutlined />}
              color="warning"
              data-testid={RUNTIME_VERSION_OFFLINE_TESTID}
            >
              {t('taskForm.field.runtimeVersion.offlineWarning', {
                online: cfgOnlineMin,
              })}
            </Tag>
          </Tooltip>
        )}
        {showError && (
          <Text type="danger" id={RUNTIME_VERSION_ERROR_MSG_ID} data-testid={RUNTIME_VERSION_ERROR_TESTID}>
            {t('taskForm.field.runtimeVersion.invalid', {
              value: typed,
              min: cfgMin,
              max: cfgMax,
            })}
          </Text>
        )}
        {value === null && !showError && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('taskForm.field.runtimeVersion.hostDefault')}
          </Text>
        )}
      </Space>
    </Form.Item>
  );
}
