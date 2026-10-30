import { useState, useCallback } from 'react';
import { Table,
  Button,
  Space,
  Modal,
  Form,
  Input,
  Select,
  Tag,
  Popconfirm,
  Card,
  Row,
  Col,
  Empty,
  Typography,
  Switch,
  Tooltip,
  theme } from 'antd';
import { message } from '../utils/toast';
// MODAL-01：命令式确认弹窗走主题化出口（暗色主题/locale 语境，与 toast 同源动机）
import { Modal as confirmModal } from '../utils/modal';
import {
  PlusOutlined,
  SearchOutlined,
  LockOutlined,
  DeleteOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usersApi, type User, type CreateUserDto, type UpdateUserDto } from '../api/users';
import { isFormValidationError, showApiError } from '../utils/error';
// P1-1：读当前登录用户——自己那行的启用开关置灰（后端 400 兜底）
import { useAuthStore } from '../store/auth';
// 时间展示统一走共享 formatDateTime（locale 跟随 i18n 而非浏览器，见 utils/timeFormat）
import { formatDateTime } from '../utils/timeFormat';
import { useTranslation } from 'react-i18next';
// URL-SYNC-01：搜索/分页状态同步 URL（对齐 TaskListPage/ExecutionsPage 先例）——
// 刷新、后退、分享链接不再丢状态。
import { useSearchParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import PasswordStrengthMeter from '../components/PasswordStrengthMeter';
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_PATTERN,
} from '../utils/passwordPolicy';
import StateError from '../components/StateError';
import PageSkeleton from '../components/PageSkeleton';
// MOBILE-CARD-01：≤768px 表格 → 卡片列表（结构级降级，CSS 做不到）
import { useIsMobile } from '../hooks/useIsMobile';
// USER-SEARCH-01：搜索防抖（列表查询跟随 debounced 值，输入框即时回显）
import { useDebounce } from '../hooks/useDebounce';
// URL-SYNC-02（审计 P2）：双向 URL 同步（外部深链/前进后退真正生效）
import { useUrlStateSync } from '../hooks/useUrlStateSync';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

const { Option } = Select;

const ROLE_COLORS: Record<string, string> = {
  admin: 'red',
  user: 'blue',
};

const ROLE_LABELS = (t: (k: string) => string): Record<string, string> => ({
  admin: t('users.role.admin'),
  user: t('users.role.user'),
});

interface UserWithActive extends User {
  isActive?: boolean;
}

/**
 * P1-1（对齐后端 ad5bdef4 isActive 写面）：行内启用/禁用开关（桌面状态列与
 * 移动端卡片共用）。交互口径对齐 TaskListPage 行内启停 Switch：
 *   · 禁用是影响性动作——onToggle(next=false) 由调用方弹二次确认后再落库；
 *   · 启用可逆——直接生效，不设确认；
 *   · 自己那行永久置灰 + Tooltip（后端 USER_SELF_DISABLE_FORBIDDEN 400 兜底）：
 *     禁用自己会让当前会话即刻失效，极易把唯一管理主体关在门外；
 *   · checked 以 `isActive !== false` 判定——字段缺省（旧后端/旧数据）按启用
 *     呈现，与状态列 Tag 的既有口径一致。
 */
function UserActiveSwitch(props: {
  user: UserWithActive;
  /** 该行请求在途（开关 loading，防重复提交；口径同删除按钮 mutation.variables 精确到行） */
  busy: boolean;
  isSelf: boolean;
  onToggle: (user: UserWithActive, next: boolean) => void;
}) {
  const { t } = useTranslation();
  const { user, busy, isSelf, onToggle } = props;
  const sw = (
    <Switch
      size="small"
      checked={user.isActive !== false}
      loading={busy}
      disabled={isSelf}
      aria-label={
        user.isActive === false
          ? t('users.action.enable')
          : t('users.action.disable')
      }
      onChange={(checked) => onToggle(user, checked)}
    />
  );
  if (!isSelf) return sw;
  // disabled 按钮不派发鼠标事件——Tooltip 需包一层可悬浮元素（antd 官方口径）
  return (
    <Tooltip title={t('users.selfDisableForbidden')}>
      <span style={{ display: 'inline-flex' }}>{sw}</span>
    </Tooltip>
  );
}

export default function UserManagementPage() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  // URL-SYNC-01：筛选/分页以 URL 查询参数为初始源并回写
  const [searchParams] = useSearchParams();
  // F-15（DEEP_REVIEW 0ef3bbe）：占位次要色走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
  const [searchText, setSearchText] = useState(() => searchParams.get('q') || '');
  // URL-SYNC-01：page/pageSize 以 URL 为初始源；非法深链值（?page=abc、负数）
  // 回落默认值，不空屏不报错。
  const [page, setPage] = useState(() => {
    const p = Number(searchParams.get('page'));
    return Number.isInteger(p) && p > 0 ? p : 1;
  });
  const [pageSize, setPageSize] = useState(() => {
    const ps = Number(searchParams.get('pageSize'));
    return Number.isInteger(ps) && ps > 0 ? ps : 20;
  });
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editing, setEditing] = useState<UserWithActive | null>(null);
  const [createForm] = Form.useForm();
  const [resetPwdModalOpen, setResetPwdModalOpen] = useState(false);
  const [resetPwdUser, setResetPwdUser] = useState<UserWithActive | null>(null);
  const [resetPwdForm] = Form.useForm();

  // SECURITY §3.1：两张表单各自的强度计实时读密码字段（字段级订阅，
  // 不让整页跟着每次击键重渲染）。
  const formWatchedPassword = Form.useWatch('password', createForm) as
    | string
    | undefined;
  const resetPwdWatchedPassword = Form.useWatch('newPassword', resetPwdForm) as
    | string
    | undefined;

  const roleLabels = ROLE_LABELS(t);

  // P1-1：自己那行的启用开关置灰（后端 400 USER_SELF_DISABLE_FORBIDDEN 兜底）
  const currentUserId = useAuthStore((s) => s.user)?.id;

  // USER-SEARCH-01：搜索走**后端** search 参数（username/email ILIKE 模糊匹配）
  // ——原先在前端 filter 当页数据，用户数超过一页时搜索结果不完整且误导
  // （total 还是全量数）。输入防抖 300ms，翻页/搜索互不拖累。
  const debouncedSearch = useDebounce(searchText);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['users', page, pageSize, debouncedSearch],
    queryFn: ({ signal }) =>
      usersApi.list(page, pageSize, signal, debouncedSearch || undefined),
  });

  const users: UserWithActive[] = data?.list ?? [];
  const total: number = data?.total ?? 0;

  // URL-SYNC-02（审计 P2）：双向同步——外部深链/前进后退现在会真正生效。
  // 此前只有「初始值读 URL + 单向回写」，组件已挂载时改 URL 会被回写抹掉。
  useUrlStateSync(
    { page, pageSize, q: debouncedSearch },
    { page: 1, pageSize: 20, q: '' },
    { page: setPage, pageSize: setPageSize, q: setSearchText },
  );

  // Reset to page 1 when search text changes（后端按新 search 重新分页）
  const handleSearch = (val: string) => { setSearchText(val); setPage(1); };

  const createMutation = useMutation({
    mutationFn: (dto: CreateUserDto) => usersApi.create(dto),
    onSuccess: () => {
      message.success(t('users.created'));
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setCreateModalOpen(false);
      createForm.resetFields();
    },
    onError: (err: unknown) => {
      showApiError(err, t('users.createFail'));
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, dto }: { id: number; dto: UpdateUserDto }) =>
      usersApi.update(id, dto),
    onSuccess: () => {
      message.success(t('users.updated'));
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setCreateModalOpen(false);
      createForm.resetFields();
    },
    onError: (err: unknown) => {
      showApiError(err, t('users.updateFail'));
    },
  });

  // P1-1 前端配套：启用/禁用落库（PATCH /users/:id { isActive }）。
  // 后端禁用即 bump sessionVersion——在途 JWT 即刻 401；API-Key 由 per-request
  // 属主闸（owner_inactive）拒绝。两个即时失效面都写进了禁用确认文案。
  // 成功后失效 ['users']：状态列 Tag 与开关即时回正（口径同 create/update）。
  const setActiveMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      usersApi.update(id, { isActive }),
    // i18n-key-check：t() 只收静态字面量键（动态键须登记 baseline）——
    // 按方向拆成静态调用而不是三元串键。
    onSuccess: (_data, vars) => {
      if (vars.isActive) message.success(t('users.enableSuccess'));
      else message.success(t('users.disableSuccess'));
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: unknown, vars) => {
      if (vars.isActive) showApiError(err, t('users.enableFail'));
      else showApiError(err, t('users.disableFail'));
    },
  });

  /**
   * 开关翻转入口：禁用弹二次确认（影响性动作：该用户所有登录会话与 API-Key
   * 立即失效，可随时重新启用），启用直接生效。
   *
   * UI-15 同款（EventSubscriptionsSettings.handleReplay）：onOk 返回的 Promise
   * 会被确认弹层 await，rejection 需有终点——onError 已 toast，这里吞掉防
   * unhandled rejection。
   */
  const toggleActive = useCallback(
    (user: UserWithActive, next: boolean) => {
      if (next) {
        setActiveMutation.mutate({ id: user.id, isActive: true });
        return;
      }
      confirmModal.confirm({
        title: t('users.disableConfirm'),
        content: t('users.disableConfirmDesc', { name: user.username }),
        okText: t('users.action.disable'),
        okButtonProps: { danger: true },
        cancelText: t('users.cancel'),
        onOk: async () => {
          try {
            await setActiveMutation.mutateAsync({ id: user.id, isActive: false });
          } catch {
            /* toast 已由 onError 呈现 */
          }
        },
      });
    },
    [setActiveMutation, t],
  );

  const deleteMutation = useMutation({
    mutationFn: (id: number) => usersApi.remove(id),
    onSuccess: () => {
      message.success(t('users.deleted'));
      // 空页钳制（一致性）：服务端分页下删除当前页最后一条后 page 状态不变，
      // 请求仍打在第 N 页返回空列表——antd 只钳制分页器显示，表格主体仍是空页。
      // 本页只剩一条且不在第 1 页时回退一页（page-1 必然是满页）。
      if (users.length === 1 && page > 1) setPage(page - 1);
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: unknown) => {
      showApiError(err, t('users.deleteFail'));
    },
  });

  /**
   * R138-A1（数据层审计）：重置密码**故意不失效** ['users']。
   *
   * 判定依据（不是漏写）：本表展示的列是 username / email / role / isActive /
   * createdAt —— 后端改密码不会改动其中任何一个，失效只会白白触发一次列表
   * 重取（且会把用户正在看的第 N 页翻新）。同源判定见 queries.ts
   * invalidateExecutorData 的"删除执行器不联动任务面"。
   *
   * 前提条件（若日后改这里，先看这条）：一旦表格新增 updatedAt /
   * mustChangePassword / lastPasswordChangeAt 之类的列，本 mutation 必须补
   * `queryClient.invalidateQueries({ queryKey: ['users'] })`，否则该列会静默滞后。
   */
  const resetPwdMutation = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      usersApi.update(id, { password }),
    onSuccess: () => {
      message.success(t('users.pwdReset'));
      setResetPwdModalOpen(false);
      resetPwdForm.resetFields();
    },
    onError: (err: unknown) => {
      showApiError(err, t('users.pwdResetFail'));
    },
  });

  const openCreate = useCallback(() => {
    setEditing(null);
    createForm.resetFields();
    setCreateModalOpen(true);
  }, [createForm]);

  const openEdit = useCallback(
    (user: UserWithActive) => {
      setEditing(user);
      createForm.setFieldsValue({
        username: user.username,
        email: user.email,
        role: user.role,
      });
      setCreateModalOpen(true);
    },
    [createForm],
  );

  const handleCreateSubmit = useCallback(() => {
    // UI-15：validateFields 的 rejection 必须有消费方——校验失败由 Form 自带
    // 红字呈现（isFormValidationError 分支静默），其余异常兜底 toast，
    // 消除 QA-03 记录的 unhandled rejection 前科。
    createForm
      .validateFields()
      .then((values) => {
        if (editing) {
          const dto: UpdateUserDto = {
            username: values.username,
            email: values.email,
            role: values.role,
          };
          updateMutation.mutate({ id: editing.id, dto });
        } else {
          createMutation.mutate(values as CreateUserDto);
        }
      })
      .catch((err: unknown) => {
        if (isFormValidationError(err)) return;
        showApiError(err, t('users.submitFail'));
      });
  }, [createForm, editing, createMutation, updateMutation, t]);

  const handleResetPwd = useCallback(
    (user: UserWithActive) => {
      setResetPwdUser(user);
      resetPwdForm.resetFields();
      setResetPwdModalOpen(true);
    },
    [resetPwdForm],
  );

  const handleResetPwdSubmit = useCallback(() => {
    // UI-15：同 handleCreateSubmit——校验 rejection 有消费方，非校验异常兜底 toast。
    resetPwdForm
      .validateFields()
      .then((values) => {
        if (!resetPwdUser) return;
        resetPwdMutation.mutate({
          id: resetPwdUser.id,
          password: values.newPassword,
        });
      })
      .catch((err: unknown) => {
        if (isFormValidationError(err)) return;
        showApiError(err, t('users.submitFail'));
      });
  }, [resetPwdForm, resetPwdUser, resetPwdMutation, t]);

  // MOBILE-CARD-01：≤768px 表格 → 卡片列表
  const isMobile = useIsMobile();
  const columns = [
    {
      title: t('users.col.username'),
      dataIndex: 'username',
      key: 'username',
      width: 160,
      ellipsis: true,
      render: (text: string) => <strong>{text}</strong>,
    },
{
        title: t('users.col.email'),
        dataIndex: 'email',
        key: 'email',
        width: 250,
        ellipsis: true,
        render: (text: string) =>
          text || <span style={{ color: token.colorTextQuaternary }}>—</span>,
      },
    {
      title: t('users.col.role'),
      dataIndex: 'role',
      key: 'role',
      width: 100,
      render: (role: string) => (
        <Tag color={ROLE_COLORS[role] ?? 'default'}>
          {roleLabels[role] ?? role}
        </Tag>
      ),
    },
    {
      // P1-1：状态列补行内启用/禁用开关（对齐 TaskListPage 行内启停形态）。
      // 开关与 Tag 并排：Tag 是状态展示（口径不变），Switch 是操作入口——
      // 两者读同一字段，状态天然一致；成功后统一失效 ['users'] 回正。
      title: t('users.col.status'),
      dataIndex: 'isActive',
      key: 'isActive',
      width: 130,
      render: (isActive: boolean | undefined, record: UserWithActive) => (
        <Space size={6}>
          <UserActiveSwitch
            user={record}
            busy={
              setActiveMutation.isPending &&
              setActiveMutation.variables?.id === record.id
            }
            isSelf={record.id === currentUserId}
            onToggle={toggleActive}
          />
          {isActive === false ? (
            <Tag color="orange">{t('users.status.disabled')}</Tag>
          ) : (
            <Tag color="green">{t('users.status.active')}</Tag>
          )}
        </Space>
      ),
    },
    {
      title: t('users.col.createdAt'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      // 空/非法值由 formatDateTime 统一兜底为 '—'（原 hour12:false 收敛进共享
      // 设施后，en 界面回到 en-US 惯用的 12 小时 AM/PM 排版，与其它已统一页面一致）
      render: (v: string) => formatDateTime(v),
    },
    {
      title: t('users.col.actions'),
      key: 'actions',
      // UI 打磨：编辑/重置密码/删除三个带文字按钮合计 ~230px，原无宽度与
      // email 列抢空间导致按钮组换行；fixed right + scroll.x 成对
      width: 240,
      fixed: 'right' as const,
      render: (_: unknown, record: UserWithActive) => (
        <Space size="small">
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => openEdit(record)}
          >
            {t('users.action.edit')}
          </Button>
          <Button
            type="link"
            size="small"
            icon={<LockOutlined />}
            onClick={() => handleResetPwd(record)}
          >
            {t('users.action.resetPwd')}
          </Button>
          <Popconfirm
            title={t('users.deleteConfirm')}
            description={t('users.deleteConfirmDesc', { name: record.username })}
            onConfirm={() => deleteMutation.mutate(record.id)}
            okText={t('users.action.delete')}
            cancelText={t('users.cancel')}
            okButtonProps={{ danger: true }}
          >
            {/* 防重复提交+在途反馈：删除请求飞行中该行按钮置 loading（antd loading
                同时禁用点击），避免连点触发第二次 remove（第二次必然 404 报错噪音）。
                口径对齐 ProjectsPage 成员移除按钮（mutation.variables 精确到行）。 */}
            <Button
              type="link"
              size="small"
              danger
              icon={<DeleteOutlined />}
              loading={deleteMutation.isPending && deleteMutation.variables === record.id}
            >
              {t('users.action.delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    // UI 打磨：去掉页级 padding 24——MainLayout Content 已有 20/24 内边距，
    // 此前双重缩进使本页比其它列表页多一圈 48px，同类页面观感不一致
    <div>
      {/* UI-03/UI-08：页头标准化（原 Title 区块迁入 PageHeader） */}
      <PageHeader title={t('users.title')} description={t('users.description')} />
      <Card>
        <Row gutter={16} style={{ marginBottom: 16 }} align="middle">
          <Col flex="auto">
            <Input
              placeholder={t('users.searchPlaceholder')}
              prefix={<SearchOutlined />}
              allowClear
              value={searchText}
              onChange={(e) => handleSearch(e.target.value)}
              style={{ maxWidth: 300 }}
            />
          </Col>
          <Col>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={openCreate}
            >
              {t('users.create')}
            </Button>
          </Col>
        </Row>
        {/* UI-16：列表请求失败不再只弹 toast —— 页内原位呈现错误块 + 重试入口
            （新建/禁用等 mutation 失败仍走 toast，语义不变） */}
        {error ? (
          <StateError
            error={error}
            title={t('users.error.title')}
            onRetry={() => void refetch()}
            style={{ marginBottom: 16 }}
          />
        ) : null}
          {isMobile ? (
            /* MOBILE-CARD-01：≤768px 卡片列表——6 列定宽表格在 375px 需横向滚动。
               卡片按首查信息组织：用户名+角色·状态 / 邮箱 / 创建时间 / 操作。 */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {users.length === 0 ? (
                isLoading
                  ? <PageSkeleton variant="table" rows={4} />
                  : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={debouncedSearch ? t('users.empty.noMatch') : t('users.empty.none')} />
              ) : (
                users.map((record: UserWithActive) => (
                  <Card key={record.id} size="small">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <Typography.Text strong style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{record.username}</Typography.Text>
                      <Space size={4}>
                        <Tag color={ROLE_COLORS[record.role] ?? 'default'} style={{ marginInlineEnd: 0 }}>{roleLabels[record.role] ?? record.role}</Tag>
                        {record.isActive === false
                          ? <Tag color="orange" style={{ marginInlineEnd: 0 }}>{t('users.status.disabled')}</Tag>
                          : <Tag color="green" style={{ marginInlineEnd: 0 }}>{t('users.status.active')}</Tag>}
                      </Space>
                    </div>
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--chart-axis-text)' }}>
                      {record.email || '—'}
                    </div>
                    <div style={{ marginTop: 4, fontSize: 12, color: 'var(--chart-axis-text)' }}>
                      {t('users.col.createdAt_colon')}{formatDateTime(record.createdAt)}
                    </div>
                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                      {/* P1-1：卡片同款启用/禁用开关——MOBILE-CARD-01 功能对等口径，
                          与桌面共用 UserActiveSwitch（确认弹窗/自禁置灰逻辑单源） */}
                      <UserActiveSwitch
                        user={record}
                        busy={
                          setActiveMutation.isPending &&
                          setActiveMutation.variables?.id === record.id
                        }
                        isSelf={record.id === currentUserId}
                        onToggle={toggleActive}
                      />
                      <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>
                        {t('users.action.edit')}
                      </Button>
                      <Button type="link" size="small" icon={<LockOutlined />} onClick={() => handleResetPwd(record)}>
                        {t('users.action.resetPwd')}
                      </Button>
                      <Popconfirm
                        title={t('users.deleteConfirm')}
                        description={t('users.deleteConfirmDesc', { name: record.username })}
                        onConfirm={() => deleteMutation.mutate(record.id)}
                        okText={t('users.action.delete')}
                        cancelText={t('users.cancel')}
                        okButtonProps={{ danger: true }}
                      >
                        {/* 同桌面口径：删除在途该行按钮 loading（防重复提交） */}
                        <Button type="link" size="small" danger icon={<DeleteOutlined />}
                          loading={deleteMutation.isPending && deleteMutation.variables === record.id}>
                          {t('users.action.delete')}
                        </Button>
                      </Popconfirm>
                    </div>
                  </Card>
                ))
              )}
            </div>
          ) : (
          <Table
            rowKey="id"
            columns={columns}
            dataSource={users}
            // UI 打磨：loading 直传——此前恒 false，refetch 期间无任何反馈；
            // emptyText 首屏骨架保留（UI-08 语义不变）
            loading={isLoading}
            // P1-1：状态列 80→130（Switch+Tag 并排），scroll.x 成对 +50
            scroll={{ x: 1060 }}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              showTotal: (totalCount) =>
                t('users.count', { count: totalCount }),
              onChange: (p, ps) => {
                setPage(p);
                setPageSize(ps);
              },
            }}
            locale={{
              // UI-08：首屏（无数据加载中）以骨架屏替代表格 Spin
              emptyText: isLoading
                ? <PageSkeleton variant="table" rows={4} />
                : (debouncedSearch ? t('users.empty.noMatch') : t('users.empty.none')),
            }}
          />
          )}
      </Card>

      <Modal
        title={editing ? t('users.modal.edit') : t('users.modal.create')}
        open={createModalOpen}
        onOk={handleCreateSubmit}
        onCancel={() => {
          setCreateModalOpen(false);
          createForm.resetFields();
        }}
        confirmLoading={createMutation.isPending || updateMutation.isPending}
        okText={editing ? t('users.ok.save') : t('users.ok.create')}
        cancelText={t('users.cancel')}
        destroyOnHidden
      >
        <Form
          form={createForm}
          layout="vertical"
          style={{ marginTop: 16 }}
          autoComplete="off"
        >
          <Form.Item
            name="username"
            label={t('users.field.username')}
            rules={[
              { required: true, message: t('users.field.usernameRequired') },
              { min: 2, message: t('users.field.usernameMin') },
              // F-18（UIAUDIT P3-11）：镜像后端 CreateUserDto @MaxLength(128)
              // （entity DB-006 varchar(128)），超限不再提交后才吃裸 400。
              { max: 128, message: t('users.field.usernameMax') },
            ]}
          >
            <Input placeholder={t('users.field.usernamePlaceholder')} />
          </Form.Item>
          {!editing && (
            <>
              <Form.Item
                name="password"
                label={t('users.field.password')}
                // SECURITY §3.1：此前这里内联 `/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)
                // (?=.*[^a-zA-Z\d])/`——**比后端更严**（多要求小写字母），会拒绝
                // 后端本可接受的密码（如 ADMIN2026!）。现统一走 utils/passwordPolicy
                // 的单条合取正则（后端策略的语义镜像，由守卫逐字符核验）。
                rules={[
                  { required: true, message: t('users.field.passwordRequired') },
                  { min: PASSWORD_MIN_LENGTH, message: t('users.field.passwordMin') },
                  {
                    pattern: PASSWORD_POLICY_PATTERN,
                    message: t('users.field.passwordPattern'),
                  },
                ]}
              >
                <Input.Password
                  placeholder={t('users.field.passwordPlaceholder')}
                  autoComplete="new-password"
                />
              </Form.Item>
              {/* 实时强度 + 逐条规则清单（不合规时明确告知"提交会被后端拒绝"） */}
              <div style={{ marginTop: -16, marginBottom: 12 }}>
                <PasswordStrengthMeter
                  password={(formWatchedPassword as string | undefined) ?? ''}
                  idPrefix="pwd-create"
                />
              </div>
            </>
          )}
          <Form.Item
            name="email"
            label={t('users.field.email')}
            // P1-4（生产审查）：与后端契约对齐（admin-api users DTO）——
            // create-user.dto.ts 的 email 为 @IsEmail() 必填（此前新建态零校验，
            // 必填拦截只弹原始 400 toast）；update-user.dto.ts 是
            // PartialType(CreateUserDto)：选填，但填了必须格式合法。
            rules={
              editing
                ? [{ type: 'email', message: t('users.field.emailInvalid') }]
                : [
                    { required: true, message: t('users.field.emailRequired') },
                    { type: 'email', message: t('users.field.emailInvalid') },
                  ]
            }
          >
            {/* 新建态后端必填，「选填」占位符只在编辑态成立 */}
            <Input placeholder={editing ? t('users.field.emailPlaceholder') : undefined} type="email" />
          </Form.Item>
          <Form.Item
            name="role"
            label={t('users.field.role')}
            initialValue="user"
          >
            <Select>
              <Option value="user">{t('users.role.user')}</Option>
              <Option value="admin">{t('users.role.admin')}</Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('users.resetPwd.title', { name: resetPwdUser?.username ?? '' })}
        open={resetPwdModalOpen}
        onOk={handleResetPwdSubmit}
        onCancel={() => {
          setResetPwdModalOpen(false);
          resetPwdForm.resetFields();
        }}
        confirmLoading={resetPwdMutation.isPending}
        okText={t('users.resetPwd.ok')}
        cancelText={t('users.cancel')}
        destroyOnHidden
      >
        <Form
          form={resetPwdForm}
          layout="vertical"
          style={{ marginTop: 16 }}
          autoComplete="off"
        >
          <Form.Item
            name="newPassword"
            label={t('users.resetPwd.newPassword')}
            rules={[
              { required: true, message: t('users.resetPwd.newPasswordRequired') },
              { min: PASSWORD_MIN_LENGTH, message: t('users.resetPwd.newPasswordMin') },
              {
                pattern: PASSWORD_POLICY_PATTERN,
                message: t('users.field.passwordPattern'),
              },
            ]}
          >
            <Input.Password
              placeholder={t('users.resetPwd.newPasswordPlaceholder')}
              autoComplete="new-password"
            />
          </Form.Item>
          <div style={{ marginTop: -16, marginBottom: 12 }}>
            <PasswordStrengthMeter
              password={(resetPwdWatchedPassword as string | undefined) ?? ''}
              idPrefix="pwd-reset"
            />
          </div>
          <Form.Item
            name="confirmPassword"
            label={t('users.resetPwd.confirm')}
            dependencies={['newPassword']}
            rules={[
              { required: true, message: t('users.resetPwd.confirmRequired') },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('newPassword') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(
                    new Error(t('users.resetPwd.mismatch')),
                  );
                },
              }),
            ]}
          >
            <Input.Password
              placeholder={t('users.resetPwd.confirmPlaceholder')}
              autoComplete="new-password"
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}