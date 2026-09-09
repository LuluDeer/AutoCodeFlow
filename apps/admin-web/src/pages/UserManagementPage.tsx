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
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';

const { Option } = Select;

const ROLE_COLORS: Record<string, string> = {
  admin: 'red',
  user: 'blue',
};

const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  user: '普通用户',
};

interface UserWithActive extends User {
  isActive?: boolean;
}

export default function UserManagementPage() {
  const queryClient = useQueryClient();
  const [searchText, setSearchText] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editing, setEditing] = useState<UserWithActive | null>(null);
  const [createForm] = Form.useForm();
  const [resetPwdModalOpen, setResetPwdModalOpen] = useState(false);
  const [resetPwdUser, setResetPwdUser] = useState<UserWithActive | null>(null);
  const [resetPwdForm] = Form.useForm();

  const { data, isLoading } = useQuery({
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
      message.success('用户创建成功');
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setCreateModalOpen(false);
      createForm.resetFields();
    },
    onError: (err: unknown) => {
      message.error(getErrMsg(err, '创建失败'));
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, dto }: { id: number; dto: UpdateUserDto }) =>
      usersApi.update(id, dto),
    onSuccess: () => {
      message.success('更新成功');
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setCreateModalOpen(false);
      createForm.resetFields();
    },
    onError: (err: unknown) => {
      message.error(getErrMsg(err, '更新失败'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => usersApi.remove(id),
    onSuccess: () => {
      message.success('用户已删除');
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: unknown) => {
      message.error(getErrMsg(err, '删除失败'));
    },
  });

  const resetPwdMutation = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      usersApi.update(id, { password }),
    onSuccess: () => {
      message.success('密码已重置');
      setResetPwdModalOpen(false);
      resetPwdForm.resetFields();
    },
    onError: (err: unknown) => {
      message.error(getErrMsg(err, '重置密码失败'));
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
        message.error(getErrMsg(err, '提交失败，请检查表单后重试'));
      });
  }, [createForm, editing, createMutation, updateMutation]);

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
        message.error(getErrMsg(err, '提交失败，请检查表单后重试'));
      });
  }, [resetPwdForm, resetPwdUser, resetPwdMutation]);

  const columns = [
    {
      title: '用户名',
      dataIndex: 'username',
      key: 'username',
      render: (text: string) => <strong>{text}</strong>,
    },
    {
      title: '邮箱',
      dataIndex: 'email',
      key: 'email',
      ellipsis: true,
      render: (text: string) =>
        text || <span style={{ color: '#bbb' }}>—</span>,
    },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      width: 100,
      render: (role: string) => (
        <Tag color={ROLE_COLORS[role] ?? 'default'}>
          {ROLE_LABELS[role] ?? role}
        </Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'isActive',
      key: 'isActive',
      width: 80,
      render: (isActive: boolean | undefined) =>
        isActive === false ? (
          <Tag color="orange">已禁用</Tag>
        ) : (
          <Tag color="green">正常</Tag>
        ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (v: string) =>
        v
          ? new Date(v).toLocaleString('zh-CN', { hour12: false })
          : '—',
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, record: UserWithActive) => (
        <Space size="small">
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => openEdit(record)}
          >
            编辑
          </Button>
          <Button
            type="link"
            size="small"
            icon={<LockOutlined />}
            onClick={() => handleResetPwd(record)}
          >
            重置密码
          </Button>
          <Popconfirm
            title="确认删除"
            description={`确定要删除用户「${record.username}」吗？此操作不可撤销。`}
            onConfirm={() => deleteMutation.mutate(record.id)}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
          >
            <Button
              type="link"
              size="small"
              danger
              icon={<DeleteOutlined />}
            >
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: '24px' }}>
      {/* UI-03/UI-08：页头标准化（原 Title 区块迁入 PageHeader） */}
      <PageHeader title="用户管理" description="账号、角色与密码管理（仅管理员）。" />
      <Card>
        <Row gutter={12} style={{ marginBottom: 16 }} align="middle">
          <Col flex="auto">
            <Input
              placeholder="搜索用户名或邮箱"
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
              新建用户
            </Button>
          </Col>
        </Row>
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
              showTotal: (t) =>
                `共 ${t.toLocaleString()} 条`,
              onChange: (p, ps) => {
                setPage(p);
                setPageSize(ps);
              },
            }}
            locale={{
              // UI-08：首屏（无数据加载中）以骨架屏替代表格 Spin
              emptyText: isLoading
                ? <PageSkeleton variant="table" rows={4} />
                : (searchText ? '没有匹配的用户' : '暂无用户'),
            }}
          />
      </Card>

      <Modal
        title={editing ? '编辑用户' : '新建用户'}
        open={createModalOpen}
        onOk={handleCreateSubmit}
        onCancel={() => {
          setCreateModalOpen(false);
          createForm.resetFields();
        }}
        confirmLoading={createMutation.isPending || updateMutation.isPending}
        okText={editing ? '保存' : '创建'}
        cancelText="取消"
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
            label="用户名"
            rules={[
              { required: true, message: '请输入用户名' },
              { min: 2, message: '用户名至少2个字符' },
            ]}
          >
            <Input placeholder="请输入用户名" />
          </Form.Item>
          {!editing && (
            <Form.Item
              name="password"
              label="密码"
              rules={[
                { required: true, message: '请输入密码' },
                { min: 8, message: '密码至少8个字符' },
                {
                  pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z\d])/,
                  message: '密码须包含大写字母、小写字母、数字和特殊符号',
                },
              ]}
            >
              <Input.Password
                placeholder="请输入密码"
                autoComplete="new-password"
              />
            </Form.Item>
          )}
          <Form.Item
            name="email"
            label="邮箱"
            rules={
              editing
                ? [{ type: 'email', message: '请输入有效邮箱' }]
                : []
            }
          >
            <Input placeholder="选填" type="email" />
          </Form.Item>
          <Form.Item
            name="role"
            label="角色"
            initialValue="user"
          >
            <Select>
              <Option value="user">普通用户</Option>
              <Option value="admin">管理员</Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`重置密码 — ${resetPwdUser?.username ?? ''}`}
        open={resetPwdModalOpen}
        onOk={handleResetPwdSubmit}
        onCancel={() => {
          setResetPwdModalOpen(false);
          resetPwdForm.resetFields();
        }}
        confirmLoading={resetPwdMutation.isPending}
        okText="确认重置"
        cancelText="取消"
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
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 8, message: '密码至少8个字符' },
              {
                pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z\d])/,
                message: '密码须包含大写字母、小写字母、数字和特殊符号',
              },
            ]}
          >
            <Input.Password
              placeholder="请输入新密码"
              autoComplete="new-password"
            />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请确认密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('newPassword') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(
                    new Error('两次密码不一致'),
                  );
                },
              }),
            ]}
          >
            <Input.Password
              placeholder="再次输入新密码"
              autoComplete="new-password"
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
