import { useState, useCallback } from 'react';
import {
  Table,
  Button,
  Space,
  Modal,
  Form,
  Input,
  Select,
  Tag,
  Popconfirm,
  message,
  Card,
  Row,
  Col,
} from 'antd';
import {
  PlusOutlined,
  SearchOutlined,
  LockOutlined,
  DeleteOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usersApi, type User, type CreateUserDto, type UpdateUserDto } from '../api/users';
import { getErrMsg, isFormValidationError } from '../utils/error';
import { useTranslation } from 'react-i18next';
import PageHeader from '../components/PageHeader';
import StateError from '../components/StateError';
import PageSkeleton from '../components/PageSkeleton';
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

export default function UserManagementPage() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [searchText, setSearchText] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editing, setEditing] = useState<UserWithActive | null>(null);
  const [createForm] = Form.useForm();
  const [resetPwdModalOpen, setResetPwdModalOpen] = useState(false);
  const [resetPwdUser, setResetPwdUser] = useState<UserWithActive | null>(null);
  const [resetPwdForm] = Form.useForm();

  const roleLabels = ROLE_LABELS(t);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['users', page, pageSize],
    queryFn: () => usersApi.list(page, pageSize),
  });

  const users: UserWithActive[] = data?.list ?? [];
  const total: number = data?.total ?? 0;

  const filteredUsers = searchText
    ? users.filter(
        (u) =>
          u.username.toLowerCase().includes(searchText.toLowerCase()) ||
          (u.email ?? '').toLowerCase().includes(searchText.toLowerCase()),
      )
    : users;
  // Reset to page 1 when search text changes
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
      message.error(getErrMsg(err, t('users.createFail')));
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
      message.error(getErrMsg(err, t('users.updateFail')));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => usersApi.remove(id),
    onSuccess: () => {
      message.success(t('users.deleted'));
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: unknown) => {
      message.error(getErrMsg(err, t('users.deleteFail')));
    },
  });

  const resetPwdMutation = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      usersApi.update(id, { password }),
    onSuccess: () => {
      message.success(t('users.pwdReset'));
      setResetPwdModalOpen(false);
      resetPwdForm.resetFields();
    },
    onError: (err: unknown) => {
      message.error(getErrMsg(err, t('users.pwdResetFail')));
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
        message.error(getErrMsg(err, t('users.submitFail')));
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
        message.error(getErrMsg(err, t('users.submitFail')));
      });
  }, [resetPwdForm, resetPwdUser, resetPwdMutation, t]);

  const columns = [
    {
      title: t('users.col.username'),
      dataIndex: 'username',
      key: 'username',
      render: (text: string) => <strong>{text}</strong>,
    },
    {
      title: t('users.col.email'),
      dataIndex: 'email',
      key: 'email',
      ellipsis: true,
      render: (text: string) =>
        text || <span style={{ color: '#bbb' }}>—</span>,
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
      title: t('users.col.status'),
      dataIndex: 'isActive',
      key: 'isActive',
      width: 80,
      render: (isActive: boolean | undefined) =>
        isActive === false ? (
          <Tag color="orange">{t('users.status.disabled')}</Tag>
        ) : (
          <Tag color="green">{t('users.status.active')}</Tag>
        ),
    },
    {
      title: t('users.col.createdAt'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (v: string) =>
        v
          ? new Date(v).toLocaleString('zh-CN', { hour12: false })
          : '—',
    },
    {
      title: t('users.col.actions'),
      key: 'actions',
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
            <Button
              type="link"
              size="small"
              danger
              icon={<DeleteOutlined />}
            >
              {t('users.action.delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: '24px' }}>
      {/* UI-03/UI-08：页头标准化（原 Title 区块迁入 PageHeader） */}
      <PageHeader title={t('users.title')} description={t('users.description')} />
      <Card>
        <Row gutter={12} style={{ marginBottom: 16 }} align="middle">
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
          <Table
            rowKey="id"
            columns={columns}
            dataSource={filteredUsers}
            loading={false}
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
                : (searchText ? t('users.empty.noMatch') : t('users.empty.none')),
            }}
          />
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
            ]}
          >
            <Input placeholder={t('users.field.usernamePlaceholder')} />
          </Form.Item>
          {!editing && (
            <Form.Item
              name="password"
              label={t('users.field.password')}
              rules={[
                { required: true, message: t('users.field.passwordRequired') },
                { min: 8, message: t('users.field.passwordMin') },
                {
                  pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z\d])/,
                  message: t('users.field.passwordPattern'),
                },
              ]}
            >
              <Input.Password
                placeholder={t('users.field.passwordPlaceholder')}
                autoComplete="new-password"
              />
            </Form.Item>
          )}
          <Form.Item
            name="email"
            label={t('users.field.email')}
            rules={
              editing
                ? [{ type: 'email', message: t('users.field.emailInvalid') }]
                : []
            }
          >
            <Input placeholder={t('users.field.emailPlaceholder')} type="email" />
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
              { min: 8, message: t('users.resetPwd.newPasswordMin') },
              {
                pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z\d])/,
                message: t('users.field.passwordPattern'),
              },
            ]}
          >
            <Input.Password
              placeholder={t('users.resetPwd.newPasswordPlaceholder')}
              autoComplete="new-password"
            />
          </Form.Item>
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