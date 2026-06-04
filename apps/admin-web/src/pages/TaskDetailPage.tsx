import { useState } from 'react';
import { Tabs, Card, Button, Descriptions, Tag, Table, Typography, Space, message, Modal, Input } from 'antd';
import { PlayCircleOutlined, ArrowLeftOutlined, RollbackOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { useParams, useNavigate } from 'react-router-dom';
import { tasksApi } from '../api/tasks';

const execStatusColor: Record<string, string> = {
  pending: 'default', running: 'processing', success: 'green', failed: 'red', cancelled: 'orange',
};

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { data: task } = useRequest(() => tasksApi.get(id!));
  const { data: execs, loading } = useRequest(() => tasksApi.executions(id!, { pageSize: 50 }));

  const [rollbackModal, setRollbackModal] = useState(false);
  const [rollbackCommit, setRollbackCommit] = useState('');
  const [rollbackLoading, setRollbackLoading] = useState(false);

  const trigger = async () => {
    try { await tasksApi.trigger(id!); message.success('已触发'); } catch { message.error('触发失败'); }
  };

  const doRollback = async () => {
    if (!rollbackCommit.trim()) { message.warning('请输入目标 commit SHA'); return; }
    setRollbackLoading(true);
    try {
      await tasksApi.rollback(id!, rollbackCommit.trim());
      message.success(`已回滚到 ${rollbackCommit.slice(0, 8)} 并触发执行`);
      setRollbackModal(false);
      setRollbackCommit('');
    } catch {
      message.error('回滚失败');
    } finally {
      setRollbackLoading(false);
    }
  };

  const execColumns = [
    { title: '执行ID', dataIndex: 'id', key: 'id', width: 280 },
    { title: '触发方式', dataIndex: 'triggerType', key: 'triggerType' },
    { title: '状态', dataIndex: 'status', key: 'status', render: (v: string) => <Tag color={execStatusColor[v]}>{v}</Tag> },
    { title: '耗时(ms)', dataIndex: 'duration', key: 'duration' },
    { title: '开始时间', dataIndex: 'startTime', key: 'startTime', render: (v: string) => v ? new Date(v).toLocaleString() : '-' },
    { title: '操作', key: 'action', render: (_: any, r: any) => <a onClick={() => nav(`/tasks/${id}/executions/${r.id}`)}>详情</a> },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/tasks')}>返回</Button>
        <Typography.Title level={4} style={{ margin: 0 }}>{task?.name}</Typography.Title>
        <Button type="primary" icon={<PlayCircleOutlined />} onClick={trigger}>手动触发</Button>
        {task?.gitRepo && (
          <Button icon={<RollbackOutlined />} onClick={() => setRollbackModal(true)}>一键回滚</Button>
        )}
      </Space>

      <Modal
        title="一键回滚"
        open={rollbackModal}
        onOk={doRollback}
        confirmLoading={rollbackLoading}
        onCancel={() => { setRollbackModal(false); setRollbackCommit(''); }}
        okText="确认回滚"
        cancelText="取消"
      >
        <p>当前 commit：<code>{task?.gitCommit || '未设置'}</code></p>
        <Input
          placeholder="输入要回滚到的 commit SHA"
          value={rollbackCommit}
          onChange={e => setRollbackCommit(e.target.value)}
        />
      </Modal>

      <Tabs defaultActiveKey="info">
        <Tabs.TabPane tab="基本信息" key="info">
          <Card>
            <Descriptions column={2}>
              <Descriptions.Item label="运行时">{task?.runtime}</Descriptions.Item>
              <Descriptions.Item label="入口文件">{task?.entrypoint}</Descriptions.Item>
              <Descriptions.Item label="触发方式">{task?.triggerType}</Descriptions.Item>
              <Descriptions.Item label="固定频率">{task?.fixedRate ? `${task.fixedRate}s` : '-'}</Descriptions.Item>
              <Descriptions.Item label="Cron">{task?.cronExpression || '-'}</Descriptions.Item>
              <Descriptions.Item label="超时">{task?.timeout}s</Descriptions.Item>
              <Descriptions.Item label="最大重试">{task?.maxRetry}</Descriptions.Item>
              <Descriptions.Item label="状态"><Tag>{task?.status}</Tag></Descriptions.Item>
              <Descriptions.Item label="描述" span={2}>{task?.description || '-'}</Descriptions.Item>
              {task?.gitRepo && (
                <>
                  <Descriptions.Item label="Git 仓库" span={2}>{task.gitRepo}</Descriptions.Item>
                  <Descriptions.Item label="分支">{task.gitBranch || 'main'}</Descriptions.Item>
                  <Descriptions.Item label="固定 Commit">{task.gitCommit || '跟踪最新'}</Descriptions.Item>
                </>
              )}
            </Descriptions>
          </Card>
        </Tabs.TabPane>
        <Tabs.TabPane tab="执行记录" key="executions">
          <Table rowKey="id" columns={execColumns} dataSource={execs?.list} loading={loading} />
        </Tabs.TabPane>
      </Tabs>
    </div>
  );
}
