import { useState } from 'react';
import {
  Table, Button, Badge, Tag, Space, Modal, Form, Select, Input, message,
  Tooltip, Typography, Card, Empty,
} from 'antd';
import {
  RocketOutlined, StopOutlined, ReloadOutlined, PlusOutlined, SyncOutlined,
} from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { deploymentsApi, AppDeployment, CreateDeploymentDto } from '../api/applications';
import { executorsApi, Executor } from '../api/executors';

const { Text } = Typography;

const statusColor: Record<string, string> = {
  pending: 'default',
  deploying: 'processing',
  running: 'success',
  stopped: 'default',
  failed: 'error',
  upgrading: 'warning',
};

const statusLabel: Record<string, string> = {
  pending: '等待中',
  deploying: '部署中',
  running: '运行中',
  stopped: '已停止',
  failed: '失败',
  upgrading: '升级中',
};

interface Props {
  applicationId: string;
}

export default function AppDeploymentPage({ applicationId }: Props) {
  const [deployModalOpen, setDeployModalOpen] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [form] = Form.useForm();

  const { data: deployments = [], loading, refresh } = useRequest(
    () => deploymentsApi.list(applicationId),
    { pollingInterval: 10000 },
  );

  const { data: executorsData = [] } = useRequest(executorsApi.list);
  const onlineExecutors = (executorsData as Executor[]).filter((e) => e.status === 'online');

  const handleDeploy = async (values: CreateDeploymentDto) => {
    setDeploying(true);
    try {
      await deploymentsApi.deploy(applicationId, values);
      message.success('部署指令已发送');
      setDeployModalOpen(false);
      form.resetFields();
      refresh();
    } catch (err: any) {
      message.error(err?.response?.data?.message || '部署失败');
    } finally {
      setDeploying(false);
    }
  };

  const handleUpgrade = async (id: string) => {
    try {
      await deploymentsApi.upgrade(id);
      message.success('升级指令已发送');
      refresh();
    } catch (err: any) {
      message.error(err?.response?.data?.message || '升级失败');
    }
  };

  const handleStop = async (id: string) => {
    Modal.confirm({
      title: '确认停止该部署？',
      onOk: async () => {
        try {
          await deploymentsApi.stop(id);
          message.success('停止指令已发送');
          refresh();
        } catch (err: any) {
          message.error(err?.response?.data?.message || '停止失败');
        }
      },
    });
  };

  const columns = [
    {
      title: '执行器地址',
      dataIndex: 'executorAddress',
      key: 'executorAddress',
      render: (v: string) => <Text code>{v}</Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => (
        <Badge
          status={statusColor[v] as any}
          text={
            <span>
              {v === 'deploying' || v === 'upgrading' ? <SyncOutlined spin style={{ marginRight: 4 }} /> : null}
              {statusLabel[v] || v}
            </span>
          }
        />
      ),
    },
    {
      title: '运行模式',
      dataIndex: 'runMode',
      key: 'runMode',
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: 'PID',
      dataIndex: 'pid',
      key: 'pid',
      render: (v: number | null) => v ?? '-',
    },
    {
      title: '已部署提交',
      dataIndex: 'deployedCommit',
      key: 'deployedCommit',
      render: (v: string | null) => v ? <Text code>{v.slice(0, 8)}</Text> : '-',
    },
    {
      title: '状态消息',
      dataIndex: 'statusMessage',
      key: 'statusMessage',
      ellipsis: true,
      render: (v: string | null) => v || '-',
    },
    {
      title: '最后心跳',
      dataIndex: 'lastHeartbeat',
      key: 'lastHeartbeat',
      render: (v: string | null) => v ? new Date(v).toLocaleString('zh-CN') : '-',
    },
    {
      title: '部署时间',
      dataIndex: 'deployedAt',
      key: 'deployedAt',
      render: (v: string | null) => v ? new Date(v).toLocaleString('zh-CN') : '-',
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, record: AppDeployment) => (
        <Space>
          <Tooltip title="拉取最新代码并重启">
            <Button
              size="small"
              icon={<ReloadOutlined />}
              disabled={record.status === 'deploying' || record.status === 'upgrading'}
              onClick={() => handleUpgrade(record.id)}
            >
              升级
            </Button>
          </Tooltip>
          <Tooltip title="停止进程">
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              disabled={record.status !== 'running'}
              onClick={() => handleStop(record.id)}
            >
              停止
            </Button>
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={`部署实例 (${deployments.length})`}
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={refresh}>刷新</Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setDeployModalOpen(true)}
          >
            新建部署
          </Button>
        </Space>
      }
    >
      {deployments.length === 0 && !loading ? (
        <Empty
          description="暂无部署实例"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        >
          <Button type="primary" icon={<RocketOutlined />} onClick={() => setDeployModalOpen(true)}>
            立即部署
          </Button>
        </Empty>
      ) : (
        <Table<AppDeployment>
          columns={columns}
          dataSource={deployments}
          rowKey="id"
          loading={loading}
          size="small"
          pagination={{ pageSize: 10 }}
        />
      )}

      <Modal
        title="新建部署"
        open={deployModalOpen}
        onCancel={() => { setDeployModalOpen(false); form.resetFields(); }}
        onOk={() => form.submit()}
        confirmLoading={deploying}
        okText="部署"
      >
        <Form form={form} layout="vertical" onFinish={handleDeploy}>
          <Form.Item
            label="目标执行器"
            name="executorId"
            rules={[{ required: true, message: '请选择执行器' }]}
          >
            <Select
              placeholder="选择在线执行器"
              options={onlineExecutors.map((e: Executor) => ({
                label: `${e.appName} (${e.address})`,
                value: e.id,
              }))}
            />
          </Form.Item>
          <Form.Item label="运行模式" name="runMode" initialValue="daemon">
            <Select
              options={[
                { label: '常驻守护 (daemon)', value: 'daemon' },
                { label: '单次运行 (once)', value: 'once' },
                { label: '调度触发 (scheduled)', value: 'scheduled' },
              ]}
            />
          </Form.Item>
          <Form.Item
            label="启动命令覆盖"
            name="startCommand"
            help="留空使用应用的 manifest entrypoint"
          >
            <Input placeholder="例如: node dist/main.js" allowClear />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
