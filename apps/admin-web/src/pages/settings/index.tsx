import React, { useState } from 'react';
import {
  Table, Button, Space, Popconfirm, Modal, Form, Input, Select, Switch, Tag, message,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { client } from '../../api/client';

const { Option } = Select;

export interface ConfigItem {
  key: string;
  value: string;
  description?: string;
  valueType: 'string' | 'number' | 'boolean' | 'json';
  isSecret: boolean;
  updatedAt: string;
}

export interface ConfigDto {
  key: string;
  value: string;
  description?: string;
  valueType: 'string' | 'number' | 'boolean' | 'json';
  isSecret: boolean;
}

const configApi = {
  list: () => client.get<ConfigItem[]>('/config'),
  upsert: (dto: ConfigDto) => client.put<ConfigItem>('/config', dto),
  remove: (key: string) => client.delete<{ deleted: boolean }>(`/config/${key}`),
};

const VALUE_TYPE_COLORS: Record<string, string> = {
  string: 'blue',
  number: 'green',
  boolean: 'orange',
  json: 'purple',
};

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ConfigItem | null>(null);
  const [form] = Form.useForm();

  const { data, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => configApi.list().then((r) => r as unknown as ConfigItem[]),
  });

  const upsertMutation = useMutation({
    mutationFn: (dto: ConfigDto) => configApi.upsert(dto),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config'] });
      message.success(editing ? '更新成功' : '新增成功');
      setModalOpen(false);
    },
    onError: () => message.error(editing ? '更新失败' : '新增失败'),
  });

  const deleteMutation = useMutation({
    mutationFn: (key: string) => configApi.remove(key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config'] });
      message.success('删除成功');
    },
    onError: () => message.error('删除失败'),
  });

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ valueType: 'string', isSecret: false });
    setModalOpen(true);
  };

  const openEdit = (item: ConfigItem) => {
    setEditing(item);
    form.setFieldsValue({
      key: item.key,
      value: item.value,
      description: item.description,
      valueType: item.valueType,
      isSecret: item.isSecret,
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    upsertMutation.mutate(values as ConfigDto);
  };

  const columns = [
    {
      title: 'Key',
      dataIndex: 'key',
      width: 200,
    },
    {
      title: 'Value',
      dataIndex: 'value',
      render: (v: string, record: ConfigItem) =>
        record.isSecret ? <span style={{ letterSpacing: 2 }}>****</span> : v,
    },
    {
      title: '描述',
      dataIndex: 'description',
      render: (v: string) => v || '-',
    },
    {
      title: '类型',
      dataIndex: 'valueType',
      width: 90,
      render: (v: string) => <Tag color={VALUE_TYPE_COLORS[v] ?? 'default'}>{v}</Tag>,
    },
    {
      title: '敏感',
      dataIndex: 'isSecret',
      width: 70,
      render: (v: boolean) => <Tag color={v ? 'red' : 'default'}>{v ? '是' : '否'}</Tag>,
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 180,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: '操作',
      width: 140,
      render: (_: unknown, record: ConfigItem) => (
        <Space>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => openEdit(record)}
          >
            编辑
          </Button>
          <Popconfirm
            title="确认删除该配置项？"
            onConfirm={() => deleteMutation.mutate(record.key)}
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
        <h2 style={{ margin: 0 }}>系统设置</h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增配置
        </Button>
      </div>

      <Table
        rowKey="key"
        loading={isLoading}
        columns={columns}
        dataSource={data}
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
      />

      <Modal
        title={editing ? '编辑配置' : '新增配置'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        confirmLoading={upsertMutation.isPending}
        destroyOnClose
      >
        <Form form={form} layout="vertical" autoComplete="off">
          <Form.Item
            name="key"
            label="Key"
            rules={[{ required: true, message: '请输入配置 Key' }]}
          >
            <Input disabled={!!editing} />
          </Form.Item>
          <Form.Item
            name="value"
            label="Value"
            rules={[{ required: true, message: '请输入配置值' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input />
          </Form.Item>
          <Form.Item
            name="valueType"
            label="类型"
            initialValue="string"
          >
            <Select>
              <Option value="string">string</Option>
              <Option value="number">number</Option>
              <Option value="boolean">boolean</Option>
              <Option value="json">json</Option>
            </Select>
          </Form.Item>
          <Form.Item
            name="isSecret"
            label="敏感配置"
            valuePropName="checked"
            initialValue={false}
          >
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
