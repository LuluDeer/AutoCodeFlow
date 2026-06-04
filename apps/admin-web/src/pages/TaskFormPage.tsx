import { Form, Input, InputNumber, Select, Button, Card, Space, message } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import { useRequest } from 'ahooks';
import { tasksApi } from '../api/tasks';

export default function TaskFormPage() {
  const nav = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const isEdit = !!id && id !== 'new';
  const [form] = Form.useForm();

  useRequest(() => tasksApi.get(id!), {
    ready: isEdit,
    onSuccess: (data) => form.setFieldsValue(data),
  });

  const onFinish = async (values: any) => {
    try {
      if (isEdit) await tasksApi.update(id!, values);
      else await tasksApi.create(values);
      message.success(isEdit ? '更新成功' : '创建成功');
      nav('/tasks');
    } catch {
      message.error('操作失败');
    }
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/tasks')}>返回</Button>
      </Space>
      <Card title={isEdit ? '编辑任务' : '新建任务'} style={{ maxWidth: 700 }}>
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
          <Form.Item>
            <Button type="primary" htmlType="submit">{isEdit ? '保存' : '创建'}</Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
