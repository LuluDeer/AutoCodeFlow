import { Form, Input, InputNumber, Select, Button, Card, Space, message, Divider } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import { useRequest } from 'ahooks';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { useState } from 'react';
import GlueEditor from '../components/GlueEditor';

export default function TaskFormPage() {
  const nav = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const isEdit = !!id && id !== 'new';
  const [form] = Form.useForm();

  useRequest(() => tasksApi.get(id!), {
    ready: isEdit,
    onSuccess: (data) => form.setFieldsValue(data),
  });

  const { data: groups } = useRequest(executorsApi.getGroups);
  const { data: tags } = useRequest(executorsApi.getTags);
  const { data: allTasks } = useRequest(() => tasksApi.list({ page: 1, pageSize: 100 }).then((r: any) => r?.list ?? []));
  const [depSearch, setDepSearch] = useState('');

  const onFinish = async (values: Record<string, unknown>) => {
    try {
      if (isEdit) await tasksApi.update(id!, values);
      else await tasksApi.create(values);
      message.success(isEdit ? '更新成功' : '创建成功');
      nav('/tasks');
    } catch {
      message.error('操作失败');
    }
  };

  // Convert dependency array to JSONB format
  const transformDependencies = (depIds: string[]) => {
    if (!depIds || depIds.length === 0) return null;
    const deps: Record<string, string> = {};
    depIds.forEach((depId, idx) => { deps[`task${idx}`] = depId; });
    return deps;
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/tasks')}>返回</Button>
      </Space>
      <Card title={isEdit ? '编辑任务' : '新建任务'} style={{ maxWidth: 800 }}>
        <Form form={form} layout="vertical" onFinish={onFinish} initialValues={{ runtime: 'python', triggerType: 'manual', maxRetry: 3, timeout: 300 }}>
          <Form.Item name="name" label="任务名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="description" label="描述"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item name="runtime" label="运行时" rules={[{ required: true }]}>
            <Select options={[{ value: 'python', label: 'Python' }, { value: 'node', label: 'Node.js' }, { value: 'shell', label: 'Shell' }]} />
          </Form.Item>
          <Form.Item name="entrypoint" label="入口文件" rules={[{ required: true }]}><Input placeholder="main.py" /></Form.Item>
          <Form.Item name="triggerType" label="触发方式" rules={[{ required: true }]}>
            <Select options={[{ value: 'manual', label: '手动' }, { value: 'fixed_rate', label: '固定频率' }, { value: 'cron', label: 'Cron' }]} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.triggerType !== c.triggerType}>
            {({ getFieldValue }) => getFieldValue('triggerType') === 'fixed_rate' && (
              <Form.Item name="fixedRate" label="固定频率(秒)"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
            )}
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.triggerType !== c.triggerType}>
            {({ getFieldValue }) => getFieldValue('triggerType') === 'cron' && (
              <Form.Item name="cronExpression" label="Cron 表达式"><Input placeholder="0 * * * *" /></Form.Item>
            )}
          </Form.Item>
          <Form.Item name="maxRetry" label="最大重试次数"><InputNumber min={0} max={10} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="timeout" label="超时(秒)"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>

          <Divider>执行器选择（可选）</Divider>
          <Form.Item name="executorAppName" label="指定执行器AppName"><Input placeholder="留空则自动匹配" /></Form.Item>
          <Form.Item name="executorGroup" label="执行器分组">
            <Select allowClear placeholder="选择分组" options={(groups ?? []).map(g => ({ value: g, label: g }))} />
          </Form.Item>
          <Form.Item name="executorTags" label="执行器标签">
            <Select mode="multiple" allowClear placeholder="选择标签" options={(tags ?? []).map(t => ({ value: t, label: t }))} />
          </Form.Item>

          <Divider>任务依赖（可选）</Divider>
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

          <Form.Item
            noStyle
            shouldUpdate={(prev, curr) => JSON.stringify(prev.dependencyIds) !== JSON.stringify(curr.dependencyIds)}
          >
            {({ getFieldValue }) => {
              const deps = getFieldValue('dependencyIds') || [];
              return deps.length > 0 ? (
                <Form.Item name="dependencies" noStyle hidden>
                  <Input value={JSON.stringify(transformDependencies(deps))} />
                </Form.Item>
              ) : null;
            }}
          </Form.Item>)}

          <Form.Item>
            <Button type="primary" htmlType="submit">{isEdit ? '保存' : '创建'}</Button>
          </Form.Item>
        </Form>
      </Card>

      {isEdit && (
        <Card title="Glue 脚本编辑" style={{ marginTop: 24 }}>
          <GlueEditor
            taskId={id!}
            initialSource={form.getFieldValue('glueSource')}
            initialLanguage={form.getFieldValue('glueLanguage')}
            taskRuntime={form.getFieldValue('runtime')}
          />
        </Card>
      )}
    </div>
  );
}
