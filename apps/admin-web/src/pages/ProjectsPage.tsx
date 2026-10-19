import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Card, Drawer, Empty, Form, Input, Modal, Pagination, Popconfirm,
  Select, Space, Table, Tag, Tooltip, Typography,
  // TOAST-01 的例外：`message.useMessage()` 是 **Hook**，必须由组件直接从
  // 'antd' 调用（utils/toast 只桥接命令式静态方法，不导出 Hook）。该 Hook
  // 返回的实例本身就在 React 树内，已消费主题，不需要再走桥。
  message as antdMessage,
} from 'antd';
import {
  DeleteOutlined, EditOutlined, PlusOutlined, TeamOutlined, UserAddOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import {
  projectsApi,
  type CreateProjectDto,
  type ProjectRemovalImpact,
  type ProjectRole,
  type ProjectViewRow,
} from '../api/projects';
// 常量走独立模块（constants/），**不从 api/projects 取**——该模块在 13 个单测
// 文件里被整体 vi.mock，mock 不提供运行时常量，页面会拿到 undefined 并让默认
// 项目的置灰逻辑静默失效。详见 constants/project.ts 头注。
import { DEFAULT_PROJECT_ID } from '../constants/project';
import { queryKeys } from '../api/queries';
import { usersApi } from '../api/users';
import { isAdminUser, useAuthStore } from '../store/auth';
// TOAST-01：命令式 message 必须走主题化出口（antd 静态方法渲染在 React 树
// 之外，暗色主题下仍是亮面、英文界面下文案回落中文）。本文件原先从 'antd'
// 直接导入 message，与本仓约定不符。
import { message } from '../utils/toast';
import { getErrMsg, isFormValidationError, showApiError } from '../utils/error';
import { formatDateTime } from '../utils/timeFormat';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';
// UI-09 第三轮：≤768px 表格 → 卡片列表的结构级降级（对齐 TaskListPage/
// ApplicationListPage 的 MOBILE-CARD-01 先例；断点与 index.css ui09 媒体查询同值）
import { useIsMobile } from '../hooks/useIsMobile';
// A11Y-DRAWER-01：成员抽屉焦点管理（开→聚焦首个可交互元素；关→归还触发按钮）
import { useDrawerA11y } from '../hooks/useDrawerA11y';
import '../i18n';

const { Text } = Typography;

/**
 * AUTH-02 后续：项目管理页。
 *
 * 列表读面与后端一致（ADMIN 全量 / 普通用户「默认项目 ∪ 成员项目」），
 * 每行「我的角色」徽标来自 myRole。成员管理 Drawer：ADMIN 可增删改角色
 * （后端成员写面 ADMIN-only），普通用户只读——既有 RequireAdmin 形态在此
 * 不适用（路由本身全员可达），改用 isAdminUser 门控操作区渲染。
 *
 * PROJECT-CRUD-01（生产反馈「没看到项目管理可以新增或者别的操作地方」）：
 * 后端 POST/PATCH/DELETE /projects 一直是 ADMIN-only 可用状态，但前端**全站
 * 没有入口**——页面只有每行的「成员」按钮，用户无从新建项目，也无从改名/删除。
 * 本轮补齐：页头「新建项目」+ 行内「编辑 / 删除」（全部 isAdmin 门控，与成员
 * 写面同一道闸）。默认项目恒不可改名/删除（后端 404 PROJECT_DEFAULT_IMMUTABLE），
 * 故该行两个按钮**置灰**并给 tooltip 说明——让「为什么点不动」在界面上有答案，
 * 而不是点下去弹一句英文 404。
 */

type TFn = (k: string, o?: Record<string, unknown>) => string;

const ROLE_COLOR: Record<ProjectRole, string> = {
  viewer: 'default',
  editor: 'blue',
  admin: 'gold',
};
const roleLabel = (role: ProjectRole, t: TFn): string => t(`projects.role.${role}`);

function RoleTag({ role, t }: { role: ProjectRole | null; t: TFn }) {
  if (!role) return <Text type="secondary">—</Text>;
  return <Tag color={ROLE_COLOR[role]}>{roleLabel(role, t)}</Tag>;
}

/** 默认项目：后端拒绝改名/删除，界面上提前置灰（见文件头注释）。 */
const isDefaultProject = (id: string) => id === DEFAULT_PROJECT_ID;

/**
 * 影响面是否有「值得展开看详情」的内容。
 *
 * 空项目（无任务、无成员）走**快速通道**：气泡里的「该项目下没有任务或成员」
 * 已经说完了全部事实，再弹一个内容相同的 Modal 纯属浪费一次点击。
 */
const hasImpactDetail = (impact: ProjectRemovalImpact | null): boolean =>
  impact !== null && (impact.taskCount > 0 || impact.memberCount > 0);

interface DeleteProjectButtonProps {
  row: ProjectViewRow;
  isAdmin: boolean;
  /** 禁用原因（默认项目 / 非管理员）；undefined = 可删。 */
  hint?: string;
  /**
   * 真正执行删除（分页钳制等父级状态留在父组件）。**失败时会抛出**——
   * 气泡/弹窗据此保持打开，而不是先关掉再弹 toast。
   */
  onConfirmDelete: (row: ProjectViewRow) => Promise<void>;
  /** 桌面表格与移动端卡片用不同尺寸（link 按钮 vs 普通小按钮）。 */
  variant: 'table' | 'card';
}

/**
 * PROJECT-IMPACT-01 · 方案 B-lite：删除入口。
 *
 * ## 为什么不是「先拉数据再弹 Modal」
 *
 * 首版是 `handleDeleteClick` 里 `await removalImpact()` 之后再
 * `Modal.confirm(...)`——点击到弹窗之间有一个网络往返（100~300ms，慢网更久），
 * 期间界面上**没有任何反馈**。用户看到的是「删除按钮点不动」，于是再点一次，
 * 变成两次请求两次弹窗。
 *
 * ## 本方案的时序
 *
 *   t=0ms    点击 → Popconfirm **立刻**出现（纯本地渲染，零延迟）
 *   t=0ms    气泡里显示「正在统计影响…」，同时发起 impact 请求
 *   t≈200ms  数字就地替换加载态（气泡不跳、不重开）
 *   ① 空项目   → 气泡已说清（无任务/无成员），点「删除」一步删完
 *   ② 非空项目 → 点「查看影响并删除」打开 Modal 逐条列后果，在 Modal 里最终确认
 *
 * 非空项目的确定键文案是「查看影响并删除」而不是「删除」——按钮必须诚实：
 * 它这一下**不会**删掉任何东西，只是展开详情。让按钮说「删除」却只弹窗，
 * 是同一类「文案与行为不符」的缺陷。
 *
 * ## 为什么每次打开都重取影响面
 *
 * 影响面会随时间变化（期间有人往项目里加了任务）。缓存上一次的数字比不显示
 * 更危险——用户会照着**过期**的数字决定删不删。故 `onOpenChange(true)` 时
 * 无条件重取，并用请求序号丢弃过期响应（连点开关时后发的请求才是权威）。
 */
function DeleteProjectButton({
  row,
  isAdmin,
  hint,
  onConfirmDelete,
  variant,
}: DeleteProjectButtonProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const disabled = !isAdmin || isDefaultProject(row.id);

  const [impact, setImpact] = useState<ProjectRemovalImpact | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [popOpen, setPopOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // 请求序号：连点开关时，只有最后一次发出的请求可以写状态。
  const seqRef = useRef(0);

  const fetchImpact = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setFailed(false);
    try {
      const data = await projectsApi.removalImpact(row.id);
      if (seq !== seqRef.current) return;
      setImpact(data);
    } catch {
      if (seq !== seqRef.current) return;
      setFailed(true);
      setImpact(null);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [row.id]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setPopOpen(open);
      if (open) void fetchImpact();
    },
    [fetchImpact],
  );

  /** 返回是否成功；失败时调用方保持气泡/弹窗打开（错误 toast 已由父级弹出）。 */
  const doDelete = useCallback(async (): Promise<boolean> => {
    setDeleting(true);
    try {
      await onConfirmDelete(row);
      setDetailOpen(false);
      setPopOpen(false);
      return true;
    } catch {
      return false;
    } finally {
      setDeleting(false);
    }
  }, [onConfirmDelete, row]);

  const detail = !loading && !failed && hasImpactDetail(impact);
  /**
   * 确定键是否可用。
   *
   * 三态而非「拿到数据才可用」：
   *  · 加载中          → **禁用**（不知道后果就不许确认，这正是本功能的意义）；
   *  · 成功            → 可用；
   *  · 失败（降级）    → **也可用**。预览是增强、不是闸门——一次接口抖动不该让
   *    管理员彻底删不掉东西（与 application.service.describeRemovalImpact 的
   *    「影响面拉取失败不阻断删除」同一姿态）。此时气泡文案已明说"未能获取"，
   *    用户是在知情的前提下确认的。
   */
  const dataReady = !loading;

  const button = (
    <Button
      type={variant === 'table' ? 'link' : 'default'}
      size="small"
      danger
      icon={<DeleteOutlined aria-hidden />}
      disabled={disabled || deleting}
      loading={deleting}
      aria-label={t('projects.action.delete')}
    >
      {t('projects.action.delete')}
    </Button>
  );

  // 禁用态：只挂 Tooltip 解释原因。**不再**嵌套 Popconfirm——rc-trigger 的
  // hover 与 click 是两套独立 trigger，Tooltip 包 Popconfirm 时浮层互相顶掉
  // （仓库既有写法是 Tooltip→Button 直接相邻，见 ApplicationListPage 操作列）。
  if (disabled) {
    return <Tooltip title={hint}>{button}</Tooltip>;
  }

  const description = loading ? (
    <span>{t('projects.deletePop.loading')}</span>
  ) : failed || impact === null ? (
    <span>{t('projects.deleteImpact.unavailable')}</span>
  ) : hasImpactDetail(impact) ? (
    <div>
      {impact.taskCount > 0 && (
        <div>
          {t('projects.deletePop.tasks', {
            count: impact.taskCount,
            active: impact.activeTaskCount,
          })}
        </div>
      )}
      {impact.memberCount > 0 && (
        <div>{t('projects.deletePop.members', { count: impact.memberCount })}</div>
      )}
    </div>
  ) : (
    <span>{t('projects.deleteImpact.none')}</span>
  );

  return (
    <>
      <Popconfirm
        title={t('projects.deleteConfirmTitle', { name: row.name })}
        description={description}
        okText={detail ? t('projects.deletePop.continue') : t('projects.deletePop.ok')}
        cancelText={t('projects.deleteConfirmCancel')}
        okButtonProps={{
          danger: true,
          // 加载中不许点：此时按钮文案还是「删除」，而影响面未知——让用户在
          // 不知道后果时确认，正是这个功能要消灭的东西。
          disabled: !dataReady,
          loading: deleting,
        }}
        // 375px 下 topRight 会让气泡以目标右缘对齐、向左展开；卡片里删除键
        // 未必靠右，居中（top）更稳。桌面用 topRight 贴近操作列。
        placement={isMobile ? 'top' : 'topRight'}
        onOpenChange={handleOpenChange}
        open={popOpen}
        onConfirm={() => {
          if (detail) {
            // 非空项目：这一下只展开详情，不删（按钮文案已说明）
            setPopOpen(false);
            setDetailOpen(true);
            return;
          }
          void doDelete();
        }}
        onCancel={() => setPopOpen(false)}
      >
        {button}
      </Popconfirm>

      <Modal
        title={t('projects.deleteModal.title', { name: row.name })}
        open={detailOpen}
        onOk={() => void doDelete()}
        onCancel={() => setDetailOpen(false)}
        okText={t('projects.deleteModal.ok')}
        okButtonProps={{ danger: true, loading: deleting }}
        cancelText={t('projects.deleteConfirmCancel')}
        destroyOnHidden
      >
        <p style={{ marginBottom: 8 }}>{t('projects.deleteConfirmBody')}</p>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {impact && impact.taskCount > 0 && (
            <li>
              {t('projects.deleteImpact.tasks', {
                count: impact.taskCount,
                active: impact.activeTaskCount,
              })}
            </li>
          )}
          {impact && impact.memberCount > 0 && (
            <li>{t('projects.deleteImpact.members', { count: impact.memberCount })}</li>
          )}
        </ul>
      </Modal>
    </>
  );
}

export default function ProjectsPage() {
  const { t } = useTranslation();
  // UI-09 第三轮：≤768px 结构级降级开关（表格→卡片）
  const isMobile = useIsMobile();
  const user = useAuthStore((s) => s.user);
  const isAdmin = isAdminUser(user);
  const queryClient = useQueryClient();

  const [membersProject, setMembersProject] = useState<ProjectViewRow | null>(null);
  // PROJECT-CRUD-01：新建/编辑共用一个弹窗（editingProject 为 null = 新建）
  const [editingProject, setEditingProject] = useState<ProjectViewRow | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [projectForm] = Form.useForm<CreateProjectDto>();

  // URL-SYNC-01：page/pageSize 以 URL 为初始源并回写（对齐 UserManagementPage/
  // AgentSessionsPage 先例）；非法深链值（?page=abc、负数、浮点、pageSize>100）
  // 回落默认值，不空屏不报错。上限 100 与后端钳制纪律一致。
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(() => {
    const p = Number(searchParams.get('page'));
    return Number.isInteger(p) && p > 0 ? p : 1;
  });
  const [pageSize, setPageSize] = useState(() => {
    const ps = Number(searchParams.get('pageSize'));
    return Number.isInteger(ps) && ps > 0 && ps <= 100 ? ps : 20;
  });

  // 列表：后端已按主体过滤，前端零额外处理；R3 起走服务端分页（信封形状，
  // list/items 双键取 list）。queryKey 带上 page/pageSize——翻页各自缓存；
  // 成员变更的失效走 queryKeys.projects.list 前缀（v5 前缀语义覆盖全部分页键）。
  const projectsQuery = useQuery({
    queryKey: [...queryKeys.projects.list, page, pageSize],
    queryFn: ({ signal }) => projectsApi.listPaged(page, pageSize, signal),
  });
  const rows: ProjectViewRow[] = projectsQuery.data?.list ?? [];
  const total: number = projectsQuery.data?.total ?? 0;

  // URL-SYNC-01：状态→URL 回写（replace 不制造历史记录；默认值不写入保持 URL 干净）
  useEffect(() => {
    const next = new URLSearchParams();
    if (page !== 1) next.set('page', String(page));
    if (pageSize !== 20) next.set('pageSize', String(pageSize));
    setSearchParams(next, { replace: true });
  }, [page, pageSize, setSearchParams]);

  // ── PROJECT-CRUD-01：新建 / 编辑 / 删除 ──────────────────────────────
  const invalidateList = useCallback(() => {
    // 前缀失效：覆盖全部分页键（v5 前缀语义）
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects.list });
  }, [queryClient]);

  const openCreate = useCallback(() => {
    setEditingProject(null);
    projectForm.resetFields();
    setModalOpen(true);
  }, [projectForm]);

  const openEdit = useCallback(
    (row: ProjectViewRow) => {
      setEditingProject(row);
      projectForm.setFieldsValue({ name: row.name, description: row.description ?? '' });
      setModalOpen(true);
    },
    [projectForm],
  );

  /**
   * 保存（新建或编辑）。
   *
   * `validateFields` 的 rejection 必须有消费方：校验失败由 Form 自带红字呈现
   * （isFormValidationError 分支静默），其余异常兜底 toast——与
   * UserManagementPage.handleCreateSubmit 同款，消除 unhandled rejection。
   */
  const handleSubmit = useCallback(() => {
    projectForm
      .validateFields()
      .then(async (values) => {
        setSaving(true);
        try {
          const dto: CreateProjectDto = {
            name: values.name.trim(),
            // 空描述显式传空串而不是省略：后端 description 可空，省略等于「不改」，
            // 编辑时用户清空描述必须能落库（与 UserManagementPage 的显式传参口径一致）。
            description: (values.description ?? '').trim(),
          };
          if (editingProject) {
            await projectsApi.update(editingProject.id, dto);
            message.success(t('projects.updated'));
          } else {
            await projectsApi.create(dto);
            message.success(t('projects.created'));
          }
          setModalOpen(false);
          setEditingProject(null);
          projectForm.resetFields();
          invalidateList();
        } catch (err: unknown) {
          showApiError(err, editingProject ? t('projects.updateFail') : t('projects.createFail'));
        } finally {
          setSaving(false);
        }
      })
      .catch((err: unknown) => {
        if (isFormValidationError(err)) return;
        showApiError(err, t('projects.createFail'));
      });
  }, [editingProject, invalidateList, projectForm, t]);

  /**
   * 真正执行删除（影响面已在气泡/弹窗里展示过）。
   *
   * **失败时重新抛出**：`DeleteProjectButton` 的 `onConfirmDelete` 契约就是
   * 「失败要抛」——气泡与详情弹窗据此保持打开，用户可原地重试。若在这里
   * 吞掉异常，antd 会把 Popconfirm 关掉，用户看到"弹窗没了"，回列表才发现
   * 项目还在——典型的假成功。
   */
  const performDelete = useCallback(
    async (row: ProjectViewRow) => {
      try {
        await projectsApi.remove(row.id);
        message.success(t('projects.deleted'));
        // 空页钳制：删掉当前页最后一条且不在第 1 页时回退一页（对齐
        // UserManagementPage 的删除后分页处理——否则会停在空页）。
        if (rows.length === 1 && page > 1) setPage(page - 1);
        invalidateList();
      } catch (err: unknown) {
        showApiError(err, t('projects.deleteFail'));
        throw err;
      }
    },
    [invalidateList, page, rows.length, t],
  );

  const columns = useMemo(
    () => [
      // UI 打磨：name 弹性列不设宽；描述单行 ellipsis（tooltip 看全文）；
      // 时间/角色固定宽防折行；操作列 fixed right + scroll.x 窄屏横向滚动
      {
        title: t('projects.col.name'),
        dataIndex: 'name',
        key: 'name',
        // COLWIDTH-01：弹性列必须给 width——antd 的 useWidthColumns 只在
        // 「所有列都有 width」时才不把剩余宽度全塞给唯一的弹性列。此前这里
        // 不设 width，宽屏下名称列被撑到 900px+（1920 实测），表格观感失衡。
        width: 280,
        ellipsis: { showTitle: false },
        render: (v: string, row: ProjectViewRow) => (
          <Space size={4}>
            <Text strong style={{ display: 'inline-block', maxWidth: '100%' }} ellipsis={{ tooltip: v }}>
              {v}
            </Text>
            {isDefaultProject(row.id) && (
              <Tag color="default">{t('projects.defaultBadge')}</Tag>
            )}
          </Space>
        ),
      },
      {
        title: t('projects.col.description'),
        dataIndex: 'description',
        key: 'description',
        ellipsis: { showTitle: false },
        render: (v: string | null) =>
          v ? (
            <Text style={{ display: 'block' }} ellipsis={{ tooltip: v }}>
              {v}
            </Text>
          ) : (
            <Text type="secondary">—</Text>
          ),
      },
      {
        title: t('projects.col.myRole'),
        dataIndex: 'myRole',
        key: 'myRole',
        width: 100,
        render: (v: ProjectRole | null) => <RoleTag role={v} t={t} />,
      },
      {
        title: t('projects.col.createdAt'),
        dataIndex: 'createdAt',
        key: 'createdAt',
        width: 170,
        render: (v: string) => formatDateTime(v),
      },
      {
        title: t('projects.col.actions'),
        key: 'actions',
        // PROJECT-CRUD-01：「成员 / 编辑 / 删除」三个带文字按钮合计约 200px。
        // 宽度不足会让内容溢出单元格——而**溢出正是 fixed 列失效的直接原因**
        // （sticky 元素的内容比自身宽时，右侧溢出部分会被滚动容器裁掉，看起来
        // 就是「操作列没固定住」）。故这里给足 220 并保持 fixed right。
        width: 220,
        fixed: 'right' as const,
        render: (_: unknown, row: ProjectViewRow) => {
          const immutable = isDefaultProject(row.id);
          // 禁用原因统一在一处推导：ADMIN 看到的是「默认项目不可改」，
          // 普通用户看到的是「仅管理员可改」——两者都不该点下去才弹一句英文 404。
          const editHint = !isAdmin
            ? t('projects.editDisableHint')
            : immutable
              ? t('projects.defaultImmutable')
              : undefined;
          const deleteHint = !isAdmin
            ? t('projects.deleteDisableHint')
            : immutable
              ? t('projects.defaultImmutable')
              : undefined;
          return (
            <Space size={0}>
              <Button
                type="link"
                size="small"
                icon={<TeamOutlined aria-hidden />}
                onClick={() => setMembersProject(row)}
              >
                {t('projects.members.view')}
              </Button>
              <Tooltip title={editHint}>
                <Button
                  type="link"
                  size="small"
                  icon={<EditOutlined aria-hidden />}
                  disabled={!isAdmin || immutable}
                  onClick={() => openEdit(row)}
                >
                  {t('projects.action.edit')}
                </Button>
              </Tooltip>
              {/* 删除走自包含的 DeleteProjectButton：气泡即时出现 + 影响面在
                  气泡内异步长出，空项目一步删完，非空项目再展开 Modal 详情。
                  详见该组件的头注（PROJECT-IMPACT-01 · 方案 B-lite）。 */}
              <DeleteProjectButton
                row={row}
                isAdmin={isAdmin}
                hint={deleteHint}
                onConfirmDelete={performDelete}
                variant="table"
              />
            </Space>
          );
        },
      },
    ],
    [isAdmin, openEdit, performDelete, t],
  );

  const modal = (
    <Modal
      title={editingProject ? t('projects.modal.edit') : t('projects.modal.create')}
      open={modalOpen}
      onOk={handleSubmit}
      onCancel={() => {
        setModalOpen(false);
        setEditingProject(null);
      }}
      okText={t('projects.form.ok')}
      cancelText={t('projects.form.cancel')}
      // 防重复提交：保存请求飞行中确定按钮 loading+禁用（对齐 appList 的 saving 口径）
      confirmLoading={saving}
      forceRender
      afterOpenChange={(open) => {
        if (open && !editingProject) projectForm.resetFields();
      }}
    >
      <Form form={projectForm} layout="vertical" preserve={false}>
        <Form.Item
          name="name"
          label={t('projects.form.name')}
          rules={[
            { required: true, whitespace: true, message: t('projects.form.nameRequired') },
            { max: 100, message: t('projects.form.nameMax') },
          ]}
        >
          <Input
            placeholder={t('projects.form.namePlaceholder')}
            maxLength={100}
            // 编辑默认项目之外的既有项目时，name 是可变字段（后端 UpdateProjectDto
            // 允许改），无需禁用；默认项目本就不给编辑入口。
            autoFocus
          />
        </Form.Item>
        <Form.Item
          name="description"
          label={t('projects.form.description')}
          rules={[{ max: 500, message: t('projects.form.descriptionMax') }]}
        >
          <Input.TextArea
            placeholder={t('projects.form.descriptionPlaceholder')}
            rows={3}
            maxLength={500}
            showCount
          />
        </Form.Item>
      </Form>
    </Modal>
  );

  const headerExtra = (
    <>
      <Tooltip title={isAdmin ? undefined : t('projects.createDisableHint')}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={openCreate}
          disabled={!isAdmin}
        >
          {t('projects.create')}
        </Button>
      </Tooltip>
    </>
  );

  if (projectsQuery.isLoading) {
    return (
      <div>
        <PageHeader
          title={t('projects.title')}
          description={t('projects.description')}
          extra={headerExtra}
        />
        <PageSkeleton variant="table" />
      </div>
    );
  }
  if (projectsQuery.error) {
    return (
      <div>
        <PageHeader
          title={t('projects.title')}
          description={t('projects.description')}
          extra={headerExtra}
        />
        <StateError error={projectsQuery.error} onRetry={() => void projectsQuery.refetch()} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t('projects.title')}
        description={t('projects.description')}
        extra={headerExtra}
      />
      {/* UI-09 第三轮：≤768px 卡片列表（MOBILE-CARD-01 同款结构级降级）——
          项目卡按首查信息组织：名称+我的角色 → 描述 → 创建时间 → 成员/编辑/删除；
          桌面保留 5 列表格（fixed 操作列 + scroll.x）。服务端分页两侧共用
          同一 state（URL-SYNC-01 回写不变）。 */}
      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('projects.empty')}>
              {isAdmin && (
                <Button type="primary" onClick={openCreate}>
                  {t('projects.empty.createFirst')}
                </Button>
              )}
            </Empty>
          ) : (
            rows.map((row) => {
              const immutable = isDefaultProject(row.id);
              // 与桌面表格同一套禁用原因推导（见 columns 的 editHint/deleteHint）
              const editHint = !isAdmin
                ? t('projects.editDisableHint')
                : immutable
                  ? t('projects.defaultImmutable')
                  : undefined;
              const deleteHint = !isAdmin
                ? t('projects.deleteDisableHint')
                : immutable
                  ? t('projects.defaultImmutable')
                  : undefined;
              return (
                <Card key={row.id} size="small">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <Space size={4} style={{ flex: 1, minWidth: 0 }}>
                      <Text strong ellipsis style={{ minWidth: 0 }}>{row.name}</Text>
                      {immutable && <Tag color="default">{t('projects.defaultBadge')}</Tag>}
                    </Space>
                    <RoleTag role={row.myRole} t={t} />
                  </div>
                  {row.description && (
                    <Text
                      type="secondary"
                      style={{ display: 'block', marginTop: 4, fontSize: 12 }}
                      ellipsis={{ tooltip: row.description }}
                    >
                      {row.description}
                    </Text>
                  )}
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--chart-axis-text)' }}>
                    {t('projects.col.createdAt')}：{formatDateTime(row.createdAt)}
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    <Button
                      size="small"
                      icon={<TeamOutlined aria-hidden />}
                      onClick={() => setMembersProject(row)}
                    >
                      {t('projects.members.view')}
                    </Button>
                    <Tooltip title={editHint}>
                      <Button
                        size="small"
                        icon={<EditOutlined aria-hidden />}
                        disabled={!isAdmin || immutable}
                        onClick={() => openEdit(row)}
                      >
                        {t('projects.action.edit')}
                      </Button>
                    </Tooltip>
                    <DeleteProjectButton
                      row={row}
                      isAdmin={isAdmin}
                      hint={deleteHint}
                      onConfirmDelete={performDelete}
                      variant="card"
                    />
                  </div>
                </Card>
              );
            })
          )}
          {rows.length > 0 && (
            <Pagination
              size="small"
              current={page}
              pageSize={pageSize}
              total={total}
              showSizeChanger={false}
              onChange={(p, ps) => {
                setPage(p);
                setPageSize(ps);
              }}
              style={{ alignSelf: 'flex-end' }}
            />
          )}
        </div>
      ) : (
        <Table
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={rows}
          // COLWIDTH-01：scroll.x 必须 ≥ 各列 width 之和（280 + 弹性描述 + 100 +
          // 170 + 220）。此前 880 < 固定列之和，rc-table 的 useWidthColumns 会把
          // 差额从弹性列里扣，名称列被压到 262px 且描述列几乎不可读；同时
          // scroll.x < 容器宽时表格整体不产生横向滚动，fixed 列反而在容器内
          // 「跟着滚」——这正是「操作列没固定住」的观感来源。
          scroll={{ x: 1180 }}
          // UI 打磨：loading 直传 isFetching——翻页/重取期间表格有反馈，
          // 首屏（无数据）仍走上方整页骨架
          loading={projectsQuery.isFetching}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (count) => t('projects.count', { count }),
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps);
            },
          }}
        />
      )}
      {modal}
      <MembersDrawer
        project={membersProject}
        isAdmin={isAdmin}
        onClose={() => setMembersProject(null)}
      />
    </div>
  );
}

interface MembersDrawerProps {
  project: ProjectViewRow | null;
  isAdmin: boolean;
  onClose: () => void;
}

function MembersDrawer({ project, isAdmin, onClose }: MembersDrawerProps) {
  const { t } = useTranslation();
  // UI-09 第三轮：成员抽屉窄屏满宽（桌面保留 size="large" 的 736px）
  const isMobile = useIsMobile();
  // A11Y-DRAWER-01：抽屉焦点管理（开→聚焦首个可交互元素；关→归还触发按钮）
  const drawerA11y = useDrawerA11y();
  const queryClient = useQueryClient();
  const [addForm] = Form.useForm<{ userId: number; role: ProjectRole }>();
  const [messageApi, contextHolder] = antdMessage.useMessage();
  const open = project !== null;

  const membersQuery = useQuery({
    queryKey: queryKeys.projects.members(project?.id ?? ''),
    queryFn: ({ signal }) => projectsApi.getMembers(project!.id, signal),
    enabled: open,
  });

  // ADMIN 的添加成员表单需要可选用户清单（/users 为 ADMIN-only 端点，
  // 打开 Drawer 且 isAdmin 时才拉取）
  //
  // 用 listAll 而非 list(1, 200)：后端 pageSize 上限是 100，此前写死 200
  // 必然 400（"Validation failed: pageSize must not be greater than 100"），
  // 于是**管理员一打开成员面板就整块报错**（普通用户看不到——该请求
  // enabled 条件是 isAdmin）。listAll 按 total 翻页取全，用户数 >100 也不会截断。
  const usersQuery = useQuery({
    queryKey: queryKeys.projects.candidateUsers,
    queryFn: ({ signal }) => usersApi.listAll(signal),
    enabled: open && isAdmin,
  });

  const invalidate = () => {
    if (project) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.members(project.id),
      });
    }
    // NETOPT-D P3: 成员变化影响当前用户的 myRole/成员态——projects.list 行
    // 依赖它，不失效则列表页该行角色展示滞后到下次挂载重取。
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects.list });
  };

  const addMutation = useMutation({
    mutationFn: (dto: { userId: number; role: ProjectRole }) =>
      projectsApi.addMember(project!.id, dto.userId, dto.role),
    onSuccess: () => {
      messageApi.success(t('projects.members.addOk'));
      addForm.resetFields();
      invalidate();
    },
    onError: (e) => messageApi.error(getErrMsg(e)),
  });
  const removeMutation = useMutation({
    mutationFn: (userId: number) => projectsApi.removeMember(project!.id, userId),
    onSuccess: () => {
      messageApi.success(t('projects.members.removeOk'));
      invalidate();
    },
    onError: (e) => messageApi.error(getErrMsg(e)),
  });

  return (
    // antd 6：width 已并入 size（number|string|'large'|'default'）——
    // 窄屏 '100%' 满宽，桌面保留 size="large"（736px）
    <Drawer
      title={
        project
          ? t('projects.members.title', { name: project.name })
          : t('projects.members.title', { name: '' })
      }
      size={isMobile ? '100%' : 'large'}
      open={open}
      onClose={onClose}
      afterOpenChange={drawerA11y.afterOpenChange}
      destroyOnHidden
    >
      {/* A11Y-DRAWER-01：内容包一层 ref 定位容器——焦点首站查询收窄到本抽屉 */}
      <div ref={drawerA11y.contentRef}>
      {contextHolder}
      {membersQuery.error ? (
        <StateError error={membersQuery.error} onRetry={() => void membersQuery.refetch()} />
      ) : (
        <Table
          rowKey="userId"
          size="small"
          loading={membersQuery.isLoading}
          dataSource={membersQuery.data ?? []}
          pagination={false}
          locale={{ emptyText: t('projects.members.empty') }}
          columns={[
            { title: t('projects.members.userId'), dataIndex: 'userId', key: 'userId' },
            {
              title: t('projects.members.role'),
              dataIndex: 'role',
              key: 'role',
              render: (v: ProjectRole) => <RoleTag role={v} t={t} />,
            },
            ...(isAdmin
              ? [
                  {
                    title: t('projects.col.actions'),
                    key: 'actions',
                    render: (_: unknown, row: { userId: number }) => (
                      <Button
                        danger
                        size="small"
                        icon={<DeleteOutlined aria-hidden />}
                        loading={removeMutation.isPending && removeMutation.variables === row.userId}
                        onClick={() => removeMutation.mutate(row.userId)}
                      >
                        {t('projects.members.remove')}
                      </Button>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}

      {isAdmin && (
        <Form
          form={addForm}
          layout="vertical"
          style={{ marginTop: 16 }}
          onFinish={(v) => addMutation.mutate(v)}
        >
          {/* 候选用户清单拉取失败不再静默成空下拉——原位给出错误块 + 重试入口
              （对齐上方 membersQuery 错误态口径）。否则管理员看到的是"没有可选
              用户"，无从分辨是列表为空还是请求失败。 */}
          {usersQuery.isError && (
            <StateError
              error={usersQuery.error}
              title={t('projects.members.candidatesFail')}
              onRetry={() => void usersQuery.refetch()}
              style={{ marginBottom: 16 }}
            />
          )}
          <Form.Item
            name="userId"
            label={t('projects.members.userId')}
            rules={[{ required: true, message: t('projects.members.userIdRequired') }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder={t('projects.members.userIdPlaceholder')}
              options={(usersQuery.data ?? []).map((u) => ({
                value: u.id,
                label: `#${u.id} ${u.username}`,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="role"
            label={t('projects.members.role')}
            initialValue="viewer"
            rules={[{ required: true }]}
          >
            <Select
              options={(['viewer', 'editor', 'admin'] as ProjectRole[]).map((r) => ({
                value: r,
                label: roleLabel(r, t),
              }))}
            />
          </Form.Item>
          <Space>
            <Button
              type="primary"
              icon={<UserAddOutlined aria-hidden />}
              htmlType="submit"
              loading={addMutation.isPending}
            >
              {t('projects.members.add')}
            </Button>
          </Space>
        </Form>
      )}
      </div>
    </Drawer>
  );
}
