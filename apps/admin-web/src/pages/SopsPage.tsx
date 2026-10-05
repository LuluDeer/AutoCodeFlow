import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Input,
  Modal,
  Pagination,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
// TOAST-01：与全站一致走 utils/toast 出口（App 实例优先，暗色主题下样式正确；
// 此前直接用 antd message 是本文件的历史偏离）。
import { message } from '../utils/toast';
import { ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';

import PageHeader from '../components/PageHeader';
// UI-08：首屏数据未达时以 Skeleton 替代表格 Spin（ApplicationListPage 同款）
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';
// UX-06 第二扫：SOP 域裸枚举收敛到唯一事实源（状态/工单状态/澄清处置/附件类型）
import {
  sopAssignmentStatusLabel,
  sopClarResolutionLabel,
  sopMediaKindLabel,
  sopStatusLabel,
} from '../utils/sop-label';
// P3 审计：SOP 状态/工单状态 → Tag color 映射收敛到 utils/status-color 单一事实源
import { SOP_ASSIGNMENT_STATUS_COLOR, SOP_STATUS_COLOR } from '../utils/status-color';
// UI-09 第三轮：≤768px 表格 → 卡片列表的结构级降级（对齐 TaskListPage/
// ApplicationListPage 的 MOBILE-CARD-01 先例；断点与 index.css ui09 媒体查询同值）
import { useIsMobile } from '../hooks/useIsMobile';
// A11Y-DRAWER-01：SOP 详情抽屉焦点管理（开→聚焦首个可交互元素；关→归还触发按钮）
import { useDrawerA11y } from '../hooks/useDrawerA11y';
import { sopsApi } from '../api/sops';
// SOPS-TIME-01：时间列统一走 formatDateTime（locale 感知 + 空值回退 '—'）
import { formatDateTime } from '../utils/timeFormat';
import type {
  AssignableExecutor,
  Sop,
  SopAssignment,
  SopClarification,
  SopMedia,
  SopVersion,
} from '../api/sops';

/**
 * P5/P6：SOP 管理页（ADMIN-only）。
 *
 * 列表 + 详情抽屉（版本历史 / 指派与澄清）。front-matter 是「文档 + 契约」
 * 的机器侧（设计文档 04 §1），发布/指派动作只对 published 状态开放。
 */

const { Text, Paragraph } = Typography;

/** UI-08：首屏 Skeleton 渲染判据——初次加载（无数据）且未出错时以骨架屏替代表格 Spin */
function shouldShowSkeleton(loading: boolean, error: unknown, count: number): boolean {
  return loading && count === 0 && !error;
}

function statusTag(status: Sop['status'], t: (key: string) => string) {
  // UX-06 第二扫：不再裸渲染 {status}（draft/published/deprecated → sops.status.*）
  const color = SOP_STATUS_COLOR[status] ?? 'default';
  return <Tag color={color}>{sopStatusLabel(status, t)}</Tag>;
}

function assignmentStatusTag(status: SopAssignment['status'], t: (key: string) => string) {
  // UX-06 第二扫：不再裸渲染 {status}（7 值工单状态机 → sops.assignmentStatus.*）
  return <Tag color={SOP_ASSIGNMENT_STATUS_COLOR[status] ?? 'default'}>{sopAssignmentStatusLabel(status, t)}</Tag>;
}

/** 终态工单：可重派（换机重发），也不会再消费任何澄清答复。 */
const TERMINAL_ASSIGNMENT_STATUSES: SopAssignment['status'][] = ['failed', 'stalled', 'cancelled'];

export default function SopsPage() {
  const { t } = useTranslation();
  // UI-09 第三轮：≤768px 结构级降级开关（表格→卡片、抽屉满宽）
  const isMobile = useIsMobile();
  // A11Y-DRAWER-01：详情抽屉焦点管理（开→聚焦首个可交互元素；关→归还触发按钮）
  const drawerA11y = useDrawerA11y();
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
  // SOPS-DRAFT-01：新建草稿提交中——Modal confirmLoading + 防重复提交
  const [creatingDraft, setCreatingDraft] = useState(false);
  // P6 升级环收口：人工回复澄清（escalated_to_human / pending）
  const [replyTarget, setReplyTarget] = useState<{ assignmentId: string; clarificationId: string } | null>(null);
  const [reply, setReply] = useState<{ resolution: 'answered' | 'sop_amended'; answer: string; amendedYaml: string; amendedBody: string }>({
    resolution: 'answered',
    answer: '',
    amendedYaml: '',
    amendedBody: '',
  });
  const [replying, setReplying] = useState(false);
  // 指派对话框（P5 核心动作此前无 UI 入口）：版本 + 租约内可接单执行器
  const [assignTarget, setAssignTarget] = useState<Sop | null>(null);
  const [assignForm, setAssignForm] = useState<{ version: string; executorId: string }>({ version: '', executorId: '' });
  const [assignable, setAssignable] = useState<AssignableExecutor[]>([]);
  const [assigning, setAssigning] = useState(false);
  // 指派媒体（截图/录屏——执行器回传的证据，此前在 UI 不可见）
  const [media, setMedia] = useState<Record<string, SopMedia[]>>({});

  // B-14：silent 轮询不闪 loading（定时器每 15s 触发，spinner 抖动是纯噪音）
  // UX-05（对齐 ExecutorPackagesPage/TaskTemplatesPage 先例）：首次/手动加载失败
  // 必须落到页内错误块——此前只弹一条一闪而过的 toast，表格停在「暂无数据」
  // 空态，把读取失败谎报成「还没有任何 SOP」。
  const [loadError, setLoadError] = useState<unknown>(null);
  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const res = await sopsApi.list({ page, pageSize });
      setItems(res.items);
      setTotal(res.total);
      // 成功即清错误（后台静默拍自愈同效）
      setLoadError(null);
    } catch (err: unknown) {
      // B-14：后台轮询失败静默——连续弹 message 是噪音，列表保留旧数据
      if (!opts?.silent) {
        setLoadError(err);
        message.error(t('sops.loadFailed'));
      }
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [page, pageSize, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // B-14：15s 轮询自动刷新（失焦暂停，定时器保留、回前台下一拍恢复——
  // 对齐 ExecutionsPage 15s 兜底轮询先例）。SOP 列表/工单状态是协作面的
  // 只读投影，人工不刷新就看不到澄清升级与执行进展。
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load({ silent: true });
    }, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  // SOPS-RACE-01：openDetail 无取消机制，快速连点两行时旧详情的响应可晚于
  // 新详情 resolve，把 versions/assignments/澄清覆盖成旧行的数据。每次调用
  // 自增 fetchSeq，仅最后一次请求允许 setState（与 AppDeploymentPage 同款）。
  const detailSeq = useRef(0);

  const openDetail = useCallback(async (sop: Sop) => {
    const seq = ++detailSeq.current;
    setDetail(sop);
    try {
      const [vs, asg] = await Promise.all([sopsApi.versions(sop.id), sopsApi.assignments(sop.id)]);
      if (seq !== detailSeq.current) return; // 已有更新的请求/关闭，丢弃过期响应
      setVersions(vs);
      setAssignments(asg);
      const clars: Record<string, SopClarification[]> = {};
      const med: Record<string, SopMedia[]> = {};
      await Promise.all(
        asg.map(async (a) => {
          const d = await sopsApi.assignment(a.id);
          clars[a.id] = d.clarifications;
          // 媒体清单失败不阻断详情（单指派 best-effort）
          try {
            med[a.id] = await sopsApi.assignmentMedia(a.id);
          } catch {
            med[a.id] = [];
          }
        }),
      );
      if (seq !== detailSeq.current) return; // 已有更新的请求/关闭，丢弃过期响应
      setClarifications(clars);
      setMedia(med);
    } catch {
      if (seq !== detailSeq.current) return;
      message.error(t('sops.loadFailed'));
    }
  }, [t]);

  // 打开指派对话框：拉当前租约内可接单的执行器（空 = 没有机器开着 Agent）
  const openAssign = useCallback(async (sop: Sop, prefillVersion?: string) => {
    setAssignTarget(sop);
    setAssignForm({ version: prefillVersion || sop.currentVersion || '', executorId: '' });
    setAssignable([]);
    try {
      setAssignable(await sopsApi.listAssignableExecutors());
    } catch {
      message.error(t('sops.assignFailed'));
    }
  }, [t]);

  const submitAssign = useCallback(async () => {
    if (!assignTarget || !assignForm.executorId) return;
    setAssigning(true);
    try {
      await sopsApi.assign(assignTarget.id, {
        version: assignForm.version || undefined,
        executorId: assignForm.executorId,
      });
      message.success(t('sops.assignOk'));
      setAssignTarget(null);
      if (detail) await openDetail(detail);
      void load();
    } catch {
      message.error(t('sops.assignFailed'));
    } finally {
      setAssigning(false);
    }
  }, [assignTarget, assignForm, detail, openDetail, load, t]);

  /** 查看澄清附件：平台路径 /api/agent-collab/media/<id> → 取 id 经鉴权 blob 打开 */
  const viewClarificationMedia = useCallback(async (platformPath: string) => {
    const id = /media\/([^/]+)$/.exec(platformPath)?.[1];
    if (!id) return;
    try {
      await sopsApi.viewMedia(id);
    } catch {
      message.error(t('sops.mediaViewFailed'));
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
        // B-14：修订正文（API 已支持 amendedBodyMarkdown——修订可以只改正文
        // 不动 front-matter，此前表单只给了 YAML 入口）
        ...(reply.resolution === 'sop_amended' && reply.amendedYaml ? { amendedFrontMatterYaml: reply.amendedYaml } : {}),
        ...(reply.resolution === 'sop_amended' && reply.amendedBody ? { amendedBodyMarkdown: reply.amendedBody } : {}),
      });
      message.success(t('sops.replyOk'));
      // 接管未送达（9.13 残差）：执行器已按升级收尾的指派不再消费答复——
      // 接管只更新澄清行，恢复路径是重派。不提示会让运维误以为已送达。
      const target = assignments.find((x) => x.id === replyTarget.assignmentId);
      if (target && TERMINAL_ASSIGNMENT_STATUSES.includes(target.status)) {
        message.warning(t('sops.replyNotDelivered'), 6);
      }
      setReplyTarget(null);
      if (detail) await openDetail(detail);
      void load();
    } catch {
      message.error(t('sops.replyFailed'));
    } finally {
      setReplying(false);
    }
  }, [reply, replyTarget, assignments, detail, openDetail, load, t]);

  /** 该指派是否存在仍挂着升级（escalated_to_human）的澄清——升级终态时接管答复不投递。 */
  const hasEscalatedClarification = useCallback(
    (assignmentId: string) => (clarifications[assignmentId] ?? []).some((c) => c.resolution === 'escalated_to_human'),
    [clarifications],
  );

  const createDraft = useCallback(async () => {
    // SOPS-DRAFT-01：slug 是 SOP 的唯一标识，后端规则 ^[a-z0-9][a-z0-9-]{0,127}$
    // （sop.controller.ts DraftSopDto）。前端先校验再发请求——空 slug/非法字符
    // 就地提示，不发注定失败的请求。
    const slug = draft.slug.trim();
    if (!slug) {
      message.warning(t('sops.slugRequired'));
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(slug)) {
      message.warning(t('sops.slugInvalid'));
      return;
    }
    // 排查清单 #3：DraftSopDto 的 title 只有 @IsString()+@MaxLength(255)——
    // **空串也能过校验**，此前空标题草稿被静默创建，列表里只留一个空行。
    // 前端先行拦截（trim 后必填），超长由输入框 maxLength 兜住。
    const title = draft.title.trim();
    if (!title) {
      message.warning(t('sops.titleRequired'));
      return;
    }
    // 防重复提交：Modal okButton 走 confirmLoading，回调再挡一层（连点/回车）
    if (creatingDraft) return;
    setCreatingDraft(true);
    try {
      await sopsApi.draft({
        slug,
        title,
        frontMatterYaml: draft.frontMatterYaml || undefined,
        bodyMarkdown: draft.bodyMarkdown || undefined,
      });
      message.success(t('sops.draftCreated'));
      setDraftOpen(false);
      setDraft({ slug: '', title: '', frontMatterYaml: '', bodyMarkdown: '' });
      void load();
    } catch {
      message.error(t('sops.draftFailed'));
    } finally {
      setCreatingDraft(false);
    }
  }, [draft, creatingDraft, load, t]);

  const sopColumns: ColumnsType<Sop> = [
    { title: t('sops.col.slug'), dataIndex: 'slug', width: 200 },
    { title: t('sops.col.title'), dataIndex: 'title', ellipsis: true },
    { title: t('sops.col.status'), dataIndex: 'status', width: 110, render: (s: Sop['status']) => statusTag(s, t) },
    { title: t('sops.col.version'), dataIndex: 'currentVersion', width: 100, render: (v: string | null) => v ?? '—' },
    { title: t('sops.col.updatedAt'), dataIndex: 'updatedAt', width: 170, render: (v: string) => formatDateTime(v) },
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
    { title: t('sops.col.contentHash'), dataIndex: 'contentHash', width: 130, render: (h: string) => <Text copyable={{ text: h }}>{h.slice(0, 12)}…</Text> },
    { title: t('sops.col.publishedBy'), dataIndex: 'publishedBy', width: 160 },
    { title: t('sops.col.publishedAt'), dataIndex: 'publishedAt', width: 170, render: (v: string) => formatDateTime(v) },
    { title: t('sops.col.changelog'), dataIndex: 'changelog', ellipsis: true },
  ];

  const assignmentColumns: ColumnsType<SopAssignment> = [
    { title: t('sops.col.id'), dataIndex: 'id', width: 300, render: (v: string) => <Text copyable={{ text: v }}>{v.slice(0, 8)}…</Text> },
    { title: t('sops.col.version'), dataIndex: 'sopVersion', width: 90 },
    { title: t('sops.col.status'), dataIndex: 'status', width: 120, render: (s: SopAssignment['status']) => assignmentStatusTag(s, t) },
    {
      title: t('sops.col.clarifications'),
      width: 120,
      render: (_, a) => `${a.clarificationRound}/${a.maxRounds}`,
    },
    { title: t('sops.col.updatedAt'), dataIndex: 'updatedAt', width: 170, render: (v: string) => formatDateTime(v) },
    {
      title: t('sops.col.actions'),
      width: 90,
      // 重派：失败/停滞/取消的工单一键换机重发（预填原版本）——运维此前
      // 只能 curl assign 端点。升级终态的行带「答复不投递」提示（9.13 残差）。
      render: (_, a) => {
        if (!detail || !TERMINAL_ASSIGNMENT_STATUSES.includes(a.status)) return null;
        const button = (
          <Button size="small" onClick={() => void openAssign(detail, a.sopVersion)}>
            {t('sops.reassign')}
          </Button>
        );
        return hasEscalatedClarification(a.id) ? (
          <Tooltip title={t('sops.reassignEscalatedHint')}>{button}</Tooltip>
        ) : (
          button
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title={t('sops.title')}
        description={t('sops.description')}
        extra={
          <Space>
            <Button icon={<ReloadOutlined aria-hidden />} onClick={() => void load()}>
              {t('sops.refresh')}
            </Button>
            <Button type="primary" onClick={() => setDraftOpen(true)}>
              {t('sops.newDraft')}
            </Button>
          </Space>
        }
      />
      {/* UX-05：首次/手动加载失败 → 页内错误块（重试=重新拉取），不再只靠
          一条瞬时 toast + 空表误导。后台静默轮询失败不打扰（保留旧数据）。 */}
      {loadError !== null && (
        <StateError
          error={loadError}
          title={t('sops.loadFailed')}
          onRetry={() => void load()}
          style={{ marginBottom: 16 }}
        />
      )}
      {/* UI-09 第三轮：≤768px 卡片列表（MOBILE-CARD-01 同款结构级降级）——
          SOP 卡按首查信息组织：slug+状态 → 标题 → 版本/更新时间 → 操作；
          桌面保留 6 列表格。加载失败时空态不渲染（StateError 已如实呈现，
          与桌面 locale 口径一致），避免把失败读成空列表。 */}
      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!loadError && items.length === 0 && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('sops.empty')} />
          )}
          {items.map((sop) => (
            <Card key={sop.id} size="small">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <Text strong ellipsis style={{ flex: 1, minWidth: 0 }}>{sop.slug}</Text>
                {statusTag(sop.status, t)}
              </div>
              {sop.title && (
                <div style={{ marginTop: 4, fontSize: 12, color: 'var(--chart-axis-text)' }}>{sop.title}</div>
              )}
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--chart-axis-text)' }}>
                {t('sops.col.version')}：{sop.currentVersion ?? '—'} · {t('sops.col.updatedAt')}：{formatDateTime(sop.updatedAt)}
              </div>
              <div style={{ marginTop: 8 }}>
                <Button size="small" onClick={() => void openDetail(sop)}>
                  {t('sops.view')}
                </Button>
              </div>
            </Card>
          ))}
          {items.length > 0 && (
            <Pagination
              size="small"
              current={page}
              pageSize={pageSize}
              total={total}
              showSizeChanger={false}
              onChange={(p, ps) => { setPage(p); setPageSize(ps); }}
              style={{ alignSelf: 'flex-end' }}
            />
          )}
        </div>
      ) : (
        <Table<Sop>
          rowKey="id"
          loading={loading}
          columns={sopColumns}
          dataSource={items}
          pagination={{ current: page, pageSize, total, showSizeChanger: true, onChange: (p, ps) => { setPage(p); setPageSize(ps); } }}
          size="middle"
          // UX-05：加载失败时不再渲染「暂无数据」空态（上方 StateError 已如实呈现
          // 失败原因与重试入口），避免把失败读成空列表（ExecutorPackagesPage 同款）
          // UI-08：首屏（无数据未出错）以骨架屏替代 Spin；翻页/刷新仍走表格 loading。
          locale={loadError
            ? { emptyText: null }
            : (shouldShowSkeleton(loading, loadError, items.length)
              ? { emptyText: <PageSkeleton variant="table" /> }
              : undefined)}
        />
      )}

      <Drawer
        title={detail ? `${detail.slug} ${detail.currentVersion ?? ''}` : ''}
        // antd 6：width 已并入 size（number|string|'large'|'default'）——
        // 窄屏 '100%' 满宽，桌面 860px 固定宽
        size={isMobile ? '100%' : 860}
        open={detail !== null}
        onClose={() => setDetail(null)}
        afterOpenChange={drawerA11y.afterOpenChange}
        destroyOnHidden
      >
        {/* A11Y-DRAWER-01：内容包一层 ref 定位容器——焦点首站查询收窄到本抽屉 */}
        <div ref={drawerA11y.contentRef}>
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
                    <Space style={{ marginBottom: 12 }}>
                      <Button
                        type="primary"
                        size="small"
                        disabled={detail.status !== 'published'}
                        onClick={() => void openAssign(detail)}
                      >
                        {t('sops.assign')}
                      </Button>
                      <Text type="secondary">{t('sops.assignHint')}</Text>
                    </Space>
                    <Table<SopAssignment> rowKey="id" columns={assignmentColumns} dataSource={assignments} pagination={false} size="small" />
                    {assignments.some((a) => (media[a.id]?.length ?? 0) > 0) && (
                      <div style={{ marginTop: 16 }}>
                        <Text strong>{t('sops.mediaTitle')}</Text>
                        {assignments
                          .filter((a) => (media[a.id]?.length ?? 0) > 0)
                          .flatMap((a) =>
                            (media[a.id] ?? []).map((m) => (
                              <div key={m.id} style={{ marginTop: 4 }}>
                                <Button size="small" onClick={() => void sopsApi.viewMedia(m.id).catch(() => message.error(t('sops.mediaViewFailed')))}>
                                  {t('sops.mediaView')}
                                </Button>
                                <Text style={{ marginLeft: 8 }}>
                                  {m.name} · {Math.round(m.sizeBytes / 1024)}KB · {formatDateTime(m.createdAt)}
                                </Text>
                              </div>
                            )),
                          )}
                      </div>
                    )}
                    {assignments.some((a) => (clarifications[a.id]?.length ?? 0) > 0) && (
                      <div style={{ marginTop: 16 }}>
                        {assignments
                          .filter((a) => (clarifications[a.id]?.length ?? 0) > 0)
                          .flatMap((a) =>
                            (clarifications[a.id] ?? []).map((c) => (
                              <div key={c.id} style={{ marginBottom: 12 }}>
                                <Text strong>
                                  #{c.round} · {c.resolution ? sopClarResolutionLabel(c.resolution, t) : t('sops.clarResolution.pending')}
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
                                    onClick={() => { setReplyTarget({ assignmentId: a.id, clarificationId: c.id }); setReply({ resolution: 'answered', answer: '', amendedYaml: '', amendedBody: '' }); }}
                                  >
                                    {t('sops.reply')}
                                  </Button>
                                )}
                                {/* 升级终态：接管答复不投递（执行器已按升级收尾），重派即恢复路径 */}
                                {c.resolution === 'escalated_to_human' && TERMINAL_ASSIGNMENT_STATUSES.includes(a.status) && (
                                  <Tooltip title={t('sops.reassignEscalatedHint')}>
                                    <Text type="warning" style={{ marginLeft: 8 }}>{t('sops.escalatedNotDelivered')}</Text>
                                  </Tooltip>
                                )}
                                <Paragraph style={{ marginBottom: 4 }}>{c.question}</Paragraph>
                                {/* 澄清附件（截图/录屏）——此前在 UI 不可见，复核全凭文字 */}
                                {(c.mediaRefsJson?.length ?? 0) > 0 && (
                                  <Paragraph style={{ marginBottom: 4 }}>
                                    <Text type="secondary">{t('sops.mediaRefsLabel')}：</Text>
                                    {(c.mediaRefsJson ?? []).map((ref) => (
                                      <Button
                                        key={ref.url}
                                        size="small"
                                        style={{ marginRight: 8 }}
                                        onClick={() => void viewClarificationMedia(ref.url)}
                                      >
                                        {t('sops.mediaView')} · {sopMediaKindLabel(ref.kind, t)}
                                      </Button>
                                    ))}
                                  </Paragraph>
                                )}
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
        </div>
      </Drawer>

      <Modal
        title={t('sops.newDraft')}
        open={draftOpen}
        onOk={() => void createDraft()}
        onCancel={() => setDraftOpen(false)}
        confirmLoading={creatingDraft}
        width={720}
        okText={t('sops.create')}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          <Input
            placeholder="slug (daily-report)"
            value={draft.slug}
            maxLength={128}
            onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
          />
          {/* maxLength 对齐 DraftSopDto @MaxLength(255)：超长输入在输入端截断，
              不等后端 400（弹窗里无表单回显，400 只剩一条泛化 toast） */}
          <Input
            placeholder={t('sops.col.title')}
            value={draft.title}
            maxLength={255}
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
          {/* SOPS-UI-01：原生 <select className="ant-input"> 换 antd Select——
              原生控件不吃暗色主题，下拉是白底黑字，与其余表单控件割裂 */}
          <Select
            style={{ width: '100%' }}
            value={reply.resolution}
            onChange={(v) => setReply({ ...reply, resolution: v as 'answered' | 'sop_amended' })}
            options={[
              { value: 'answered', label: t('sops.replyAnswered') },
              { value: 'sop_amended', label: t('sops.replyAmended') },
            ]}
          />
          <Input.TextArea
            rows={5}
            placeholder={t('sops.replyPlaceholder')}
            value={reply.answer}
            // maxLength 对齐 HumanReplyDto @MaxLength(8000)：答复正文在后端是
            // 硬校验，超长提交只剩一条泛化失败 toast，用户长文当场丢失。
            maxLength={8000}
            onChange={(e) => setReply({ ...reply, answer: e.target.value })}
          />
          {reply.resolution === 'sop_amended' && (
            <>
              <Input.TextArea
                rows={8}
                placeholder={t('sops.replyAmendedPlaceholder')}
                value={reply.amendedYaml}
                onChange={(e) => setReply({ ...reply, amendedYaml: e.target.value })}
              />
              {/* B-14：修订正文入口——API 支持 amendedBodyMarkdown，修订可只改正文 */}
              <Input.TextArea
                rows={6}
                placeholder={t('sops.replyBodyPlaceholder')}
                value={reply.amendedBody}
                onChange={(e) => setReply({ ...reply, amendedBody: e.target.value })}
              />
            </>
          )}
        </Space>
      </Modal>
      <Modal
        title={t('sops.assignTitle')}
        open={assignTarget !== null}
        onOk={() => void submitAssign()}
        onCancel={() => setAssignTarget(null)}
        confirmLoading={assigning}
        width={620}
        okText={t('sops.assignSubmit')}
        okButtonProps={{ disabled: !assignForm.executorId }}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          {assignable.length === 0 && (
            <Alert type="warning" showIcon message={t('sops.assignEmpty')} />
          )}
          <Select
            style={{ width: '100%' }}
            showSearch
            // 版本随 SOP 修订持续增长，键入过滤；label 含版本号与内容摘要
            optionFilterProp="label"
            placeholder={t('sops.assignVersion')}
            value={assignForm.version || undefined}
            onChange={(v) => setAssignForm({ ...assignForm, version: v })}
            options={versions.map((v) => ({
              value: v.version,
              label: `${v.version} (${v.contentHash.slice(0, 8)}…)`,
            }))}
          />
          <Select
            style={{ width: '100%' }}
            showSearch
            optionFilterProp="label"
            placeholder={t('sops.assignExecutorPlaceholder')}
            value={assignForm.executorId || undefined}
            onChange={(v) => setAssignForm({ ...assignForm, executorId: v })}
            options={assignable.map((e) => ({
              value: e.id,
              label: `${e.appName} (${e.address}) · ${e.agentCapabilities.join(',')}`,
            }))}
          />
          <Text type="secondary">{t('sops.assignNote')}</Text>
        </Space>
      </Modal>
    </div>
  );
}
