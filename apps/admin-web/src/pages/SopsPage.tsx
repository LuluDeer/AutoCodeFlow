import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  Popconfirm,
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
// 归档被 409 拒绝时的二段确认（取消指派 → 重试归档）
import { Modal as confirmModal } from '../utils/modal';
// 归档/恢复的 409（有未结束指派）要透出后端文案而非通用失败
import { showApiError } from '../utils/error';
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
// UIUX-F-3：列表 load 序号守卫（与 AgentSessionsPage 共用同一实现）
import { useRaceGuard } from '../utils/raceGuard';
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
  // 2026-10-23：归档/恢复逐行 loading（同一时刻只允许一个动作在飞）。
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<Sop | null>(null);
  // 2026-10-23：详情抽屉的 Tab 改为**受控**。原因：归档被 409 拒绝时，
  // 「先看看这些未结束指派」需要直接把抽屉打开到「指派」Tab——非受控 Tab
  // 只能停在默认的第一个 Tab，用户还得自己再点一次。
  const [detailTab, setDetailTab] = useState('contract');
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
  // SOP-PUBLISH-UI-01（P1 审计）：发布对话框。后端 `POST /sop/:id/publish` 早已
  // 存在，但 sopsApi.publish 在本仓**零调用方**——UI 创建的 SOP 永远无法发布
  // （只能 curl）。契约（PublishSopDto）：bump ∈ patch/minor/major（缺省 patch）、
  // changelog ≤2000 字；成功返回 { sop, version }。发布是重要动作，弹窗即确认：
  // 明确选定版本档位并点「确认发布」后才发请求。
  const [publishTarget, setPublishTarget] = useState<Sop | null>(null);
  const [publishForm, setPublishForm] = useState<{ bump: 'patch' | 'minor' | 'major'; changelog: string }>({
    bump: 'patch',
    changelog: '',
  });
  const [publishing, setPublishing] = useState(false);
  // 指派媒体（截图/录屏——执行器回传的证据，此前在 UI 不可见）
  const [media, setMedia] = useState<Record<string, SopMedia[]>>({});

  // B-14：silent 轮询不闪 loading（定时器每 15s 触发，spinner 抖动是纯噪音）
  // UX-05（对齐 ExecutorPackagesPage/TaskTemplatesPage 先例）：首次/手动加载失败
  // 必须落到页内错误块——此前只弹一条一闪而过的 toast，表格停在「暂无数据」
  // 空态，把读取失败谎报成「还没有任何 SOP」。
  const [loadError, setLoadError] = useState<unknown>(null);
  // UIUX-F-3（审计 P2-2，对齐 AgentSessionsPage 同名实现的 RACE-POLL 守卫）：
  // load 有三个并发入口——翻页 effect、15s 静默轮询、写后手动刷新。无「谁是
  // 最新」判据时，第 1 页的慢响应可晚于第 2 页到达：分页器停在第 2 页而表格
  // 显示第 1 页；轮询旧页响应也能盖掉刚翻到的新页。序号守卫同款：过期响应
  // 一律丢弃，silent 与非 silent 共用同一判据（否则轮询仍可能盖掉手动刷新）。
  const raceGuard = useRaceGuard();
  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const seq = raceGuard.next();
    if (!opts?.silent) setLoading(true);
    try {
      const res = await sopsApi.list({ page, pageSize });
      if (!raceGuard.isLatest(seq)) return; // 过期响应：丢弃（不覆盖更新的一页）
      setItems(res.items);
      setTotal(res.total);
      // 成功即清错误（后台静默拍自愈同效）
      setLoadError(null);
    } catch (err: unknown) {
      if (!raceGuard.isLatest(seq)) return;
      // B-14：后台轮询失败静默——连续弹 message 是噪音，列表保留旧数据
      if (!opts?.silent) {
        setLoadError(err);
        message.error(t('sops.loadFailed'));
      }
    } finally {
      if (raceGuard.isLatest(seq) && !opts?.silent) setLoading(false);
    }
  }, [page, pageSize, t, raceGuard]);

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

  const openDetail = useCallback(async (sop: Sop, tab = 'contract') => {
    // tab 默认回到首个 Tab；归档 409 的「查看指派」传 'assignments'。
    // 用参数而不是「先 openDetail 再 setDetailTab」：后者依赖 React 批处理
    // 与 effect 顺序，改动一处 state 初始化就可能翻转，参数化不依赖时序。
    setDetailTab(tab);
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

  // R65：审计深链 —— /sops?sop=<id> 打开对应详情抽屉。
//
// 背景：审计页此前对 sop.* 动作只显示一个 id（能查到、点不进去）。SOP 没有独立详情路由，
// 只有这一页 + 详情抽屉，所以用查询参数当深链入口。
// 两个细节：
//  · **不在当前页也要能打开** —— 审计行指向的 SOP 大概率不在第一页，故走 sopsApi.get(id)
//    单取，而不是只在 items 里找（否则深链有一半时候静默失效，比没有深链更糟）。
//  · `deepLinkApplied` 记住已处理过的 id：轮询每 15s 刷新 items 会重跑本 effect，
//    没有它就会反复重开抽屉、打断用户正在看的详情。
const [searchParams] = useSearchParams();
const deepLinkId = searchParams.get('sop');
const deepLinkApplied = useRef<string | null>(null);
useEffect(() => {
  if (!deepLinkId) return;
  if (deepLinkApplied.current === deepLinkId) return;
  if (detail?.id === deepLinkId) {
    deepLinkApplied.current = deepLinkId;
    return;
  }
  deepLinkApplied.current = deepLinkId;
  const fromList = items.find((it) => it.id === deepLinkId);
  if (fromList) {
    void openDetail(fromList);
    return;
  }
  void sopsApi
    .get(deepLinkId)
    .then((sop) => openDetail(sop))
    .catch(() => {
      // 拿不到（已删/无权限）：回到列表，不弹错——用户只是点了一个失效链接
      deepLinkApplied.current = null;
    });
}, [deepLinkId, items, detail, openDetail]);
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

  // SOP-PUBLISH-UI-01：提交发布。成功后列表与抽屉同步刷新——与 mutateArchive
  // 同款口径：抽屉正开着同一张时用发布返回的**最新 sop** 重开（状态 Tag、
  // 版本号、版本历史立即反映，不必等 15s 轮询）。
  const submitPublish = useCallback(async () => {
    if (!publishTarget) return;
    setPublishing(true);
    try {
      const res = await sopsApi.publish(publishTarget.id, {
        bump: publishForm.bump,
        // 空白 changelog 不发字段（后端落 null），与「可选」语义一致
        changelog: publishForm.changelog.trim() || undefined,
      });
      message.success(t('sops.publish.ok', { version: res.version.version }));
      setPublishTarget(null);
      await load();
      if (detail?.id === res.sop.id) void openDetail(res.sop);
    } catch (err: unknown) {
      // 内容缺失 / 内容未变更（400）等后端口径经 showApiError 透出（有
      // errorCode 走本地化字典，没有回落后端 message），不吞成通用失败。
      showApiError(err, t('sops.publish.fail'));
    } finally {
      setPublishing(false);
    }
  }, [publishTarget, publishForm, detail?.id, load, openDetail, t]);

  /**
   * 查看澄清附件：平台路径 /api/sop/media/<id>（R35-A1 更正——旧记的
   * /api/agent-collab/media/<id> 从不是一条路由）→ 取尾部 id 经鉴权 blob 打开。
   * 取 id 而非直链：下载端点要 ADMIN JWT 头，裸 URL 给浏览器只会 401。
   */
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

  // 2026-10-23：归档 / 恢复。此前 `deprecated` 是死状态——SOP 只增不减，
  // 测试残留（实测 16 条 headless-smoke-*）永远留在列表里。
  // 语义：归档不删数据（版本/指派/澄清全保留），只停止派新单。
  const mutateArchive = useCallback(
    async (record: Sop, action: 'deprecate' | 'restore') => {
      setArchivingId(record.id);
      try {
        if (action === 'deprecate') {
          await sopsApi.deprecate(record.id);
          message.success(t('sops.archive.ok', { slug: record.slug }));
        } else {
          await sopsApi.restore(record.id);
          message.success(t('sops.restore.ok', { slug: record.slug }));
        }
        await load();
        // 抽屉正开着同一张 SOP 时同步刷新（否则状态 Tag 停留在旧值）
        if (detail?.id === record.id) void openDetail(record);
      } catch (err: unknown) {
        // 409「有未结束指派」是**可行动**的失败：此前只能去改库（cancelled 是
        // 零写入点的死状态）。这里直接给出下一步——确认后取消全部未结束指派
        // 并立即重试归档。
        const code = (err as { response?: { data?: { errorCode?: string } } })
          ?.response?.data?.errorCode;
        if (code === 'SOP_ARCHIVE_HAS_ACTIVE_ASSIGNMENTS') {
          // 2026-10-23：给两条路——**先看清楚再决定**（打开详情抽屉的指派 Tab），
          // 或直接取消并归档。只有「取消」一条路等于逼用户盲签：他不知道
          // 这些工单是谁的、跑到哪一步、取消会不会丢掉正在跑的结果。
          let openDetailAfterClose = false;
          confirmModal.confirm({
            title: t('sops.archive.cancelAssignmentsTitle', { slug: record.slug }),
            content: (
              <>
                <p style={{ marginBottom: 8 }}>{t('sops.archive.cancelAssignmentsDesc')}</p>
                <Button
                  size="small"
                  onClick={() => {
                    openDetailAfterClose = true;
                    // 直接打开详情（不赌 afterClose），再关掉确认框
                    void openDetail(record, 'assignments');
                    confirmModal.destroyAll?.();
                  }}
                >
                  {t('sops.archive.viewAssignments')}
                </Button>
              </>
            ),
            okText: t('sops.archive.cancelAssignmentsOk'),
            okButtonProps: { danger: true },
            cancelText: t('sops.cancel'),
            // 「先查看」不依赖 afterClose：antd 的关闭动画时机在 jsdom 下不可靠
            // （实测 afterClose 未触发，抽屉不打开）。点击时直接 openDetail，
            // 再让确认框自行关闭——打开抽屉与关闭弹窗互不依赖。
            afterClose: () => {
              if (openDetailAfterClose) {
                void openDetail(record, 'assignments');
              }
            },
            onOk: async () => {
              try {
                const r = await sopsApi.cancelAssignments(record.id);
                message.success(
                  t('sops.archive.cancelAssignmentsDone', { count: r.cancelled }),
                );
                // 取消后立即重试归档（用户上一步的意图不该丢）
                await sopsApi.deprecate(record.id);
                message.success(t('sops.archive.ok', { slug: record.slug }));
                await load();
                if (detail?.id === record.id) void openDetail(record);
              } catch (e: unknown) {
                showApiError(e, t('sops.archive.fail'));
              }
            },
          });
          return;
        }
        // 其余 409 / 失败要把后端口径原样透出——这类失败有明确下一步，
        // 吞成「操作失败」等于让运维去翻日志。
        // 用 if 分支而不是三元表达式：i18n 缺键守卫（i18n-key-check）只认
        // **静态字面量键**，`t(cond ? 'a' : 'b')` 会被判成「动态键」并拒绝。
        // 两处都是编译期已知的键，写成两个 t() 调用即可静态校验。
        if (action === 'deprecate') {
          showApiError(err, t('sops.archive.fail'));
        } else {
          showApiError(err, t('sops.restore.fail'));
        }
      } finally {
        setArchivingId(null);
      }
    },
    [detail?.id, load, openDetail, t],
  );

  const sopColumns: ColumnsType<Sop> = [
    { title: t('sops.col.slug'), dataIndex: 'slug', width: 200 },
    { title: t('sops.col.title'), dataIndex: 'title', ellipsis: true },
    { title: t('sops.col.status'), dataIndex: 'status', width: 110, render: (s: Sop['status']) => statusTag(s, t) },
    { title: t('sops.col.version'), dataIndex: 'currentVersion', width: 100, render: (v: string | null) => v ?? '—' },
    { title: t('sops.col.updatedAt'), dataIndex: 'updatedAt', width: 170, render: (v: string) => formatDateTime(v) },
    {
      title: t('sops.col.actions'),
      width: 190,
      render: (_, record) => (
        <Space size={4}>
          <Button size="small" onClick={() => void openDetail(record)}>
            {t('sops.view')}
          </Button>
          {record.status === 'deprecated' ? (
            <Popconfirm
              title={t('sops.restore.confirmTitle', { slug: record.slug })}
              description={t('sops.restore.confirmDesc')}
              okText={t('sops.restore.okBtn')}
              cancelText={t('sops.cancel')}
              onConfirm={() => void mutateArchive(record, 'restore')}
            >
              <Button size="small" data-testid={`sop-restore-${record.slug}`}
                loading={archivingId === record.id}>
                {t('sops.restore.btn')}
              </Button>
            </Popconfirm>
          ) : (
            <Popconfirm
              title={t('sops.archive.confirmTitle', { slug: record.slug })}
              description={t('sops.archive.confirmDesc')}
              okText={t('sops.archive.okBtn')}
              okButtonProps={{ danger: true }}
              cancelText={t('sops.cancel')}
              onConfirm={() => void mutateArchive(record, 'deprecate')}
            >
              <Button size="small" danger data-testid={`sop-archive-${record.slug}`}
                loading={archivingId === record.id}>
                {t('sops.archive.btn')}
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const versionColumns: ColumnsType<SopVersion> = [
    { title: t('sops.col.version'), dataIndex: 'version', width: 90 },
    { title: t('sops.col.contentHash'), dataIndex: 'contentHash', width: 130, render: (h: string) => <Text copyable={{ text: h }}>{h.slice(0, 12)}…</Text> },
    {
      title: t('sops.col.publishedBy'),
      dataIndex: 'publishedBy',
      width: 160,
      // P3-⑤（审计）：后端 publishedBy 存的是**主体标识**（人工 = `user:<id>`，
      // 代理工具 = `agent:tool-call`），响应不带用户名——裸渲染内部 ID「user:1」
      // 对运维零信息量。人工发布者恒为 ADMIN（控制器 @Roles(ADMIN)），
      // `user:<id>` 统一显示中性文案「管理员」；代理标识本身可读，原样保留。
      render: (v: string | null) => {
        if (!v) return '—';
        if (/^user:\d+$/.test(v)) return t('sops.publishedBy.admin');
        return v;
      },
    },
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

  // SOP-PUBLISH-UI-01：发布入口门控——已归档的 SOP 走「恢复」路径（恢复已
  // 发布过的直接回 published），不再提供发布入口；工作副本缺 front-matter 或
  // 正文时后端必 400（SOP_CONTENT_MISSING），按钮前置禁用并给原因。
  const publishable = !!detail
    && detail.status !== 'deprecated'
    && !!detail.frontMatterJson
    && !!detail.bodyMarkdown;

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
          // 2026-10-23：此前无 scroll——列宽合计 770（slug 200 + 状态 110 +
          // 版本 100 + 更新时间 170 + 操作 190）+ 标题弹性列最小 160 ≈ 930。
          // 抽屉/小窗下会把「操作」里的归档按钮挤到看不见，补横向滚动兜底。
          scroll={{ x: 940 }}
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
        // SOP-PUBLISH-UI-01：发布入口放抽屉 extra——三个 Tab 都可达（契约 Tab
        // 正是「要发布的工作副本」的上下文）；已归档/缺内容的行禁用并给原因。
        extra={
          detail && detail.status !== 'deprecated' && (
            <Tooltip title={publishable ? undefined : t('sops.publish.noContent')}>
              <Button
                type="primary"
                size="small"
                disabled={!publishable}
                data-testid={`sop-publish-${detail.slug}`}
                onClick={() => {
                  // 每次打开重置表单（上次输入的 changelog 不残留到别的 SOP）
                  setPublishForm({ bump: 'patch', changelog: '' });
                  setPublishTarget(detail);
                }}
              >
                {t('sops.publish.btn')}
              </Button>
            </Tooltip>
          )
        }
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
            activeKey={detailTab}
            onChange={setDetailTab}
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
            <Alert type="warning" showIcon title={t('sops.assignEmpty')} />
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
      {/* SOP-PUBLISH-UI-01：发布确认弹窗——弹窗即确认（选定版本档位 + 点
          「确认发布」才发请求），changelog 选填、≤2000 字对齐 PublishSopDto。 */}
      <Modal
        title={t('sops.publish.title', { slug: publishTarget?.slug ?? '' })}
        open={publishTarget !== null}
        onOk={() => void submitPublish()}
        onCancel={() => setPublishTarget(null)}
        confirmLoading={publishing}
        width={560}
        okText={t('sops.publish.confirmBtn')}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          <Select
            style={{ width: '100%' }}
            value={publishForm.bump}
            onChange={(v) => setPublishForm({ ...publishForm, bump: v })}
            options={[
              { value: 'patch', label: t('sops.publish.bump.patch') },
              { value: 'minor', label: t('sops.publish.bump.minor') },
              { value: 'major', label: t('sops.publish.bump.major') },
            ]}
          />
          <Input.TextArea
            rows={3}
            placeholder={t('sops.publish.changelogPlaceholder')}
            value={publishForm.changelog}
            // maxLength 对齐 PublishSopDto @MaxLength(2000)：超长提交只剩一条
            // 泛化失败 toast，用户长文当场丢失（与回复正文 maxLength 同款纪律）
            maxLength={2000}
            onChange={(e) => setPublishForm({ ...publishForm, changelog: e.target.value })}
          />
          <Text type="secondary">{t('sops.publish.note')}</Text>
        </Space>
      </Modal>
    </div>
  );
}
