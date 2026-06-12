import { useState } from 'react';
import { Tabs, Card, Button, Descriptions, Tag, Typography, Space, message, Modal, Input, List, Popconfirm, Breadcrumb } from 'antd';
import { PlayCircleOutlined, ArrowLeftOutlined, RollbackOutlined, PauseCircleOutlined, PlaySquareOutlined, EditOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { tasksApi } from '../api/tasks';
import ExecutionCompare from '../components/ExecutionCompare';

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { data: task, refresh: refreshTask } = useRequest(() => tasksApi.get(id!));
  const { data: execs } = useRequest(() => tasksApi.executions(id!, { pageSize: 50 }));

  // Fetch dependency task details
  // dependencies format: { taskId: taskName } — keys are UUIDs
  const depIds = task?.dependencies ? Object.keys(task.dependencies) : [];
  const { data: depTasks } = useRequest(
    () => Promise.all(depIds.map((depId: string) => tasksApi.get(depId))),
    { ready: depIds.length > 0 },
  );

  const [rollbackModal, setRollbackModal] = useState(false);
  const [rollbackCommit, setRollbackCommit] = useState('');
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

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

  const pauseTask = async () => {
    setActionLoading(true);
    try {
      const res = await tasksApi.pause(id!);
      message.success(res.message);
      refreshTask();
    } catch { message.error('暂停失败'); }
    finally { setActionLoading(false); }
  };

  const resumeTask = async () => {
    setActionLoading(true);
    try {
      const res = await tasksApi.resume(id!);
      message.success(res.message);
      refreshTask();
    } catch { message.error('恢复失败'); }
    finally { setActionLoading(false); }
  };

  return (
    <div>
      <Breadcrumb
        items={[
          { title: <Link to="/dashboard">首页</Link> },
          { title: <Link to="/tasks">任务管理</Link> },
          { title: '任务详情' },
        ]}
        style={{ marginBottom: 16 }}
      />
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/tasks')}>返回</Button>
        <Typography.Title level={4} style={{ margin: 0 }}>{task?.name}</Typography.Title>
        <Button icon={<EditOutlined />} onClick={() => nav(`/tasks/${id}/edit`)}>编辑</Button>
        <Button type="primary" icon={<PlayCircleOutlined />} onClick={trigger}>手动触发</Button>
        {task?.gitRepo && (
          <Button icon={<RollbackOutlined />} onClick={() => setRollbackModal(true)}>一键回滚</Button>
        )}
        {task?.status === 'active' ? (
          <Popconfirm title="确定要暂停此任务吗？" onConfirm={pauseTask}>
            <Button icon={<PauseCircleOutlined />} loading={actionLoading}>暂停</Button>
          </Popconfirm>
        ) : task?.status === 'paused' ? (
          <Popconfirm title="确定要恢复此任务吗？" onConfirm={resumeTask}>
            <Button icon={<PlaySquareOutlined />} loading={actionLoading}>恢复</Button>
          </Popconfirm>
        ) : null}
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
              <Descriptions.Item label="触发方式">
                {task?.triggerType === 'manual' ? '手动' : task?.triggerType === 'fixed_rate' ? '固定频率' : task?.triggerType === 'cron' ? 'Cron' : task?.triggerType}
              </Descriptions.Item>
              <Descriptions.Item label="固定频率">{task?.fixedRate ? `${task.fixedRate}s` : '-'}</Descriptions.Item>
              <Descriptions.Item label="Cron">{task?.cronExpression || '-'}</Descriptions.Item>
              <Descriptions.Item label="超时">{task?.timeout}s</Descriptions.Item>
              <Descriptions.Item label="最大重试">{task?.maxRetry}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={task?.status === 'active' ? 'green' : task?.status === 'paused' ? 'orange' : task?.status === 'disabled' ? 'red' : 'default'}>
                  {task?.status === 'active' ? '运行中' : task?.status === 'paused' ? '已暂停' : task?.status === 'disabled' ? '已禁用' : task?.status}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="描述" span={2}>{task?.description || '-'}</Descriptions.Item>
              <Descriptions.Item label="指定执行器">{task?.executorAppName || '-'}</Descriptions.Item>
              <Descriptions.Item label="执行器分组">{task?.executorGroup || '-'}</Descriptions.Item>
              <Descriptions.Item label="执行器标签">{task?.executorTags?.length ? task.executorTags.map((t: string) => <Tag key={t}>{t}</Tag>) : '-'}</Descriptions.Item>
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
          <ExecutionCompare executions={execs?.list ?? []} />
        </Tabs.TabPane>
        <Tabs.TabPane tab="任务依赖" key="dependencies">
          {depIds.length === 0 ? (
            <Card><Typography.Text type="secondary">暂无依赖任务</Typography.Text></Card>
          ) : (
            <List
              header={<Typography.Text>前置依赖任务（需全部执行成功后才会触发此任务）</Typography.Text>}
              bordered
              dataSource={depTasks ?? []}
              renderItem={(dep: any) => (
                <List.Item actions={[<a key="view" onClick={() => nav(`/tasks/${dep.id}`)}>查看</a>]}>
                  <List.Item.Meta
                    title={dep.name}
                    description={`运行时: ${dep.runtime} | 入口: ${dep.entrypoint}`}
                  />
                </List.Item>
              )}
            />
          )}
        </Tabs.TabPane>
      </Tabs>
    </div>
  );
}
