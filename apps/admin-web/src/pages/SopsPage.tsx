import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Drawer,
  Input,
  message,
  Modal,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';

import PageHeader from '../components/PageHeader';
import { sopsApi } from '../api/sops';
import type { Sop, SopAssignment, SopClarification, SopVersion } from '../api/sops';

/**
 * P5/P6：SOP 管理页（ADMIN-only）。
 *
 * 列表 + 详情抽屉（版本历史 / 指派与澄清）。front-matter 是「文档 + 契约」
 * 的机器侧（设计文档 04 §1），发布/指派动作只对 published 状态开放。
 */

const { Text, Paragraph } = Typography;

function statusTag(status: Sop['status']) {
  const color = status === 'published' ? 'green' : status === 'draft' ? 'gold' : 'default';
  return <Tag color={color}>{status}</Tag>;
}

function assignmentStatusTag(status: SopAssignment['status']) {
  const map: Record<SopAssignment['status'], string> = {
    assigned: 'blue',
    in_progress: 'processing',
    blocked: 'orange',
    completed: 'green',
    failed: 'red',
    cancelled: 'default',
    stalled: 'volcano',
  };
  return <Tag color={map[status]}>{status}</Tag>;
}

export default function SopsPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<Sop[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<Sop | null>(null);
  const [versions, setVersions] = useState<SopVersion[]>([]);
  const [assignments, setAssignments] = useState<SopAssignment[]>([]);
  const [clarifications, setClarifications] = useState<Record<string, SopClarification[]>>({});
  const [draftOpen, setDraftOpen] = useState(false);
  const [draft, setDraft] = useState({ slug: '', title: '', frontMatterYaml: '', bodyMarkdown: '' });
  // P6 升级环收口：人工回复澄清（escalated_to_human / pending）
  const [replyTarget, setReplyTarget] = useState<{ assignmentId: string; clarificationId: string } | null>(null);
  const [reply, setReply] = useState<{ resolution: 'answered' | 'sop_amended'; answer: string; amendedYaml: string }>({
    resolution: 'answered',
    answer: '',
    amendedYaml: '',
  });
  const [replying, setReplying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await sopsApi.list({ page, pageSize });
      setItems(res.items);
      setTotal(res.total);
    } catch {
      message.error(t('sops.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = useCallback(async (sop: Sop) => {
    setDetail(sop);
    try {
      const [vs, asg] = await Promise.all([sopsApi.versions(sop.id), sopsApi.assignments(sop.id)]);
      setVersions(vs);
      setAssignments(asg);
      const clars: Record<string, SopClarification[]> = {};
      await Promise.all(
        asg.map(async (a) => {
          const d = await sopsApi.assignment(a.id);
          clars[a.id] = d.clarifications;
        }),
      );
      setClarifications(clars);
    } catch {
      message.error(t('sops.loadFailed'));
    }
  }, [t]);

  // 提交人工答复——置于 load/openDetail 之后（依赖它们刷新详情与列表）
  const submitReply = useCallback(async () => {
    if (!replyTarget) return;
    setReplying(true);
    try {
      await sopsApi.replyClarification(replyTarget.assignmentId, replyTarget.clarificationId, {
        resolution: reply.resolution,
        answer: reply.answer,
        ...(reply.resolution === 'sop_amended' && reply.amendedYaml ? { amendedFrontMatterYaml: reply.amendedYaml } : {}),
      });
      message.success(t('sops.replyOk'));
      setReplyTarget(null);
      if (detail) await openDetail(detail);
      void load();
    } catch {
      message.error(t('sops.replyFailed'));
    } finally {
      setReplying(false);
    }
  }, [reply, replyTarget, detail, openDetail, load, t]);

  const createDraft = useCallback(async () => {
    try {
      await sopsApi.draft({
        slug: draft.slug,
        title: draft.title,
        frontMatterYaml: draft.frontMatterYaml || undefined,
        bodyMarkdown: draft.bodyMarkdown || undefined,
      });
      message.success(t('sops.draftCreated'));
      setDraftOpen(false);
      setDraft({ slug: '', title: '', frontMatterYaml: '', bodyMarkdown: '' });
      void load();
    } catch {
      message.error(t('sops.draftFailed'));
    }
  }, [draft, load, t]);

  const sopColumns: ColumnsType<Sop> = [
    { title: 'slug', dataIndex: 'slug', width: 200 },
    { title: t('sops.col.title'), dataIndex: 'title', ellipsis: true },
    { title: t('sops.col.status'), dataIndex: 'status', width: 110, render: (s: Sop['status']) => statusTag(s) },
    { title: t('sops.col.version'), dataIndex: 'currentVersion', width: 100, render: (v: string | null) => v ?? '—' },
    { title: t('sops.col.updatedAt'), dataIndex: 'updatedAt', width: 170, render: (v: string) => new Date(v).toLocaleString() },
    {
      title: t('sops.col.actions'),
      width: 100,
      render: (_, record) => (
        <Button size="small" onClick={() => void openDetail(record)}>
          {t('sops.view')}
        </Button>
      ),
    },
  ];

  const versionColumns: ColumnsType<SopVersion> = [
    { title: t('sops.col.version'), dataIndex: 'version', width: 90 },
    { title: 'contentHash', dataIndex: 'contentHash', width: 130, render: (h: string) => <Text copyable={{ text: h }}>{h.slice(0, 12)}…</Text> },
    { title: t('sops.col.publishedBy'), dataIndex: 'publishedBy', width: 160 },
    { title: t('sops.col.publishedAt'), dataIndex: 'publishedAt', width: 170, render: (v: string) => new Date(v).toLocaleString() },
    { title: 'changelog', dataIndex: 'changelog', ellipsis: true },
  ];

  const assignmentColumns: ColumnsType<SopAssignment> = [
    { title: 'id', dataIndex: 'id', width: 300, render: (v: string) => <Text copyable={{ text: v }}>{v.slice(0, 8)}…</Text> },
    { title: t('sops.col.version'), dataIndex: 'sopVersion', width: 90 },
    { title: t('sops.col.status'), dataIndex: 'status', width: 120, render: (s: SopAssignment['status']) => assignmentStatusTag(s) },
    {
      title: t('sops.col.clarifications'),
      width: 120,
      render: (_, a) => `${a.clarificationRound}/${a.maxRounds}`,
    },
    { title: t('sops.col.updatedAt'), dataIndex: 'updatedAt', width: 170, render: (v: string) => new Date(v).toLocaleString() },
  ];

  return (
    <div>
      <PageHeader
        title={t('sops.title')}
        description={t('sops.description')}
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              {t('sops.refresh')}
            </Button>
            <Button type="primary" onClick={() => setDraftOpen(true)}>
              {t('sops.newDraft')}
            </Button>
          </Space>
        }
      />
      <Table<Sop>
        rowKey="id"
        loading={loading}
        columns={sopColumns}
        dataSource={items}
        pagination={{ current: page, pageSize, total, showSizeChanger: true, onChange: (p, ps) => { setPage(p); setPageSize(ps); } }}
        size="middle"
      />

      <Drawer
        title={detail ? `${detail.slug} ${detail.currentVersion ?? ''}` : ''}
        width={860}
        open={detail !== null}
        onClose={() => setDetail(null)}
        destroyOnClose
      >
        {detail && (
          <Tabs
            items={[
              {
                key: 'contract',
                label: t('sops.tab.contract'),
                children: (
                  <>
                    <Paragraph>
                      <Text type="secondary">{t('sops.frontMatterLabel')}</Text>
                    </Paragraph>
                    <pre style={{ maxHeight: 320, overflow: 'auto', fontSize: 12 }}>
                      {JSON.stringify(detail.frontMatterJson, null, 2)}
                    </pre>
                    <Paragraph>
                      <Text type="secondary">{t('sops.bodyLabel')}</Text>
                    </Paragraph>
                    <pre style={{ maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}>
                      {detail.bodyMarkdown ?? ''}
                    </pre>
                  </>
                ),
              },
              {
                key: 'versions',
                label: t('sops.tab.versions'),
                children: (
                  <Table<SopVersion> rowKey="id" columns={versionColumns} dataSource={versions} pagination={false} size="small" />
                ),
              },
              {
                key: 'assignments',
                label: t('sops.tab.assignments'),
                children: (
                  <>
                    <Table<SopAssignment> rowKey="id" columns={assignmentColumns} dataSource={assignments} pagination={false} size="small" />
                    {assignments.some((a) => (clarifications[a.id]?.length ?? 0) > 0) && (
                      <div style={{ marginTop: 16 }}>
                        {assignments
                          .filter((a) => (clarifications[a.id]?.length ?? 0) > 0)
                          .flatMap((a) =>
                            (clarifications[a.id] ?? []).map((c) => (
                              <div key={c.id} style={{ marginBottom: 12 }}>
                                <Text strong>
                                  #{c.round} · {c.resolution ?? 'pending'}
                                </Text>
                                {c.newSopVersion && <Tag style={{ marginLeft: 8 }}>→ {c.newSopVersion}</Tag>}
                                {/* P7d 双端 ACK：回复经 poll 投递、执行器消费后确认；
                                    游标（lastReplyDeliveredAt）推进过该行才算确认——
                                    未确认的回复会随执行器每次 poll 重发 */}
                                {c.resolution !== null && (
                                  a.lastReplyDeliveredAt !== null &&
                                  new Date(a.lastReplyDeliveredAt).getTime() >= new Date(c.updatedAt).getTime()
                                    ? <Tag style={{ marginLeft: 8 }} color="green">{t('sops.replyAcked')}</Tag>
                                    : <Tag style={{ marginLeft: 8 }} color="orange">{t('sops.replyAwaitingAck')}</Tag>
                                )}
                                {/* P6 升级环收口：escalated/pending 的澄清可由人答复——
                                    与中台 Agent 共用同一道服务层 replyClarification 闸门 */}
                                {(c.resolution === null || c.resolution === 'escalated_to_human') && (
                                  <Button
                                    size="small"
                                    style={{ marginLeft: 8 }}
                                    onClick={() => { setReplyTarget({ assignmentId: a.id, clarificationId: c.id }); setReply({ resolution: 'answered', answer: '', amendedYaml: '' }); }}
                                  >
                                    {t('sops.reply')}
                                  </Button>
                                )}
                                <Paragraph style={{ marginBottom: 4 }}>{c.question}</Paragraph>
                                {c.answer && (
                                  <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                                    {c.answer}
                                  </Paragraph>
                                )}
                              </div>
                            )),
                          )}
                      </div>
                    )}
                  </>
                ),
              },
            ]}
          />
        )}
      </Drawer>

      <Modal
        title={t('sops.newDraft')}
        open={draftOpen}
        onOk={() => void createDraft()}
        onCancel={() => setDraftOpen(false)}
        width={720}
        okText={t('sops.create')}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          <Input
            placeholder="slug (daily-report)"
            value={draft.slug}
            onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
          />
          <Input
            placeholder={t('sops.col.title')}
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
          <Input.TextArea
            rows={10}
            placeholder={t('sops.frontMatterPlaceholder')}
            value={draft.frontMatterYaml}
            onChange={(e) => setDraft({ ...draft, frontMatterYaml: e.target.value })}
          />
          <Input.TextArea
            rows={6}
            placeholder={t('sops.bodyPlaceholder')}
            value={draft.bodyMarkdown}
            onChange={(e) => setDraft({ ...draft, bodyMarkdown: e.target.value })}
          />
        </Space>
      </Modal>
      <Modal
        title={t('sops.replyTitle')}
        open={replyTarget !== null}
        onOk={() => void submitReply()}
        onCancel={() => setReplyTarget(null)}
        confirmLoading={replying}
        width={560}
        okText={t('sops.replySubmit')}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          <select
            className="ant-input"
            value={reply.resolution}
            onChange={(e) => setReply({ ...reply, resolution: e.target.value as 'answered' | 'sop_amended' })}
          >
            <option value="answered">{t('sops.replyAnswered')}</option>
            <option value="sop_amended">{t('sops.replyAmended')}</option>
          </select>
          <Input.TextArea
            rows={5}
            placeholder={t('sops.replyPlaceholder')}
            value={reply.answer}
            onChange={(e) => setReply({ ...reply, answer: e.target.value })}
          />
          {reply.resolution === 'sop_amended' && (
            <Input.TextArea
              rows={8}
              placeholder={t('sops.replyAmendedPlaceholder')}
              value={reply.amendedYaml}
              onChange={(e) => setReply({ ...reply, amendedYaml: e.target.value })}
            />
          )}
        </Space>
      </Modal>
    </div>
  );
}
