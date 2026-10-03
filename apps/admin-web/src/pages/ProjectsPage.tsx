import { useEffect, useMemo, useState } from 'react';
import {
  Button, Card, Drawer, Empty, Form, Pagination, Select, Space, Table, Tag, Typography, message,
} from 'antd';
import { TeamOutlined, UserAddOutlined, DeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { projectsApi, type ProjectRole, type ProjectViewRow } from '../api/projects';
import { queryKeys } from '../api/queries';
import { usersApi } from '../api/users';
import { isAdminUser, useAuthStore } from '../store/auth';
import { getErrMsg } from '../utils/error';
import { formatDateTime } from '../utils/timeFormat';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';
// UI-09 第三轮：≤768px 表格 → 卡片列表的结构级降级（对齐 TaskListPage/
// ApplicationListPage 的 MOBILE-CARD-01 先例；断点与 index.css ui09 媒体查询同值）
import { useIsMobile } from '../hooks/useIsMobile';
import '../i18n';

const { Text } = Typography;

/**
 * AUTH-02 后续：项目管理页。
 *
 * 列表读面与后端一致（ADMIN 全量 / 普通用户「默认项目 ∪ 成员项目」），
 * 每行「我的角色」徽标来自 myRole。成员管理 Drawer：ADMIN 可增删改角色
 * （后端成员写面 ADMIN-only），普通用户只读——既有 RequireAdmin 形态在此
 * 不适用（路由本身全员可达），改用 isAdminUser 门控操作区渲染。
 */

type TFn = (k: string) => string;

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

export default function ProjectsPage() {
  const { t } = useTranslation();
  // UI-09 第三轮：≤768px 结构级降级开关（表格→卡片）
  const isMobile = useIsMobile();
  const user = useAuthStore((s) => s.user);
  const isAdmin = isAdminUser(user);

  const [membersProject, setMembersProject] = useState<ProjectViewRow | null>(null);

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

  const columns = useMemo(
    () => [
      // UI 打磨：name 弹性列不设宽；描述单行 ellipsis（tooltip 看全文）；
      // 时间/角色固定宽防折行；操作列 fixed right + scroll.x 窄屏横向滚动
      { title: t('projects.col.name'), dataIndex: 'name', key: 'name' },
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
        width: 90,
        fixed: 'right' as const,
        render: (_: unknown, row: ProjectViewRow) => (
          <Button
            size="small"
            icon={<TeamOutlined aria-hidden />}
            onClick={() => setMembersProject(row)}
          >
            {t('projects.members.view')}
          </Button>
        ),
      },
    ],
    [t],
  );

  if (projectsQuery.isLoading) {
    return (
      <div>
        <PageHeader title={t('projects.title')} description={t('projects.description')} />
        <PageSkeleton variant="table" />
      </div>
    );
  }
  if (projectsQuery.error) {
    return (
      <div>
        <PageHeader title={t('projects.title')} description={t('projects.description')} />
        <StateError error={projectsQuery.error} onRetry={() => void projectsQuery.refetch()} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={t('projects.title')} description={t('projects.description')} />
      {/* UI-09 第三轮：≤768px 卡片列表（MOBILE-CARD-01 同款结构级降级）——
          项目卡按首查信息组织：名称+我的角色 → 描述 → 创建时间 → 成员入口；
          桌面保留 5 列表格（fixed 操作列 + scroll.x）。服务端分页两侧共用
          同一 state（URL-SYNC-01 回写不变）。 */}
      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('projects.empty')} />
          ) : (
            rows.map((row) => (
              <Card key={row.id} size="small">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <Text strong ellipsis style={{ flex: 1, minWidth: 0 }}>{row.name}</Text>
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
                <div style={{ marginTop: 8 }}>
                  <Button
                    size="small"
                    icon={<TeamOutlined aria-hidden />}
                    onClick={() => setMembersProject(row)}
                  >
                    {t('projects.members.view')}
                  </Button>
                </div>
              </Card>
            ))
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
          scroll={{ x: 880 }}
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
  const queryClient = useQueryClient();
  const [addForm] = Form.useForm<{ userId: number; role: ProjectRole }>();
  const [messageApi, contextHolder] = message.useMessage();
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
      open={open}      onClose={onClose}
      destroyOnHidden
    >
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
    </Drawer>
  );
}
