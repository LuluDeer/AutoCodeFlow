import { useEffect, useRef, useState } from 'react';
import { Card,
  Row,
  Col,
  Typography,
  Tag,
  Space,
  Button,
  Empty,
  Popconfirm,
  Tooltip,
  Modal,
  Form,
  Input,
  theme } from 'antd';
import { message } from '../utils/toast';
import {
  CopyOutlined, DeleteOutlined, FileTextOutlined,
  ApiOutlined, FieldTimeOutlined, CodeOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { taskTemplatesApi, TaskTemplate } from '../api/task-templates';
import { queryKeys, useTaskTemplates } from '../api/queries';
import { showApiError } from '../utils/error';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

const { Text, Paragraph } = Typography;

type TFn = (k: string, options?: Record<string, unknown>) => string;

const TRIGGER_LABEL = (t: TFn): Record<string, string> => ({
  manual: t('templates.trigger.manual'),
  cron: t('templates.trigger.cron'),
  fixed_rate: t('templates.trigger.fixedRate'),
  api: t('templates.trigger.api'),
});
const CATEGORY_COLOR: Record<string, string> = {
  备份: 'blue', 巡检: 'green', 同步: 'purple', 清理: 'orange', 通知: 'cyan',
};

/**
 * UX-10（本轮体验审查）：模板分类的展示标签与配色。
 *
 * 缺陷：`category` 在 admin-api 里是自由文本 `varchar(32)`
 * （task-template.entity.ts），官方种子值写死为中文（task-template.constants.ts
 * 的「备份/巡检/同步/清理/通知」）。前端直接 `{tpl.category}` 渲染，于是：
 *   · **英文界面下分类标签仍是中文**——同一张卡片上的触发方式已走 t() 显示
 *     "Cron Schedule"，分类却是"备份"，中英混排；
 *   · 配色表以**中文显示名**为键，一旦有人把分类改成英文/本地化文案，配色
 *     静默退回 default 灰——即"改个文案就掉色"，键与语义错位。
 *
 * 修法：分类 → i18n key 的映射表（键仍是后端实际存的中文种子值，因为那是
 * 数据契约，不能前端擅自改），渲染时过 t()，英文界面即显示 Backup 等。
 *
 * 未知分类回退**原始值**（不显示"未知"）：分类是用户自建模板时自由填写的，
 * 露出原文才可诊断；配色回退 default 灰。
 */
const CATEGORY_T_KEY: Record<string, string> = {
  备份: 'templates.category.backup',
  巡检: 'templates.category.inspection',
  同步: 'templates.category.sync',
  清理: 'templates.category.cleanup',
  通知: 'templates.category.notify',
};

/** 分类展示文本：已知分类走 i18n，未知分类回退原始值。 */
function categoryLabel(category: string | null | undefined, t: TFn): string {
  if (!category) return '';
  const key = CATEGORY_T_KEY[category];
  return key ? t(key) : category;
}

/** 与 admin-api `TASK_NAME_MAX_LENGTH` 对齐（DB varchar(255)，按**码点**计）。 */
const TASK_NAME_MAX_LENGTH = 255;

/**
 * 控制字符（C0 + DEL + 格式字符）。与后端 `IsTaskName` 的判据同源：
 * 任务名会进日志行/通知标题/导出文件名，换行等控制字符会破坏这些下游结构。
 */
const CONTROL_CHARS_RE = /[\p{Cc}\p{Cf}]/gu;

/** 本地时间戳 `yyyyMMdd-HHmmss`（用本地时区，精确到秒，降低连续创建撞名的概率）。 */
function localStamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * 「使用模板」弹窗的默认任务名：`<模板名>-yyyyMMdd-HHmmss`。
 *
 * 必须**开箱即可提交**，所以先在本地消掉后端 `IsTaskName` 会拒绝的形态：
 *   · 模板名里的控制字符 → 空格（历史自定义模板可能带换行）；
 *   · 首尾空白 → trim（`" 备份 "` 与 `"备份"` 在库里是两行，会撞唯一索引）；
 *   · 超长 → 按码点截断，给时间后缀留位置（`String.length` 数 UTF-16 码元，
 *     emoji 会多算一倍，故用 Array.from 计码点）；
 *   · 清空后为空 → 回退 `task`，保证默认值永远非空。
 */
function defaultTaskName(templateName: string, now: Date = new Date()): string {
  const suffix = `-${localStamp(now)}`;
  const base = templateName.replace(CONTROL_CHARS_RE, ' ').trim() || 'task';
  const room = Math.max(TASK_NAME_MAX_LENGTH - Array.from(suffix).length, 1);
  const head = Array.from(base).slice(0, room).join('').trim() || 'task';
  return `${head}${suffix}`;
}

/** 把模板 config 摘要成一行人类可读描述。 */
function configSummary(config: Record<string, unknown>, t: TFn): string {
  const bits: string[] = [];
  const trigger = config.triggerType as string | undefined;
  if (trigger) {
    let label = TRIGGER_LABEL(t)[trigger] || trigger;
    if (trigger === 'cron' && config.cronExpression) label += t('templates.config.cron', { expr: String(config.cronExpression) });
    if (trigger === 'fixed_rate' && config.fixedRate) label += t('templates.config.fixedRate', { rate: String(config.fixedRate) });
    bits.push(label);
  }
  if (config.runtime) {
    // 「开箱即跑」模板带内联脚本（glueSource），没有 entrypoint——继续渲染
    // `runtime · -` 会让用户以为模板缺入口文件。有 glueSource 时显示 glue。
    const hasGlue = typeof config.glueSource === 'string' && config.glueSource.trim().length > 0;
    bits.push(`${config.runtime} · ${hasGlue ? t('templates.config.glue') : (config.entrypoint ?? '-')}`);
  }
  if (config.timeoutSeconds) bits.push(t('templates.config.timeout', { seconds: String(config.timeoutSeconds) }));
  if (config.maxRetry != null) bits.push(t('templates.config.retry', { count: String(config.maxRetry) }));
  return bits.join('　');
}

export default function TaskTemplatesPage() {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：主色图标走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 「使用模板」= 直接实例化：弹窗只采集任务名，其余 config 由后端展开。
  const [usingTpl, setUsingTpl] = useState<TaskTemplate | null>(null);
  const [useSubmitting, setUseSubmitting] = useState(false);
  // 同步锁：setState 要到下一次渲染才生效，双击/回车连击可能在重渲染前再次进入
  // handleConfirmUse，故用 ref 在**当前事件循环**里就挡住重复提交。
  const useSubmittingRef = useRef(false);
  const [useForm] = Form.useForm<{ name: string }>();

  // FEAT-17: useRequest 换 useTaskTemplates（模板删除后 refresh 走 refetch）。
  const { data: templates, isLoading: loading, error, refetch } = useTaskTemplates();
  const refresh = () => void refetch();

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await taskTemplatesApi.remove(id);
      message.success(t('templates.deleted'));
      refresh();
    } catch (err: unknown) {
      // DUP-TOAST 对齐：client.ts 拦截器已对 HTTP 失败弹过全局 toast，此前这里
      // 再补一条通用「删除失败」形成双报错，且把后端具体拒因（如官方模板 403）
      // 吞掉。走 showApiError 去重并透出后端文案。
      showApiError(err, t('templates.deleteFail'));
    } finally {
      setDeletingId(null);
    }
  };

  // 模板名可能是历史自定义值（含控制字符/超长）——默认名必须在本地就合法。
  // 放在 effect 里而不是打开前 setFieldsValue：Modal 未挂载时 form 实例未连接，
  // 直接写值会触发 antd "useForm not connected" 告警。
  useEffect(() => {
    if (usingTpl) useForm.setFieldsValue({ name: defaultTaskName(usingTpl.name) });
  }, [usingTpl, useForm]);

  const closeUseModal = () => {
    setUsingTpl(null);
    setUseSubmitting(false);
    useSubmittingRef.current = false;
    useForm.resetFields();
  };

  const handleCancelUse = () => {
    // 请求在途时不允许关闭：避免用户以为已取消、实际任务已创建。
    if (useSubmittingRef.current) return;
    closeUseModal();
  };

  /**
   * 「使用模板」→ `POST /task-templates/:id/instantiate`（不再跳 /tasks/new 表单）。
   *
   * 失败（如 409 重名）时 Modal **保持打开并保留输入**：用户改个名字即可重试，
   * 关掉弹窗会丢掉刚填的任务名。成功则跳任务详情——那里能看到立即创建的任务。
   */
  const handleConfirmUse = async () => {
    if (!usingTpl || useSubmittingRef.current) return;
    let values: { name?: string };
    try {
      values = await useForm.validateFields();
    } catch {
      // 校验错误（required/whitespace）由 Form.Item 内联红字呈现，不弹 toast、
      // 不发请求——这与「名称为空不得调用 instantiate」的硬约束一致。
      return;
    }
    const name = (values.name ?? '').trim();
    if (!name) return;

    useSubmittingRef.current = true;
    setUseSubmitting(true);
    try {
      const created = await taskTemplatesApi.instantiate(usingTpl.id, { name });
      message.success(t('templates.useDialog.created', { name: created.name ?? name }));
      closeUseModal();
      // 任务列表/统计缓存立即失效，返回列表时能看到刚创建的任务。
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      nav(`/tasks/${created.id}`);
    } catch (err: unknown) {
      // 409 重名等后端拒因经 getErrMsg 透出（client 拦截器已弹过的错误会被去重）。
      showApiError(err, t('templates.useDialog.fail'));
    } finally {
      useSubmittingRef.current = false;
      setUseSubmitting(false);
    }
  };

  const handleUse = (tpl: TaskTemplate) => {
    setUsingTpl(tpl);
    setUseSubmitting(false);
  };

  // UI-08：首屏加载（卡片页形态）以骨架屏替代裸 Spin
  if (loading) {
    return (
      <div>
        <PageHeader
          title={t('templates.title')}
          description={t('templates.description')}
        />
        <PageSkeleton variant="cards" rows={4} />
      </div>
    );
  }

  return (
    <div>
      {/* UI-03：页头标准化（原 Typography.Title 区块迁入 PageHeader） */}
      <PageHeader
        title={t('templates.title')}
        description={t('templates.description')}
      />

      {/* UI-08：错误态标准化——原仅 Alert 提示，升级为「重试 + 复制错误信息」错误块 */}
      {error && (
        <StateError
          error={error}
          onRetry={refresh}
          title={t('templates.error.title')}
          style={{ marginBottom: 16 }}
        />
      )}

      {!loading && !error && (!templates || templates.length === 0) && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('templates.empty')} />
      )}

      <Row gutter={[16, 16]}>
        {(templates ?? []).map((tpl) => (
          <Col xs={24} sm={12} lg={8} xl={6} key={tpl.id}>
            <Card
              style={{ height: '100%' }}
              title={
                // UI 打磨：模板名过长时（title 为 Space 节点，antd 默认省略号
                // 不生效）用 Text ellipsis+tooltip 收口，卡片等高避免换行锯齿
                <Space style={{ maxWidth: '100%' }} size={6}>
                  {/* 图标按钮 a11y：随文字的装饰图标对读屏器隐藏（aria-hidden） */}
                  <FileTextOutlined aria-hidden style={{ color: token.colorPrimary, flexShrink: 0 }} />
                  <Text ellipsis={{ tooltip: tpl.name }} style={{ maxWidth: '100%' }}>{tpl.name}</Text>
                </Space>
              }
              extra={
                tpl.isOfficial
                  ? <Tag color="gold">{t('templates.official')}</Tag>
                  : <Tag>{t('templates.custom')}</Tag>
              }
              actions={[
                <Button
                  key="use" type="link" size="small" icon={<CopyOutlined aria-hidden />}
                  onClick={() => handleUse(tpl)}
                >
                  {t('templates.use')}
                </Button>,
                tpl.isOfficial ? null : (
                  <Popconfirm
                    key="del" title={t('templates.deleteConfirm')} okText={t('templates.deleteOk')} cancelText={t('templates.cancel')}
                    okButtonProps={{ danger: true }}
                    onConfirm={() => handleDelete(tpl.id)}
                  >
                    {/* UI-09 图标按钮 a11y：删除按钮是 icon-only——antd 不会把
                        Tooltip 转成 aria-label，必须显式补 aria-label（可访问名
                        不再依赖图标的 aria-label="delete"）；图标本身纯装饰。 */}
                    <Tooltip title={t('templates.delete')}>
                      <Button
                        type="text" size="small" danger
                        icon={<DeleteOutlined aria-hidden />}
                        aria-label={t('templates.delete')}
                        loading={deletingId === tpl.id}
                      />
                    </Tooltip>
                  </Popconfirm>
                ),
              ].filter(Boolean)}
            >
              <Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ minHeight: 44, marginBottom: 8 }}>
                {tpl.description || t('templates.noDesc')}
              </Paragraph>
              <Space size={4} wrap style={{ marginBottom: 8 }}>
                {tpl.category && (
                  // UX-10：此前直接渲染 {tpl.category}（中文种子值），英文界面
                  // 下与相邻已翻译的触发方式标签中英混排。
                  <Tag color={CATEGORY_COLOR[tpl.category] || 'default'}>
                    {categoryLabel(tpl.category, t)}
                  </Tag>
                )}
                <Tag icon={<ApiOutlined aria-hidden />}>{TRIGGER_LABEL(t)[tpl.config.triggerType as string] ?? (tpl.config.triggerType ?? '—')}</Tag>
                {tpl.config.runtime ? <Tag icon={<CodeOutlined aria-hidden />}>{String(tpl.config.runtime)}</Tag> : null}
              </Space>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  <FieldTimeOutlined aria-hidden /> {configSummary(tpl.config, t) || '—'}
                </Text>
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      {/* 使用模板 = 直接实例化（POST /task-templates/:id/instantiate）：
          模板 config 已带 glueSource，后端展开即得可运行任务，无需再进表单。 */}
      <Modal
        open={usingTpl !== null}
        title={t('templates.useDialog.title')}
        okText={t('templates.useDialog.ok')}
        cancelText={t('templates.useDialog.cancel')}
        onOk={() => void handleConfirmUse()}
        onCancel={handleCancelUse}
        confirmLoading={useSubmitting}
        okButtonProps={{ loading: useSubmitting, disabled: useSubmitting }}
        cancelButtonProps={{ disabled: useSubmitting }}
        closable={!useSubmitting}
        keyboard={!useSubmitting}
        // antd 6：maskClosable 已弃用，改为 mask.closable；请求在途时点遮罩不关闭。
        mask={{ closable: !useSubmitting }}
        destroyOnHidden
        width={520}
      >
        {usingTpl && (
          <>
            <Paragraph style={{ marginBottom: 16 }}>
              {t('templates.useDialog.template', { name: usingTpl.name })}
            </Paragraph>
            <Form form={useForm} layout="vertical" preserve={false}>
              <Form.Item
                name="name"
                label={t('templates.useDialog.name')}
                rules={[{
                  required: true,
                  whitespace: true,
                  message: t('templates.useDialog.nameRequired'),
                }]}
              >
                <Input
                  data-testid="instantiate-name-input"
                  placeholder={t('templates.useDialog.namePlaceholder')}
                  maxLength={TASK_NAME_MAX_LENGTH}
                  autoFocus
                />
              </Form.Item>
            </Form>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('templates.useDialog.hint')}
            </Text>
          </>
        )}
      </Modal>
    </div>
  );
}
