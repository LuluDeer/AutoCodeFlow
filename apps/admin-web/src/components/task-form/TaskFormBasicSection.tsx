/**
 * REFACTOR-TASKFORM-03：「基本配置」分区（原 TaskFormPage 内联区块原样迁出）。
 *
 * 覆盖：任务名/描述/归属项目/runtime/入口文件/Python 版本声明（RuntimeVersionField）
 * /依赖声明，以及 python_task_multiversion（FR-18）的**代码来源三通道**——
 * codeSource 单选 + git 来源（gitRepo/gitBranch）+ application_zip 来源（必填
 * 应用载体 + runtime 一致性预判）+ glue 来源提示 + 非 zip 来源的部署绑定入口。
 *
 * Form.Item 依赖外层 <Form> 上下文——本组件必须渲染在 TaskFormPage 的 <Form>
 * 内部（与原先内联形态一致），字段路径不变。自持 state（codeSource /
 * runtimeVersion）语义见 TaskFormPage：它们刻意不在表单字段树里，经 props
 * 受控下传（onCodeSourceChange 内含切换前损失确认弹窗，判定与提交路径同源）。
 *
 * APP-SELECT-01：应用选择器的富信息选项构建（buildAppSelectOption）随之迁出——
 * 它只被本分区的两处 Select 使用；`?applicationId=` 的加载语义在
 * useTaskFormReferenceData（数据源）+ TaskFormPage（codeSource 同步）。
 */
import { useMemo } from 'react';
import { Alert, Card, Form, Input, Radio, Select, Space, Spin, Typography } from 'antd';
import type { FormInstance } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import '../../i18n';
import { LAYOUT_TOKENS } from '../../theme/tokens';
import RuntimeVersionField from './RuntimeVersionField';
// APP-SELECT-01：应用/代码来源选项构建器（原 TaskFormPage 模块级常量/函数原样
// 迁出至 task-form-app-options，本分区是唯一消费方）。
import {
  appSelectFilterOption,
  buildAppSelectOption,
  CODE_SOURCE_OPTIONS,
  RUNTIME_OPTIONS,
} from './task-form-app-options';
import {
  deriveRuntimeMismatch,
  type CodeSource,
  type InterpreterFleetAdvisory,
} from '../../pages/executor-mode';
import type { AppOptionSource } from '../../hooks/useTaskFormReferenceData';

const { Text } = Typography;

export default function TaskFormBasicSection({
  form,
  isEdit,
  codeSource,
  onCodeSourceChange,
  runtimeVersion,
  onRuntimeVersionChange,
  apps,
  appsLoading,
  projectOptions,
  interpreterFleet,
}: {
  /** 外层 <Form> 实例（RuntimeVersionField 与 useWatch 共享同一字段树） */
  form: FormInstance;
  isEdit: boolean;
  /** 代码来源（自持 state，刻意不入表单字段树——语义见 TaskFormPage 头注） */
  codeSource: CodeSource;
  /** 切换来源（内含切换前损失确认弹窗，判定与提交路径同源） */
  onCodeSourceChange: (next: CodeSource) => void;
  /** 声明的 Python 主.次版本（自持 state，同上） */
  runtimeVersion: string | null;
  onRuntimeVersionChange: (v: string | null) => void;
  /** 应用候选（useTaskFormReferenceData 加载） */
  apps: AppOptionSource[];
  appsLoading: boolean;
  /** 归属项目候选（TASK-PROJ-01，含 i18n 后端不回传时的空态） */
  projectOptions: { value: string; label: string }[];
  /** P2-4：舰队能力咨询结论（interpreterFleetAdvisory，页面级计算后下传） */
  interpreterFleet: InterpreterFleetAdvisory;
}) {
  const { t } = useTranslation();
  // python_task_multiversion：zip 来源的运行时一致性提示需要实时读取两处值——
  // runtime 来自字段树（useWatch），applicationId 也走 useWatch 以便在**选中的
  // 应用**里查 runtime。二者都是无条件 hook 调用（本分区每次渲染必然挂载）。
  const runtimeWatch = Form.useWatch('runtime', form);
  const applicationIdWatch = Form.useWatch('applicationId', form);

  /**
   * python_task_multiversion（AC-19a/FR-19）：zip 来源的 runtime 一致性。
   * 只在 application_zip 来源下判定——其余来源下 applicationId 可能只是**部署
   * 绑定**（部署清单自动注册的任务就是 applicationId + glueSource 并存，后端
   * NFR-05 明确放行），对绑定关系报"运行时不一致"是纯粹的误报噪声。
   * 应用无 runtime / 尚未选应用 / 列表未加载 → deriveRuntimeMismatch 返回
   * null（不判定），交给服务端权威校验。
   */
  const zipRuntimeMismatch = useMemo(() => {
    if (codeSource !== 'application_zip') return null;
    const app = apps.find((a) => a.id === applicationIdWatch);
    if (!app) return null;
    return deriveRuntimeMismatch(runtimeWatch, app.runtime);
  }, [codeSource, apps, applicationIdWatch, runtimeWatch]);

  // APP-SELECT-01：两处应用选择器的富信息选项。zip 分支带健康语义（不可选状态
  // 禁用 + runtime 不匹配 Tag 变色），部署绑定分支不带——绑定关系与代码来源正交
  // （deploying/failed 的应用同样存在合法的部署绑定），不在此扩大禁用面。
  const zipAppOptions = useMemo(
    () => apps.map((a) => buildAppSelectOption(a, t, { withHealth: true, taskRuntime: runtimeWatch })),
    [apps, t, runtimeWatch],
  );
  const bindAppOptions = useMemo(
    () => apps.map((a) => buildAppSelectOption(a, t, { withHealth: false })),
    [apps, t],
  );

  /**
   * APP-SELECT-01：应用下拉空态三分支。区分「没有应用」与「搜索无命中」——
   * 两者用户要做的动作完全不同（去创建应用 vs 改关键词），混用一个
   * "No data" 会把新用户卡死在空表单前。
   */
  const renderAppSelectNotFound = () => {
    if (appsLoading) return <Spin size="small" />;
    if (apps.length === 0) {
      return (
        <div style={{ padding: '8px 12px', maxWidth: 320 }} data-testid="app-select-empty-guide">
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
            {t('taskForm.field.applicationId.emptyHint')}
          </Typography.Paragraph>
          <Link to="/applications" style={{ fontSize: 12 }}>
            {t('taskForm.field.applicationId.goManage')}
          </Link>
        </div>
      );
    }
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', padding: '8px 12px' }}>
        {t('taskForm.field.applicationId.noMatch')}
      </Typography.Text>
    );
  };

  const sectionTitleStyle = { margin: '0 0 4px' };

  return (
    <div id="sec-basic" data-testid="section-basic" role="region" aria-label={t('taskForm.section.basic')} style={{ scrollMarginTop: LAYOUT_TOKENS.anchorScrollOffset }}>
      <Typography.Title level={5} style={sectionTitleStyle}>{t('taskForm.section.basic')}</Typography.Title>
      <Card style={{ marginBottom: 20 }}>
        <Form.Item
          name="name"
          label={t('taskForm.field.name')}
          rules={[
            { required: true, message: t('taskForm.field.name.required') },
            // 字符白名单只在**新建**时校验：编辑态名字是 disabled 的不可变
            // 标识（不进 update 载荷），存量任务名若含非 ASCII 字符，对
            // 禁用字段套白名单会把每一次编辑保存都拦死，用户却无从修复
            // （同款先例：ApplicationListPage，1a4d3758）。
            ...(!isEdit
              ? [{ pattern: /^[a-zA-Z0-9_-]+$/, message: t('taskForm.field.name.pattern') }]
              : []),
          ]}
          tooltip={{ title: isEdit ? t('taskForm.field.name.tooltipEdit') : t('taskForm.field.name.tooltip'), icon: <InfoCircleOutlined /> }}
        >
          <Input placeholder="daily-report" disabled={isEdit} />
        </Form.Item>

        <Form.Item name="description" label={t('taskForm.field.description.optional')}>
          <Input placeholder={t('taskForm.field.description.placeholder')} />
        </Form.Item>

        {/* TASK-PROJ-01：归属项目。
            此前 tasks.projectId 无任何写入入口（迁移 1790000000008 的注释
            即写明「新建任务在 DTO 未接 projectId 前一律落 NULL」），导致
            「项目隔离」对所有新任务都塌缩到默认项目视图、形同虚设。
            不选 = 未分配（归默认项目视图），与既有行为一致。
            后端仅 ADMIN 或该项目的 editor/admin 可设置，故非管理员看到
            的选项受限（后端仍会兜底校验）。 */}
        <Form.Item
          name="projectId"
          label={t('taskForm.field.projectId')}
          tooltip={{ title: t('taskForm.field.projectId.tooltip'), icon: <InfoCircleOutlined /> }}
        >
          <Select
            allowClear
            placeholder={t('taskForm.field.projectId.placeholder')}
            options={projectOptions}
            data-testid="task-project-select"
          />
        </Form.Item>

        <Form.Item
          name="runtime"
          label={t('taskForm.field.runtime')}
          rules={[{ required: true, message: t('taskForm.field.runtime.required') }]}
          tooltip={{ title: t('taskForm.field.runtime.tooltip'), icon: <InfoCircleOutlined /> }}
        >
          <Radio.Group optionType="button" buttonStyle="solid">
            {RUNTIME_OPTIONS.map(o => (
              <Radio.Button key={o.value} value={o.value}>{o.label}</Radio.Button>
            ))}
          </Radio.Group>
        </Form.Item>

        <Form.Item
          name="entrypoint"
          label={t('taskForm.field.entrypoint')}
          rules={[{ required: true, message: t('taskForm.field.entrypoint.required') }]}
          tooltip={{ title: t('taskForm.field.entrypoint.tooltip'), icon: <InfoCircleOutlined /> }}
        >
          <Input placeholder="tasks/main.py" />
        </Form.Item>

        {/* python_task_multiversion（FR-06/AC-06a/AC-06b）：Python 版本声明。
            RuntimeVersionField 内部以 Form.useWatch('runtime') 自我门控，
            非 python 时返回 null——确保 node/shell 任务不会声明版本
            （后端 NG-02 会拒绝），同时 hook 调用保持无条件。 */}
        <RuntimeVersionField
          form={form}
          value={runtimeVersion}
          onChange={onRuntimeVersionChange}
        />

        {/* P2-4：舰队能力咨询（非阻断，见 interpreterFleetAdvisory 头注）。
            只在 python + 已声明版本 + 在线舰队无一台满足时出现。 */}
        {runtimeWatch === 'python' && interpreterFleet === 'unsatisfied' && (
          <Alert
            type="warning"
            showIcon
            data-testid="runtime-version-capability-advisory"
            style={{ marginBottom: 16 }}
            title={t('taskForm.field.runtimeVersion.capabilityAdvisoryTitle', {
              version: runtimeVersion ?? '-',
            })}
            description={t('taskForm.field.runtimeVersion.capabilityAdvisoryDesc')}
          />
        )}

        {/* W-21: 依赖声明。python 任务由 executor-python 装进 per-task uv
            venv，node 任务由 executor-node 安装；glue 脚本任务不生效。 */}
        <Form.Item
          name="requirements"
          label={t('taskForm.field.requirements')}
          tooltip={{
            title:
              t('taskForm.field.requirements.tooltip'),
            icon: <InfoCircleOutlined />,
          }}
        >
          <Select
            mode="tags"
            placeholder={t('taskForm.field.requirements.placeholder')}
            open={false}
            suffixIcon={null}
            tokenSeparators={[]}
          />
        </Form.Item>

        {/* python_task_multiversion（FR-18/AC-17b）：代码来源三选一。
            选谁决定下面显示哪些输入；提交侧由 applyCodeSourcePayload 把
            不适用字段统一发**显式 null**（PATCH 是 Object.assign 语义，
            省略字段会保留旧值 → 任务静默带两个冲突来源）。 */}
        <Form.Item
          label={t('taskForm.field.codeSource')}
          required
          tooltip={{ title: t('taskForm.field.codeSource.tooltip'), icon: <InfoCircleOutlined /> }}
        >
          <Radio.Group
            value={codeSource}
            onChange={(e) => onCodeSourceChange(e.target.value as CodeSource)}
            data-testid="code-source-select"
          >
            <Space orientation="vertical" style={{ width: '100%' }}>
              {CODE_SOURCE_OPTIONS(t).map((o) => (
                <Radio key={o.value} value={o.value} data-testid={`code-source-${o.value}`}>
                  <Space>
                    <span style={{ fontWeight: 500 }}>{o.label}</span>
                    <Text type="secondary" style={{ fontSize: 12 }}>{o.desc}</Text>
                  </Space>
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        </Form.Item>

        {/* git 来源：仓库地址 + 分支。两者都可留空——存量任务与部署清单
            自动注册的任务都没有 gitRepo，NFR-05 要求零破坏（后端只在
            codeSource='git' 显式声明时才强制其非空，而声明与否由
            applyCodeSourcePayload 的"自证"规则决定）。 */}
        {codeSource === 'git' && (
          <>
            {/* A8（第二轮审计）：凭据边界声明——派发链只支持匿名可达仓库
                （assertSafeGitRepoUrl 校验 https?://|git@|ssh:// 且执行器
                侧无凭据注入通道），私有仓库凭据不在平台管理范围内，先在
                表单里讲清楚，避免"任务建成了、派发才 401"的错位预期。 */}
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
              {t('taskForm.field.gitRepo.credentialHint')}
            </Typography.Paragraph>
            <Form.Item
              name="gitRepo"
              label={t('taskForm.field.gitRepo')}
              tooltip={{ title: t('taskForm.field.gitRepo.tooltip'), icon: <InfoCircleOutlined /> }}
            >
              <Input placeholder={t('taskForm.field.gitRepo.placeholder')} />
            </Form.Item>
            <Form.Item name="gitBranch" label={t('taskForm.field.gitBranch')}>
              <Input placeholder={t('taskForm.field.gitBranch.placeholder')} />
            </Form.Item>
          </>
        )}

        {/* application_zip 来源：applicationId 在此是**代码来源载体**（必填）。
            与下面 glue 分支的同一控件共用 name="applicationId"——两条分支
            互斥渲染，不会出现两个同名控件并存。 */}
        {codeSource === 'application_zip' && (
          <>
            {/* APP-SELECT-01：可检索应用选择器。计数放 extra——「共 N 个应用」
                让用户在应用多到需要搜索前就知道候选规模。 */}
            <Form.Item
              name="applicationId"
              label={t('taskForm.field.applicationId.zipRequired')}
              required
              rules={[{ required: true, message: t('taskForm.field.codeSource.applicationRequired') }]}
              tooltip={{ title: t('taskForm.field.applicationId.zipTooltip'), icon: <InfoCircleOutlined /> }}
              extra={t('taskForm.field.applicationId.zipAppCount', { n: apps.length })}
            >
              <Select
                placeholder={t('taskForm.field.applicationId.zipPlaceholder')}
                showSearch
                loading={appsLoading}
                optionLabelProp="name"
                options={zipAppOptions}
                filterOption={appSelectFilterOption}
                notFoundContent={renderAppSelectNotFound()}
              />
            </Form.Item>
            {/* AC-19a：应用 runtime 必须与任务 runtime 一致。只在两侧都有
                值时才判定（deriveRuntimeMismatch 对缺失返回 null），避免
                应用列表未就绪/应用无 runtime 时误报。 */}
            {zipRuntimeMismatch && (
              <Alert
                type="error"
                showIcon
                data-testid="code-source-runtime-mismatch"
                title={t('taskForm.field.codeSource.runtimeMismatch', {
                  task: runtimeWatch ?? '-',
                  app: apps.find(a => a.id === applicationIdWatch)?.runtime ?? '-',
                })}
                style={{ marginBottom: 16 }}
              />
            )}
          </>
        )}

        {/* glue 来源：本表单没有脚本输入框（GlueEditor 在独立区块写
            glueSource 并同时声明 codeSource='glue'）。此处只说明去哪编辑，
            避免用户以为"选了 glue 却没地方写脚本"。 */}
        {codeSource === 'glue' && (
          <Alert
            type="info"
            showIcon
            data-testid="code-source-glue-hint"
            title={t('taskForm.field.codeSource.glueHint')}
            style={{ marginBottom: 16 }}
          />
        )}

        {/* 部署绑定（非 zip 来源）：applicationId 在 git/glue 来源下仍有
            意义——它是「任务 ↔ 应用」的部署绑定关系，与代码来源正交
            （部署清单自动注册的任务即 applicationId + glueSource 并存，
            后端 NFR-05 明确放行）。故此处必须保留一个入口，否则用户在
            git 来源下根本无法查看/修改该绑定。 */}
        {codeSource !== 'application_zip' && (
          <Form.Item
            name="applicationId"
            label={t('taskForm.field.applicationId')}
            tooltip={{ title: t('taskForm.field.applicationId.tooltip'), icon: <InfoCircleOutlined /> }}
            extra={
              applicationIdWatch ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('taskForm.field.applicationId.boundHint')}
                </Text>
              ) : undefined
            }
          >
            {/* APP-SELECT-01：绑定分支同为富信息选项，但不带健康禁用——
                见上方 zipAppOptions/bindAppOptions 的注释。 */}
            <Select
              placeholder={t('taskForm.field.applicationId.placeholder')}
              allowClear
              showSearch
              loading={appsLoading}
              optionLabelProp="name"
              options={bindAppOptions}
              filterOption={appSelectFilterOption}
              notFoundContent={renderAppSelectNotFound()}
            />
          </Form.Item>
        )}
      </Card>
    </div>
  );
}
