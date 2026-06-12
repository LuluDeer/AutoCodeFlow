import { Form, Input, InputNumber, Select, Button, Card, Space, message, Typography, Collapse } from 'antd';
import { ArrowLeftOutlined, InfoCircleOutlined, SettingOutlined, ClockCircleOutlined, ApartmentOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import { useRequest } from 'ahooks';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { useState } from 'react';
import GlueEditor from '../components/GlueEditor';
import CronHelper from '../components/CronHelper';

const { Text } = Typography;

export default function TaskFormPage() {
  const nav = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const isEdit = !!id && id !== 'new';
  const [form] = Form.useForm();

  useRequest(() => tasksApi.get(id!), {
    ready: isEdit,
    onSuccess: (data) => {
      // Convert dependencies object { taskId: taskName } back to array of IDs for the Select
      const depIds = data.dependencies ? Object.keys(data.dependencies) : [];
      form.setFieldsValue({ ...data, dependencyIds: depIds });
    },
  });

  const { data: groups } = useRequest(executorsApi.getGroups);
  const { data: tags } = useRequest(executorsApi.getTags);
  const { data: allTasks } = useRequest(() => tasksApi.list({ page: 1, pageSize: 100 }).then((r: any) => r?.list ?? []));
  const [depSearch, setDepSearch] = useState('');

  const onFinish = async (values: Record<string, unknown>) => {
    try {
      // Transform dependencyIds array into JSONB object before submitting
      const depIds = values.dependencyIds as string[] | undefined;
      const payload = {
        ...values,
        dependencies: transformDependencies(depIds ?? []),
      };
      delete payload.dependencyIds;
      if (isEdit) await tasksApi.update(id!, payload);
      else await tasksApi.create(payload);
      message.success(isEdit ? '更新成功' : '创建成功');
      nav('/tasks');
    } catch (err) {
      console.error('Task save failed:', err);
      message.error('操作失败');
    }
  };

  // Convert dependency array to JSONB format: { taskId: taskName }
  const transformDependencies = (depIds: string[]) => {
    if (!depIds || depIds.length === 0) return null;
    const deps: Record<string, string> = {};
    const tasks: any[] = allTasks ?? [];
    depIds.forEach((depId) => {
      const found = tasks.find((t: any) => t.id === depId);
      deps[depId] = found?.name ?? depId;
    });
    return deps;
  };

  const collapseItems = [
    {
      key: 'basic',
      label: (
        <Space>
          <SettingOutlined />
          <Text strong>基础配置</Text>
        </Space>
      ),
      children: (
        <>
          <Form.Item name="name" label="任务名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="description" label="描述"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item name="runtime" label="运行时" rules={[{ required: true }]}>
            <Select options={[{ value: 'python', label: 'Python' }, { value: 'node', label: 'Node.js' }, { value: 'shell', label: 'Shell' }]} />
          </Form.Item>
          <Form.Item name="entrypoint" label="入口文件" rules={[{ required: true }]}><Input placeholder="main.py" /></Form.Item>
          <Form.Item name="maxRetry" label="最大重试次数"><InputNumber min={0} max={10} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="timeout" label="超时(秒)"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
        </>
      ),
    },
    {
      key: 'schedule',
      label: (
        <Space>
          <ClockCircleOutlined />
          <Text strong>调度设置</Text>
        </Space>
      ),
      children: (
        <>
          <Form.Item name="triggerType" label="触发方式" rules={[{ required: true }]}>
            <Select options={[{ value: 'manual', label: '手动' }, { value: 'fixed_rate', label: '固定频率' }, { value: 'cron', label: 'Cron' }]} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.triggerType !== c.triggerType}>
            {({ getFieldValue }) => getFieldValue('triggerType') === 'fixed_rate' && (
              <Form.Item name="fixedRate" label="固定频率(秒)"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
            )}
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.triggerType !== c.triggerType}>
            {({ getFieldValue, setFieldValue }) => getFieldValue('triggerType') === 'cron' && (
              <Form.Item
                name="cronExpression"
                label="Cron 表达式"
                tooltip={{ title: '标准5段Cron格式：分 时 日 月 周', icon: <InfoCircleOutlined /> }}
                rules={[{ required: true, message: '请输入Cron表达式' }]}
              >
                <>
                  <Input placeholder="0 * * * *" />
                  <CronHelper onChange={(val) => setFieldValue('cronExpression', val)} />
                </>
              </Form.Item>
            )}
          </Form.Item>
        </>
      ),
    },
    {
      key: 'executor',
      label: (
        <Space>
          <ApartmentOutlined />
          <Text strong>执行器与依赖</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>可选</Text>
        </Space>
      ),
      children: (
        <>
          <Form.Item name="executorAppName" label="指定执行器AppName"><Input placeholder="留空则自动匹配" /></Form.Item>
          <Form.Item name="executorGroup" label="执行器分组">
            <Select allowClear placeholder="选择分组" options={(groups ?? []).map(g => ({ value: g, label: g }))} />
          </Form.Item>
          <Form.Item name="executorTags" label="执行器标签">
            <Select mode="multiple" allowClear placeholder="选择标签" options={(tags ?? []).map(t => ({ value: t, label: t }))} />
          </Form.Item>
          <Form.Item
            name="dependencyIds"
            label="依赖任务"
            tooltip="选择此任务所依赖的前置任务。当所有依赖任务执行成功后，此任务将自动触发"
          >
            <Select
              mode="multiple"
              allowClear
              placeholder="选择依赖任务"
              showSearch
              searchValue={depSearch}
              onSearch={setDepSearch}
              filterOption={(input, option) =>
                (option?.label as string)?.toLowerCase().includes(input.toLowerCase())
              }
              options={allTasks
                ?.filter((t: any) => t.id !== id)
                .map((t: any) => ({ value: t.id, label: `${t.name} (${t.runtime})` }))}
            />
          </Form.Item>
        </>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/tasks')}>返回</Button>
      </Space>
      <Card title={isEdit ? '编辑任务' : '新建任务'} style={{ maxWidth: 800 }}>
        <Form form={form} layout="vertical" onFinish={onFinish} initialValues={{ runtime: 'python', triggerType: 'manual', maxRetry: 3, timeout: 300 }}>
          <Collapse
            defaultActiveKey={['basic', 'schedule']}
            ghost
            items={collapseItems}
            style={{ marginBottom: 16 }}
          />
          <Form.Item style={{ marginTop: 8 }}>
            <Button type="primary" htmlType="submit">{isEdit ? '保存' : '创建'}</Button>
          </Form.Item>
        </Form>
      </Card>

      {isEdit ? (
        <Card title="Glue 脚本编辑" style={{ marginTop: 24 }}>
          <GlueEditor
            taskId={id!}
            initialSource={form.getFieldValue('glueSource')}
            initialLanguage={form.getFieldValue('glueLanguage')}
            taskRuntime={form.getFieldValue('runtime')}
          />
        </Card>
      ) : (
        <Card style={{ marginTop: 24, background: '#fafafa', borderStyle: 'dashed' }}>
          <div style={{ textAlign: 'center', color: '#888', padding: '8px 0' }}>
            💡 创建任务后，可在任务详情页编辑 Glue 脚本
          </div>
        </Card>
      )}
    </div>
  );
}
