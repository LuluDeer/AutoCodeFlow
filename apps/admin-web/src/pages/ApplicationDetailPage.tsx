import { useState, useEffect, useCallback } from 'react';
import {
  Descriptions, Badge, Card, Table, Button, Space, Tag, Typography, message, Spin, Empty,
  Row, Col, Collapse, Popconfirm, Tooltip,
} from 'antd';
import {
  ArrowLeftOutlined, SyncOutlined, ReloadOutlined, GithubOutlined,
  CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined,
  ClockCircleOutlined, EditOutlined,
} from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import { applicationsApi, Application } from '../api/applications';
import { tasksApi, Task } from '../api/tasks';

const { Title, Text, Paragraph } = Typography;
const { Panel } = Collapse;

const statusColors: Record<string, string> = {
  active: 'green',
  deploying: 'blue',
  failed: 'red',
};

const statusIcons: Record<string, React.ReactNode> = {
  active: <CheckCircleOutlined />,
  deploying: <SyncOutlined spin />,
  failed: <CloseCircleOutlined />,
};

export default function ApplicationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [app, setApp] = useState<Application | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const fetchApp = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      const data = await applicationsApi.get(id);
      setApp(data);
    } catch (err: any) {
      message.error(err?.response?.data?.message || 'Failed to load application');
      nav('/applications');
    } finally {
      setLoading(false);
    }
  }, [id, nav]);

  const fetchTasks = useCallback(async () => {
    if (!id) return;
    try {
      const res = await tasksApi.list({ page: 1, pageSize: 100 });
      // Frontend filter: find tasks associated with this application
      const appTasks = (res as any)?.items?.filter((t: Task) => (t as any).applicationId === id) || [];
      setTasks(appTasks);
    } catch {
      // Non-critical
    }
  }, [id]);

  useEffect(() => { fetchApp(); fetchTasks(); }, [fetchApp, fetchTasks]);

  const handleSyncTasks = async () => {
    if (!id) return;
    try {
      setSyncing(true);
      const result = await applicationsApi.syncTasks(id);
      message.success(`Synced ${result.registeredCount} tasks from manifest`);
      fetchTasks();
    } catch (err: any) {
      message.error(err?.response?.data?.message || 'Failed to sync tasks');
    } finally {
      setSyncing(false);
    }
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>;
  if (!app) return <Empty description="Application not found" />;

  const taskColumns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: Task) => (
        <a onClick={() => nav(`/tasks/${record.id}`)}>{name}</a>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (s: string) => (
        <Badge
          status={s === 'active' ? 'success' : s === 'paused' ? 'warning' : 'default'}
          text={s}
        />
      ),
    },
    {
      title: 'Trigger',
      key: 'trigger',
      width: 120,
      render: (_: unknown, r: Task) => (
        <Tag>{r.triggerType}</Tag>
      ),
    },
    {
      title: 'Runtime',
      dataIndex: 'runtime',
      key: 'runtime',
      width: 100,
    },
    {
      title: 'Entrypoint',
      dataIndex: 'entrypoint',
      key: 'entrypoint',
      ellipsis: true,
    },
    {
      title: 'Timeout(s)',
      dataIndex: 'timeout',
      key: 'timeout',
      width: 100,
    },
    {
      title: 'Max Retry',
      dataIndex: 'maxRetry',
      key: 'maxRetry',
      width: 90,
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/applications')}>
          Back to Applications
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => { fetchApp(); fetchTasks(); }}>
          Refresh
        </Button>
      </Space>

      {/* Application Info */}
      <Card style={{ marginBottom: 16 }}>
        <Row justify="space-between" align="middle">
          <Col>
            <Space>
              {app.gitRepo && <GithubOutlined style={{ fontSize: 20 }} />}
              <Title level={4} style={{ margin: 0 }}>{app.name}</Title>
              <Tag color={statusColors[app.status] || 'default'} icon={statusIcons[app.status]}>
                {app.status}
              </Tag>
            </Space>
          </Col>
          <Col>
            <Space>
              <Tooltip title="Re-parse manifest.json and register tasks">
                <Button loading={syncing} icon={<SyncOutlined />} onClick={handleSyncTasks}>
                  Sync Tasks
                </Button>
              </Tooltip>
              <Button icon={<EditOutlined />} onClick={() => message.info('Edit functionality coming soon')}>
                Edit
              </Button>
            </Space>
          </Col>
        </Row>

        <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }} style={{ marginTop: 16 }}>
          <Descriptions.Item label="ID">{app.id}</Descriptions.Item>
          <Descriptions.Item label="Version">
            <Tag color="blue">{app.version}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Runtime">
            <Tag>{app.runtime}</Tag>
          </Descriptions.Item>
          {app.description && (
            <Descriptions.Item label="Description" span={3}>
              {app.description}
            </Descriptions.Item>
          )}
          {app.gitRepo && (
            <Descriptions.Item label="Git Repo" span={2}>
              <a href={app.gitRepo} target="_blank" rel="noopener noreferrer">
                <GithubOutlined /> {app.gitRepo}
              </a>
            </Descriptions.Item>
          )}
          {app.gitBranch && (
            <Descriptions.Item label="Branch">
              <Tag>{app.gitBranch}</Tag>
            </Descriptions.Item>
          )}
          {app.gitCommit && (
            <Descriptions.Item label="Commit">
              <Text code>{app.gitCommit.slice(0, 8)}</Text>
            </Descriptions.Item>
          )}
          {app.entrypoint && (
            <Descriptions.Item label="Entrypoint">
              <Text code>{app.entrypoint}</Text>
            </Descriptions.Item>
          )}
          <Descriptions.Item label="Created">
            {app.createdAt ? new Date(app.createdAt).toLocaleString() : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="Updated">
            {app.updatedAt ? new Date(app.updatedAt).toLocaleString() : '-'}
          </Descriptions.Item>
        </Descriptions>

        {/* Environment Variables */}
        {app.env && Object.keys(app.env).length > 0 && (
          <Collapse style={{ marginTop: 16 }} ghost>
            <Panel header={`Environment Variables (${Object.keys(app.env).length})`} key="env">
              <Descriptions bordered size="small" column={1}>
                {Object.entries(app.env).map(([key, value]) => (
                  <Descriptions.Item key={key} label={<Text code>{key}</Text>}>
                    {value}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            </Panel>
          </Collapse>
        )}
      </Card>

      {/* Manifest */}
      {app.manifest && (
        <Card title="Manifest" style={{ marginBottom: 16 }}>
          <Collapse ghost>
            <Panel header="manifest.json" key="manifest">
              <pre style={{
                background: '#f5f5f5',
                padding: 16,
                borderRadius: 8,
                maxHeight: 300,
                overflow: 'auto',
                fontSize: 13,
              }}>
                {JSON.stringify(app.manifest, null, 2)}
              </pre>
            </Panel>
          </Collapse>
        </Card>
      )}

      {/* Associated Tasks */}
      <Card
        title={`Associated Tasks (${tasks.length})`}
        style={{ marginBottom: 16 }}
        extra={
          <Button
            type="primary"
            size="small"
            onClick={() => nav(`/tasks/new?applicationId=${app.id}`)}
          >
            Create Task
          </Button>
        }
      >
        {tasks.length === 0 ? (
          <Empty description="No tasks associated with this application" />
        ) : (
          <Table<Task>
            columns={taskColumns}
            dataSource={tasks}
            rowKey="id"
            size="small"
            pagination={{ pageSize: 10 }}
          />
        )}
      </Card>
    </div>
  );
}