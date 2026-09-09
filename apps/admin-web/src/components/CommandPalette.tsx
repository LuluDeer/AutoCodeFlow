/**
 * FEAT-09: 全局搜索 / 命令面板（⌘K / Ctrl+K 唤起），MainLayout 全局挂载。
 *
 * ── 数据契约（四路并行、防抖 300ms、序号守卫） ──────────────────────────────
 *   任务      GET /tasks?page=1&pageSize=50&name=<kw>       → PageResult<Task>
 *             name 为后端 ILIKE %kw% 模糊参数（task.service.ts），服务端先过滤
 *             出一页候选，前端再做一次客户端兜底包含匹配；
 *   执行器    GET /executors                                → Executor[]
 *             无搜索参数、无分页（全量数组）；
 *   应用      GET /applications                             → Application[]
 *             无搜索参数（全量数组）；
 *   执行记录  GET /tasks/executions/all?page=1&pageSize=5   → PageResult<TaskExecution>
 *             后端固定 createdAt DESC —— 即"最近 5 条"，客户端按 taskName
 *             包含匹配后直达 /tasks/:taskId/executions/:execId。
 *
 * ── 取舍说明（README 注） ───────────────────────────────────────────────────
 * 搜索实现是"客户端包含匹配（小写化）已返回页数据"，并非后端全文检索：
 *   - tasks 是唯一带服务端过滤的分组（name ILIKE 预过滤一页 50 条），执行器/
 *     应用拉全量、执行记录取最近 5 条后前端过滤——当前规模下最省事的方案；
 *   - 已知局限：执行器/应用数量增长后全量拉取变贵；tasks 命中数超过一页时
 *     只能搜到首页数据。
 * 未来服务端搜索升级点：executors/applications 端点补 ?name= 模糊参数、tasks
 * 换数据库全文索引/pg_trgm、执行记录改用 allExecutions 已有的 taskName 服务端
 * ILIKE 参数——四处请求改为透传关键词即可，本组件 UI/分组/键盘导航均无需变动。
 *
 * ── 交互 ───────────────────────────────────────────────────────────────────
 *   ⌘K / Ctrl+K window keydown 全局唤起/再按切换（焦点在输入框内同样生效）；
 *   Esc 关闭（Modal keyboard 默认行为）；↑↓ 循环选择 + Enter 跳转详情：
 *   任务 → /tasks/:id，执行器 → /executors/:id，应用 → /applications/:id，
 *   执行记录 → /tasks/:taskId/executions/:execId（取最近执行）。
 *   无权限页面跳转后由既有路由守卫（RequireAdmin 等）兜底，本组件不判角色。
 *
 * ── UI-11 动作区（计划书 §6.3：新建任务/触发/暂停） ─────────────────────────
 *   在四搜索分组之前渲染「操作」分组（始终可见、不参与关键词过滤，保证零输入
 *   即可键盘直达）：
 *   - 静态动作：新建任务 → /tasks/new（路由已存在）；创建应用 → /applications
 *     （无独立创建路由，ApplicationListPage 内 Modal 创建，跳列表页引导；
 *     isAdmin 门控——普通用户该写面后端全链 @Roles(ADMIN)，隐藏优于 403）；
 *   - 任务行内动作：搜索命中任务后，每个任务条目按 status 动态附「触发」
 *     （active/paused 均可，对齐 TaskListPage 不限 status）+「暂停」（active）
 *     或「恢复」（paused）——POST /tasks/:id/trigger|pause|resume，失败 toast
 *     走 getErrMsg（与列表页同语义），成功 message 提示并跳任务详情。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { Input, Modal, Typography, message, theme } from 'antd';
import type { InputRef } from 'antd';
import {
  AppstoreOutlined,
  ClusterOutlined,
  HistoryOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { tasksApi } from '../api/tasks';
import type { Task, TaskExecution } from '../api/tasks';
import { executorsApi } from '../api/executors';
import type { Executor } from '../api/executors';
import { applicationsApi } from '../api/applications';
import type { Application } from '../api/applications';
import { useAuthStore, isAdminUser } from '../store/auth';
import { getErrMsg } from '../utils/error';
import { useDebounce } from '../hooks/useDebounce';

const { Text } = Typography;

/** 每组最多展示条数（组内截断，不做虚拟滚动） */
const MAX_PER_GROUP = 5;
/** tasks 列表单页条数：后端 name ILIKE 预过滤后的候选池 */
const TASK_PAGE_SIZE = 50;
/** 执行记录取最近条数（后端 createdAt DESC 定序） */
const EXECUTION_PAGE_SIZE = 5;
/** 输入防抖毫秒数 */
const DEBOUNCE_MS = 300;

type EntityKind = 'action' | 'task' | 'execution' | 'executor' | 'application';

/** 分组渲染顺序：操作 → 任务 → 执行记录 → 执行器 → 应用 */
const GROUP_ORDER: EntityKind[] = ['action', 'task', 'execution', 'executor', 'application'];

const GROUP_META: Record<EntityKind, { title: string; icon: ReactNode }> = {
  action: { title: '操作', icon: <PlusOutlined /> },
  task: { title: '任务', icon: <ThunderboltOutlined /> },
  execution: { title: '执行记录', icon: <HistoryOutlined /> },
  executor: { title: '执行器', icon: <ClusterOutlined /> },
  application: { title: '应用', icon: <AppstoreOutlined /> },
};

interface PaletteItem {
  key: string;
  id: string;
  title: string;
  description?: string;
  /** execution 跳转需要所属任务 id */
  taskId?: string;
  /** task 条目按 status 动态附带的行内动作键（触发/暂停/恢复） */
  actions?: TaskActionKind[];
}

/** UI-11 任务行内动作键 */
type TaskActionKind = 'trigger' | 'pause' | 'resume';

const TASK_ACTION_META: Record<TaskActionKind, { label: string; icon: ReactNode }> = {
  trigger: { label: '触发', icon: <ThunderboltOutlined /> },
  pause: { label: '暂停', icon: <PauseCircleOutlined /> },
  resume: { label: '恢复', icon: <PlayCircleOutlined /> },
};

/** 静态动作（操作分组，始终可见） */
interface StaticAction {
  key: string;
  /** 与 PaletteItem.id 对齐，供扁平条目占位复用 */
  id: string;
  title: string;
  description: string;
  to?: string;
  /** admin-only 动作（写面后端全链 @Roles(ADMIN)，对齐 ApplicationListPage 门控） */
  adminOnly?: boolean;
  icon: ReactNode;
}

const STATIC_ACTIONS: StaticAction[] = [
  {
    key: 'action-new-task',
    id: 'new-task',
    title: '新建任务',
    description: '跳转任务创建表单',
    to: '/tasks/new',
    icon: <PlusOutlined />,
  },
  {
    key: 'action-new-application',
    id: 'new-application',
    title: '创建应用',
    description: '前往应用列表（列表页内创建）',
    to: '/applications',
    adminOnly: true,
    icon: <AppstoreOutlined />,
  },
];

interface GroupResult<T> {
  status: 'idle' | 'loading' | 'ok' | 'error';
  items: T[];
}

interface SearchResults {
  task: GroupResult<Task>;
  execution: GroupResult<TaskExecution>;
  executor: GroupResult<Executor>;
  application: GroupResult<Application>;
}

interface Section {
  kind: EntityKind;
  items: PaletteItem[];
  /** 静态动作分组专用（kind==='action' 时生效） */
  statics?: StaticAction[];
  offset: number;
}

const IDLE_RESULTS: SearchResults = {
  task: { status: 'idle', items: [] },
  execution: { status: 'idle', items: [] },
  executor: { status: 'idle', items: [] },
  application: { status: 'idle', items: [] },
};

const LOADING_RESULTS: SearchResults = {
  task: { status: 'loading', items: [] },
  execution: { status: 'loading', items: [] },
  executor: { status: 'loading', items: [] },
  application: { status: 'loading', items: [] },
};

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const nav = useNavigate();
  const { token } = theme.useToken();
  const user = useAuthStore((s) => s.user);
  /** R5 角色门控：admin-only 静态动作/行内动作按此出键（对齐 ApplicationListPage） */
  const isAdmin = isAdminUser(user);
  const [keyword, setKeyword] = useState('');
  const debouncedKeyword = useDebounce(keyword, DEBOUNCE_MS);
  const [results, setResults] = useState<SearchResults>(IDLE_RESULTS);
  const [activeIndex, setActiveIndex] = useState(0);
  /** UI-11 行内动作在途 id（触发/暂停/恢复 loading 态，与 TaskListPage togglingId 同语义） */
  const [actingKey, setActingKey] = useState<string | null>(null);
  /** 请求序号守卫：每次新搜索递增，过期响应落地前被丢弃 */
  const seqRef = useRef(0);
  const inputRef = useRef<InputRef>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  openRef.current = open;

  // 每次打开重置为全新搜索，并使上一轮在途请求失效
  useEffect(() => {
    if (!open) return;
    seqRef.current += 1;
    setKeyword('');
    setResults(IDLE_RESULTS);
    setActiveIndex(0);
  }, [open]);

  // 打开（内容挂载）后聚焦搜索框
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  // 防抖 300ms 后并行请求四个列表端点；各路独立 catch —— 单组失败降级为
  // 「加载失败」行，不阻塞其他组。取消以序号守卫实现（过期响应直接丢弃），
  // 与 api 层薄封装/既有 mock 风格兼容，语义等价于 AbortController。
  useEffect(() => {
    const kw = debouncedKeyword.trim();
    if (!kw) {
      seqRef.current += 1;
      setResults(IDLE_RESULTS);
      return;
    }
    const seq = ++seqRef.current;
    setResults(LOADING_RESULTS);
    const alive = () => seqRef.current === seq;

    tasksApi
      .list({ page: 1, pageSize: TASK_PAGE_SIZE, name: kw })
      .then((page) => {
        if (!alive()) return;
        setResults((prev) => ({ ...prev, task: { status: 'ok', items: page.items ?? [] } }));
      })
      .catch(() => {
        if (!alive()) return;
        setResults((prev) => ({ ...prev, task: { status: 'error', items: [] } }));
      });

    executorsApi
      .list()
      .then((items) => {
        if (!alive()) return;
        setResults((prev) => ({ ...prev, executor: { status: 'ok', items: items ?? [] } }));
      })
      .catch(() => {
        if (!alive()) return;
        setResults((prev) => ({ ...prev, executor: { status: 'error', items: [] } }));
      });

    applicationsApi
      .list()
      .then((items) => {
        if (!alive()) return;
        setResults((prev) => ({ ...prev, application: { status: 'ok', items: items ?? [] } }));
      })
      .catch(() => {
        if (!alive()) return;
        setResults((prev) => ({ ...prev, application: { status: 'error', items: [] } }));
      });

    tasksApi
      .allExecutions({ page: 1, pageSize: EXECUTION_PAGE_SIZE })
      .then((page) => {
        if (!alive()) return;
        setResults((prev) => ({ ...prev, execution: { status: 'ok', items: page.items ?? [] } }));
      })
      .catch(() => {
        if (!alive()) return;
        setResults((prev) => ({ ...prev, execution: { status: 'error', items: [] } }));
      });
  }, [debouncedKeyword]);

  const kwLower = debouncedKeyword.trim().toLowerCase();

  /** UI-11 静态动作按角色过滤（admin-only 项对普通用户隐藏，优于跳转后 403） */
  const visibleActions = useMemo(
    () => STATIC_ACTIONS.filter((a) => !a.adminOnly || isAdmin),
    [isAdmin],
  );

  // 客户端包含匹配（小写化）已返回页数据，每组截断前 5 条，并计算扁平索引偏移
  const sections = useMemo<Section[]>(() => {
    const contains = (s?: string | null) => !!s && s.toLowerCase().includes(kwLower);
    const byKind: Record<EntityKind, PaletteItem[]> = {
      action: [],
      task: results.task.items
        .filter((t) => contains(t.name) || contains(t.description))
        .slice(0, MAX_PER_GROUP)
        .map((t) => ({
          key: `task-${t.id}`,
          id: t.id,
          title: t.name,
          description: [t.status, t.triggerType].filter(Boolean).join(' · '),
          // UI-11 行内动作：触发不限 status（对齐 TaskListPage 列表按钮）；
          // 暂停/恢复按 status 二选一（active→暂停，paused→恢复）
          actions:
            t.status === 'paused'
              ? ['trigger', 'resume']
              : ['trigger', 'pause'],
        })),
      execution: results.execution.items
        .filter((x) => contains(x.taskName) || contains(x.id))
        .slice(0, MAX_PER_GROUP)
        .map((x) => ({
          key: `execution-${x.id}`,
          id: x.id,
          taskId: x.taskId,
          title: x.taskName || x.taskId,
          description: [x.status, x.startTime].filter(Boolean).join(' · '),
        })),
      executor: results.executor.items
        .filter((e) => contains(e.appName) || contains(e.address))
        .slice(0, MAX_PER_GROUP)
        .map((e) => ({
          key: `executor-${e.id}`,
          id: e.id,
          title: e.appName,
          description: [e.address, e.status].filter(Boolean).join(' · '),
        })),
      application: results.application.items
        .filter((a) => contains(a.name) || contains(a.description))
        .slice(0, MAX_PER_GROUP)
        .map((a) => ({
          key: `application-${a.id}`,
          id: a.id,
          title: a.name,
          description: a.description || a.version,
        })),
    };
    let offset = 0;
    return GROUP_ORDER.map((kind) => {
      const section: Section = {
        kind,
        items: byKind[kind],
        statics: kind === 'action' ? visibleActions : undefined,
        offset,
      };
      offset += byKind[kind].length;
      return section;
    });
  }, [results, kwLower, visibleActions]);

  /** 扁平条目：kind + 实体 item（action 组为占位）+ 可选静态动作引用 */
  interface FlatEntry {
    kind: EntityKind;
    item: PaletteItem;
    action?: StaticAction;
  }

  const flatItems = useMemo<FlatEntry[]>(
    () =>
      sections.flatMap<FlatEntry>((s) =>
        s.kind === 'action'
          ? (s.statics ?? []).map((action) => ({
              kind: s.kind,
              // 占位 item（静态动作不携带实体详情，title 供键盘执行无歧义）
              item: { key: action.key, id: action.id, title: action.title },
              action,
            }))
          : s.items.map((item) => ({
              kind: s.kind,
              item,
              action: undefined,
            })),
      ),
    [sections],
  );

  const go = useCallback(
    (kind: EntityKind, item: PaletteItem) => {
      if (kind === 'task') nav(`/tasks/${item.id}`);
      else if (kind === 'executor') nav(`/executors/${item.id}`);
      else if (kind === 'application') nav(`/applications/${item.id}`);
      else if (kind === 'action') nav(`/tasks/new`);
      else nav(`/tasks/${item.taskId}/executions/${item.id}`);
      onOpenChange(false);
    },
    [nav, onOpenChange],
  );

  /** UI-11 静态动作执行：按预置路由跳转 */
  const runStaticAction = useCallback(
    (action: StaticAction) => {
      if (action.to) nav(action.to);
      onOpenChange(false);
    },
    [nav, onOpenChange],
  );

  /** UI-11 任务行内动作：触发/暂停/恢复（语义对齐 TaskListPage 单行操作） */
  const runTaskAction = useCallback(
    async (kind: TaskActionKind, item: PaletteItem) => {
      if (actingKey) return;
      setActingKey(item.key);
      const label = TASK_ACTION_META[kind].label;
      try {
        if (kind === 'trigger') {
          await tasksApi.trigger(item.id);
          message.success(`已触发: ${item.title}`);
        } else if (kind === 'pause') {
          await tasksApi.pause(item.id);
          message.success('已暂停');
        } else {
          await tasksApi.resume(item.id);
          message.success('已恢复');
        }
        nav(`/tasks/${item.id}`);
        onOpenChange(false);
      } catch (err: unknown) {
        message.error(getErrMsg(err, `${label}失败`));
      } finally {
        setActingKey(null);
      }
    },
    [actingKey, nav, onOpenChange],
  );

  // ⌘K / Ctrl+K 全局唤起/再按切换：window keydown，输入框焦点内同样生效
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        onOpenChange(!openRef.current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onOpenChange]);

  // 结果集变化后高亮回到第一项，避免残留索引越组
  useEffect(() => {
    setActiveIndex(0);
  }, [debouncedKeyword]);

  // 高亮行跟随滚动（jsdom 无 scrollIntoView 实现，须守卫）
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-palette-index="${activeIndex}"]`);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, sections]);

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flatItems.length) setActiveIndex((i) => (i + 1) % flatItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flatItems.length) setActiveIndex((i) => (i - 1 + flatItems.length) % flatItems.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = flatItems[Math.min(activeIndex, Math.max(flatItems.length - 1, 0))];
      if (!entry) return;
      // UI-11 操作分组条目走静态动作执行器（to 路由各异），其余走详情跳转
      if (entry.kind === 'action' && entry.action) runStaticAction(entry.action);
      else go(entry.kind, entry.item);
    } else if (e.key === 'Escape') {
      // 显式关闭（与 Modal keyboard 行为幂等，保证任意 antd 版本下 Esc 均生效）
      onOpenChange(false);
    }
  };

  const renderSection = (section: Section) => {
    const meta = GROUP_META[section.kind];
    // 操作分组：静态动作始终可见（角色过滤后非空即渲染）
    if (section.kind === 'action') {
      if (!section.statics?.length) return null;
      return (
        <div key={section.kind} style={{ marginBottom: 4 }}>
          <Text type="secondary" style={{ fontSize: 12, paddingLeft: 4 }}>
            {meta.icon} {meta.title}
          </Text>
          <div role="group" aria-label="快捷操作">
            {section.statics.map((action, idx) => {
              const flatIdx = section.offset + idx;
              const active = flatIdx === activeIndex;
              return (
                <div
                  key={action.key}
                  role="option"
                  aria-selected={active}
                  data-palette-index={flatIdx}
                  onClick={() => runStaticAction(action)}
                  onMouseEnter={() => setActiveIndex(flatIdx)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '7px 10px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    background: active ? token.colorBgTextHover : undefined,
                  }}
                >
                  <span style={{ fontSize: 15, color: token.colorPrimary, display: 'inline-flex' }}>
                    {action.icon}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 14,
                        color: token.colorText,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {action.title}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 12,
                        color: token.colorTextSecondary,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {action.description}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      );
    }
    // 空闲未搜索、或搜索完成但该组无匹配 → 整组隐藏（配合全局空态）
    const res = results[section.kind];
    const hasContent =
      res.status === 'loading' || res.status === 'error' || section.items.length > 0;
    if (!hasContent) return null;
    return (
      <div key={section.kind} style={{ marginBottom: 4 }}>
        <Text type="secondary" style={{ fontSize: 12, paddingLeft: 4 }}>
          {meta.icon} {meta.title}
        </Text>
        {res.status === 'loading' && (
          <Text type="secondary" style={{ display: 'block', padding: '4px 8px', fontSize: 12 }}>
            搜索中…
          </Text>
        )}
        {res.status === 'error' && (
          <Text type="warning" style={{ display: 'block', padding: '4px 8px', fontSize: 12 }}>
            {meta.title}加载失败
          </Text>
        )}
        {res.status === 'ok' && section.items.length > 0 && (
          <div role="group" aria-label={`${meta.title}搜索结果`}>
            {section.items.map((item, idx) => {
              const flatIdx = section.offset + idx;
              const active = flatIdx === activeIndex;
              return (
                <div
                  key={item.key}
                  role="option"
                  aria-selected={active}
                  data-palette-index={flatIdx}
                  onClick={() => go(section.kind, item)}
                  onMouseEnter={() => setActiveIndex(flatIdx)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '7px 10px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    background: active ? token.colorBgTextHover : undefined,
                  }}
                >
                  <span style={{ fontSize: 15, color: token.colorPrimary, display: 'inline-flex' }}>
                    {meta.icon}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 14,
                        color: token.colorText,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.title}
                    </span>
                    {item.description && (
                      <span
                        style={{
                          display: 'block',
                          fontSize: 12,
                          color: token.colorTextSecondary,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {item.description}
                      </span>
                    )}
                  </span>
                  {/* UI-11 任务行内动作：触发/暂停/恢复（点击不冒泡跳转，键盘可达） */}
                  {section.kind === 'task' && isAdmin && item.actions && (
                    <span
                      role="group"
                      aria-label={`${item.title}快捷动作`}
                      onClick={(e) => e.stopPropagation()}
                      style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }}
                    >
                      {item.actions.map((ak) => {
                        const am = TASK_ACTION_META[ak];
                        return (
                          <button
                            key={ak}
                            type="button"
                            aria-label={`${am.label}任务 ${item.title}`}
                            disabled={actingKey !== null && actingKey !== item.key}
                            onClick={() => runTaskAction(ak, item)}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 3,
                              padding: '2px 8px',
                              fontSize: 12,
                              lineHeight: '18px',
                              borderRadius: 6,
                              border: `1px solid ${token.colorBorderSecondary}`,
                              background: token.colorBgContainer,
                              color: token.colorTextSecondary,
                              cursor: actingKey ? 'not-allowed' : 'pointer',
                            }}
                          >
                            {am.icon}
                            {am.label}
                          </button>
                        );
                      })}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const hasError = GROUP_ORDER.some(
    (kind) => kind !== 'action' && results[kind].status === 'error',
  );
  const allSettled = GROUP_ORDER.every(
    (kind) => kind === 'action' || results[kind].status === 'ok',
  );
  // 操作分组始终有静态动作兜底，全局空态仅在搜索分组全空时出现
  const showGlobalEmpty = allSettled && !hasError && flatItems.length === 0;

  return (
    <Modal
      open={open}
      onCancel={() => onOpenChange(false)}
      footer={null}
      width={560}
      destroyOnHidden
      closable={false}
      style={{ top: 88 }}
      styles={{ body: { paddingTop: 12 } }}
    >
      <Input
        ref={inputRef}
        size="large"
        variant="borderless"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onKeyDown={onInputKeyDown}
        placeholder="搜索任务、执行记录、执行器、应用，或输入指令…"
        prefix={<SearchOutlined style={{ color: token.colorTextTertiary }} />}
        allowClear
      />
      <div ref={listRef} style={{ maxHeight: 380, overflowY: 'auto' }}>
        {sections.map(renderSection)}
        {showGlobalEmpty && (
          <Text type="secondary" style={{ display: 'block', textAlign: 'center', padding: '16px 0', fontSize: 13 }}>
            未找到匹配结果
          </Text>
        )}
      </div>
      <div
        style={{
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          paddingTop: 8,
          display: 'flex',
          gap: 16,
        }}
      >
        <Text type="secondary" style={{ fontSize: 12 }}>↑↓ 选择</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>Enter 跳转</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>Esc 关闭</Text>
        <Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>
          任务行可悬停/键盘直达快捷动作
        </Text>
      </div>
    </Modal>
  );
}
