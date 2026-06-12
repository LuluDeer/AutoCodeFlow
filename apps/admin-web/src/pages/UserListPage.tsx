import { useState } from 'react';
import {
  Table, Button, Space, Popconfirm, Modal, Form, Input, Select, message, Tag,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, KeyOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usersApi, User, CreateUserDto, UpdateUserDto } from '../api/users';

const { Option } = Select;

export default function UserListPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [form] = Form.useForm();

  // Reset password modal state
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [resetForm] = Form.useForm();

  const { data, isLoading } = useQuery({
    queryKey: ['users', page],
    queryFn: () => usersApi.list(page, 20),
  });

  const createMutation = useMutation({
    mutationFn: (dto: CreateUserDto) => usersApi.create(dto),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['users'] }); message.success('创建成功'); setModalOpen(false); },
    onError: () => message.error('创建失败'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, dto }: { id: number; dto: UpdateUserDto }) => usersApi.update(id, dto),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['users'] }); message.success('更新成功'); setModalOpen(false); },
    onError: () => message.error('更新失败'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => usersApi.remove(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['users'] }); message.success('删除成功'); },
    onError: () => message.error('删除失败'),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      usersApi.update(id, { password }),
    onSuccess: () => {
      message.success('密码已重置');
      setResetModalOpen(false);
      resetForm.resetFields();
    },
    onError: () => message.error('重置密码失败'),
  });

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (user: User) => {
    setEditing(user);
    form.setFieldsValue({ username: user.username, email: user.email, role: user.role });
    setModalOpen(true);
  };

  const openResetPassword = (user: User) => {
    setResetTarget(user);
    resetForm.resetFields();
    setResetModalOpen(true);
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    if (editing) {
      const dto: UpdateUserDto = { username: values.username, email: values.email, role: values.role };
      if (values.password) dto.password = values.password;
      updateMutation.mutate({ id: editing.id, dto });
    } else {
      createMutation.mutate(values as CreateUserDto);
    }
  };

  const handleResetPassword = async () => {
    const values = await resetForm.validateFields();
    if (!resetTarget) return;
    resetPasswordMutation.mutate({ id: resetTarget.id, password: values.newPassword });
  };

  const roleColor: Record<string, string> = { admin: 'red', operator: 'blue', viewer: 'default' };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '用户名', dataIndex: 'username' },
    { title: '邮箱', dataIndex: 'email' },
    {
      title: '角色',
      dataIndex: 'role',
      render: (role: string) => <Tag color={roleColor[role] ?? 'default'}>{role}</Tag>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: '操作',
      render: (_: unknown, record: User) => (
        <Space>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => openEdit(record)}
          >
            编辑
          </Button>
          <Button
            size="small"
            icon={<KeyOutlined />}
            onClick={() => openResetPassword(record)}
          >
            重置密码
          </Button>
          <Popconfirm
            title="确认删除该用户？"
            onConfirm={() => deleteMutation.mutate(record.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>用户管理</h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建用户
        </Button>
      </div>

      <Table
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={data?.list}
        pagination={{
          current: page,
          pageSize: 20,
          total: data?.total,
          onChange: setPage,
          showTotal: t => `共 ${t} 条`,
        }}
      />

      {/* 新建 / 编辑用户 Modal */}
      <Modal
        title={editing ? '编辑用户' : '新建用户'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        confirmLoading={createMutation.isPending || updateMutation.isPending}
        destroyOnClose
      >
        <Form form={form} layout="vertical" autoComplete="off">
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="password"
            label={editing ? '新密码（留空不修改）' : '密码'}
            rules={editing ? [] : [{ required: true, message: '请输入密码' }]}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item name="role" label="角色" initialValue="viewer">
            <Select>
              <Option value="admin">管理员</Option>
              <Option value="operator">操作员</Option>
              <Option value="viewer">观察者</Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* 重置密码 Modal */}
      <Modal
        title={`重置密码 — ${resetTarget?.username ?? ''}`}
        open={resetModalOpen}
        onOk={handleResetPassword}
        onCancel={() => { setResetModalOpen(false); resetForm.resetFields(); }}
        confirmLoading={resetPasswordMutation.isPending}
        okText="确认重置"
        okButtonProps={{ danger: true }}
        destroyOnClose
      >
        <Form form={resetForm} layout="vertical" autoComplete="off">
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 6, message: '密码至少 6 位' },
            ]}
          >
            <Input.Password placeholder="请输入新密码" />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('newPassword') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('两次密码不一致'));
                },
              }),
            ]}
          >
            <Input.Password placeholder="请再次输入新密码" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
