/**
 * REFACTOR-TASKFORM-03 附：任务表单下拉**选项构建器**（原 TaskFormPage 模块级
 * 常量/函数原样迁出，供 TaskFormBasicSection 消费）。
 *
 * —— 可检索应用选择器（APP-SELECT-01）——————————————————————————————
 * zip 应用多起来后，「name 平铺 + 仅按名称过滤」的下拉不够用：搜不到描述/版本、
 * 看不出 runtime 是否与任务匹配、不知道应用整包是否就绪。两处应用 Select
 * （zip 必填载体 / 部署绑定）统一升级为富信息选项：
 *   · label = name + version + runtime Tag + updatedAt 相对时间（+ 描述截断）；
 *   · 过滤改走自定义 search 字符串（name+description+version）——antd 只对
 *     string label 提供默认过滤，ReactNode label 必须自带过滤字段；
 *   · title 显式回填 name：rc-select 只在 label 为字符串时才把 label 派生成
 *     原生 title 属性，ReactNode 下不回填 = 悬停提示消失；
 *   · 选中后选择框内只显示 name（optionLabelProp）——富信息只留在下拉里，
 *     不把表单行撑爆。
 * 状态语义来自后端 apps/admin-api application.service.ts（ApplicationStatus）：
 *   active    = 就绪（本地上传 / 上次 git 部署成功）——唯一「健康」态；
 *   deploying = git 部署进行中（带 gitRepo 创建即置此态，整包尚未产出）；
 *   failed    = 上次 git 部署失败（当前没有可用整包）。
 * zip 来源 = 执行器按 applicationId 下载应用整包，deploying/failed 都拿不到包，
 * 故 zip 分支禁用并显示原因；未知状态（未来枚举扩容）不臆造语义，保持可选。
 */
import { Tag, Typography } from 'antd';
// APP-SELECT-01：应用选项的 updatedAt 相对时间（跟随当前语言，测试环境 zh）。
import { formatRelativeTime } from '../../utils/timeFormat';
import type { AppOptionSource } from '../../hooks/useTaskFormReferenceData';
import type { CodeSource } from '../../pages/executor-mode';

const { Text } = Typography;

export const RUNTIME_OPTIONS = [
  { value: 'python', label: 'Python' },
  { value: 'node', label: 'Node.js' },
  { value: 'shell', label: 'Shell' },
];

/** zip 分支下不可选状态的展示配置（Tag 颜色对齐 ApplicationListPage 的 statusColors）。 */
const APP_STATUS_UNAVAILABLE: Record<string, { color: string; tagKey: string; reasonKey: string }> = {
  deploying: {
    color: 'blue',
    tagKey: 'taskForm.field.applicationId.statusTagDeploying',
    reasonKey: 'taskForm.field.applicationId.statusDeployingUnavailable',
  },
  failed: {
    color: 'red',
    tagKey: 'taskForm.field.applicationId.statusTagFailed',
    reasonKey: 'taskForm.field.applicationId.statusFailedUnavailable',
  },
};

/**
 * 构建单个应用选项。label 里的 name 独占一个 span：antd 选中回显走
 * optionLabelProp="name"（纯字符串），但若有用例/浮层需要精确匹配应用名，
 * 下拉项里的 name 文本节点也保持独立、不与版本/时间粘连。
 */
export const buildAppSelectOption = (
  a: AppOptionSource,
  t: (k: string, opts?: Record<string, unknown>) => string,
  opts: { /** zip 分支：按健康状态禁用 + runtime 与任务不一致时 Tag 变警示色 */ withHealth?: boolean; taskRuntime?: string },
) => {
  const unavailable = opts.withHealth ? APP_STATUS_UNAVAILABLE[a.status] : undefined;
  // runtime 不匹配预判：与提交侧 zipRuntimeMismatch Alert 同一判据口径
  // （两侧都有值才比），只是把「选完才报错」提前到「选择时就能看出」。
  const runtimeMismatch =
    !!opts.withHealth && !!a.runtime && !!opts.taskRuntime && a.runtime !== opts.taskRuntime;
  return {
    value: a.id,
    // 选中后选择框内只显示应用名（见 optionLabelProp）
    name: a.name,
    title: a.name,
    // 过滤字段：名称 + 描述 + 版本（预转小写，filterOption 里对输入侧同样小写化）
    search: `${a.name} ${a.description ?? ''} ${a.version ?? ''}`.toLowerCase(),
    disabled: !!unavailable,
    label: (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 500 }}>{a.name}</span>
        {a.version ? <Text type="secondary" style={{ fontSize: 12 }}>v{a.version}</Text> : null}
        {a.runtime ? (
          <Tag color={runtimeMismatch ? 'orange' : undefined} style={{ marginInlineEnd: 0 }}>
            {a.runtime}
          </Tag>
        ) : null}
        {unavailable ? (
          <Tag color={unavailable.color} style={{ marginInlineEnd: 0 }}>
            {t(unavailable.tagKey)}
          </Tag>
        ) : null}
        {a.updatedAt ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {formatRelativeTime(a.updatedAt, t)}
          </Text>
        ) : null}
        {a.description ? (
          <Text type="secondary" style={{ fontSize: 12, maxWidth: 320 }} ellipsis>
            {a.description}
          </Text>
        ) : null}
        {unavailable ? (
          <Text type="secondary" style={{ fontSize: 12 }}>{t(unavailable.reasonKey)}</Text>
        ) : null}
      </span>
    ),
  };
};

/** 应用下拉过滤：命中 search 字符串（名称/描述/版本），大小写不敏感。 */
export const appSelectFilterOption = (input: string, opt?: { search?: string } | null) =>
  (opt?.search ?? '').includes(input.trim().toLowerCase());

// python_task_multiversion（FR-18/AC-17b）：代码来源三选一 → 表单控件。
// 与 executor-mode.CodeSource 一一对应；desc 说明「该来源下代码从哪来」，
// 因为这三个选项对用户而言差别只在"执行器去哪拿代码"。
export const CODE_SOURCE_OPTIONS = (
  t: (k: string) => string,
): { value: CodeSource; label: string; desc: string }[] => [
  {
    value: 'git',
    label: t('taskForm.field.codeSource.git'),
    desc: t('taskForm.field.codeSource.gitDesc'),
  },
  {
    value: 'application_zip',
    label: t('taskForm.field.codeSource.applicationZip'),
    desc: t('taskForm.field.codeSource.applicationZipDesc'),
  },
  {
    value: 'glue',
    label: t('taskForm.field.codeSource.glue'),
    desc: t('taskForm.field.codeSource.glueDesc'),
  },
];
