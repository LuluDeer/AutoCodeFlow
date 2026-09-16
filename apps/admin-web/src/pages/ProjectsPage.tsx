import { useMemo, useState } from 'react';
import {
  Button, Drawer, Form, Select, Space, Table, Tag, Typography, message,
} from 'antd';
import { TeamOutlined, UserAddOutlined, DeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { projectsApi, type ProjectRole, type ProjectViewRow } from '../api/projects';
import { usersApi } from '../api/users';
import { isAdminUser, useAuthStore } from '../store/auth';
import { getErrMsg } from '../utils/error';
import { formatDateTime } from '../utils/timeFormat';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';
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
  const user = useAuthStore((s) => s.user);
  const isAdmin = isAdminUser(user);

  const [membersProject, setMembersProject] = useState<ProjectViewRow | null>(null);

  // 列表：后端已按主体过滤，前端零额外处理
  const projectsQuery = useQuery({
    queryKey: ['projects', 'list'],
    queryFn: () => projectsApi.list(),
  });

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
            icon={<TeamOutlined />}
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
      <Table
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={projectsQuery.data ?? []}
        scroll={{ x: 880 }}
        pagination={false}
      />
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
  const queryClient = useQueryClient();
  const [addForm] = Form.useForm<{ userId: number; role: ProjectRole }>();
  const [messageApi, contextHolder] = message.useMessage();
  const open = project !== null;

  const membersQuery = useQuery({
    queryKey: ['projects', 'members', project?.id],
    queryFn: () => projectsApi.getMembers(project!.id),
    enabled: open,
  });

  // ADMIN 的添加成员表单需要可选用户清单（/users 为 ADMIN-only 端点，
  // 打开 Drawer 且 isAdmin 时才拉取）
  const usersQuery = useQuery({
    queryKey: ['projects', 'candidate-users'],
    queryFn: () => usersApi.list(1, 200),
    enabled: open && isAdmin,
  });

  const invalidate = () => {
    if (project) {
      void queryClient.invalidateQueries({
        queryKey: ['projects', 'members', project.id],
      });
    }
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
    <Drawer
      title={
        project
          ? t('projects.members.title', { name: project.name })
          : t('projects.members.title', { name: '' })
      }
      size="large"
      open={open}      onClose={onClose}
      destroyOnClose
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
                        icon={<DeleteOutlined />}
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
          <Form.Item
            name="userId"
            label={t('projects.members.userId')}
            rules={[{ required: true, message: t('projects.members.userIdRequired') }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder={t('projects.members.userIdPlaceholder')}
              options={(usersQuery.data?.list ?? []).map((u) => ({
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
              icon={<UserAddOutlined />}
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
