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
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import '../i18n';
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

/**
 * UI-12：无障碍锚点常量。
 * - DIALOG_TITLE：弹层可访问名（antd Modal 自身已渲染 role="dialog" + aria-modal="true"，
 *   但 closable 且无 title 时 dialog 无名——用仅读屏可见的标题补 aria-labelledby）；
 * - LISTBOX_ID / OPTION_ID 前缀：组合框（combobox）与列表（listbox）的关联，
 *   供 aria-controls / aria-activedescendant 指向，键盘上下键的移动要能被读屏播报。
 */
const LISTBOX_ID = 'command-palette-listbox';
const OPTION_ID_PREFIX = 'command-palette-option-';
/** 仅读屏可见（视觉上不占版面） */
const SR_ONLY_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  borderWidth: 0,
};

type EntityKind = 'action' | 'task' | 'execution' | 'executor' | 'application';

/** 分组渲染顺序：操作 → 任务 → 执行记录 → 执行器 → 应用 */
const GROUP_ORDER: EntityKind[] = ['action', 'task', 'execution', 'executor', 'application'];

/** 分组图标（标题文案走 i18n 键，渲染处用 t() 求值） */
const GROUP_ICON: Record<EntityKind, ReactNode> = {
  action: <PlusOutlined />,
  task: <ThunderboltOutlined />,
  execution: <HistoryOutlined />,
  executor: <ClusterOutlined />,
  application: <AppstoreOutlined />,
};

const GROUP_TITLE_KEY: Record<EntityKind, string> = {
  action: 'palette.group.action',
  task: 'palette.group.task',
  execution: 'palette.group.execution',
  executor: 'palette.group.executor',
  application: 'palette.group.application',
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

const TASK_ACTION_ICON: Record<TaskActionKind, ReactNode> = {
  trigger: <ThunderboltOutlined />,
  pause: <PauseCircleOutlined />,
  resume: <PlayCircleOutlined />,
};

const TASK_ACTION_LABEL_KEY: Record<TaskActionKind, string> = {
  trigger: 'palette.action.trigger',
  pause: 'palette.action.pause',
  resume: 'palette.action.resume',
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

const getStaticActions = (t: TFunction): StaticAction[] => [
  {
    key: 'action-new-task',
    id: 'new-task',
    title: t('palette.action.createTask'),
    description: t('palette.action.createTaskDesc'),
    to: '/tasks/new',
    icon: <PlusOutlined />,
  },
  {
    key: 'action-new-application',
    id: 'new-application',
    title: t('palette.action.createApp'),
    description: t('palette.action.createAppDesc'),
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
  const { t } = useTranslation();
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
  /** UI-12：打开前的焦点宿主——关闭后要把焦点还回去，键盘用户不会「掉到 body」 */
  const restoreFocusRef = useRef<HTMLElement | null>(null);

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

  // UI-12：焦点进入/归还。打开时记下焦点宿主（body 视为无宿主，不做无效归还），
  // 关闭时归还——Esc、选中跳转、⌘K 再按三条关闭路径共用这一处。
  useEffect(() => {
    if (open) {
      const active = document.activeElement as HTMLElement | null;
      restoreFocusRef.current = active && active !== document.body ? active : null;
      return;
    }
    const el = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (el && el !== document.body && document.contains(el) && typeof el.focus === 'function') {
      el.focus();
    }
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
    () => getStaticActions(t).filter((a) => !a.adminOnly || isAdmin),
    [isAdmin, t],
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
      const label = t(TASK_ACTION_LABEL_KEY[kind]);
      try {
        if (kind === 'trigger') {
          await tasksApi.trigger(item.id);
          message.success(t('palette.triggered', { name: item.title }));
        } else if (kind === 'pause') {
          await tasksApi.pause(item.id);
          message.success(t('palette.paused'));
        } else {
          await tasksApi.resume(item.id);
          message.success(t('palette.resumed'));
        }
        nav(`/tasks/${item.id}`);
        onOpenChange(false);
      } catch (err: unknown) {
        message.error(getErrMsg(err, t('palette.actionFail', { action: label })));
      } finally {
        setActingKey(null);
      }
    },
    [actingKey, nav, onOpenChange, t],
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
    const metaTitle = t(GROUP_TITLE_KEY[section.kind]);
    const metaIcon = GROUP_ICON[section.kind];
    // 操作分组：静态动作始终可见（角色过滤后非空即渲染）
    if (section.kind === 'action') {
      if (!section.statics?.length) return null;
      return (
        <div key={section.kind} style={{ marginBottom: 4 }}>
          <Text type="secondary" style={{ fontSize: 12, paddingLeft: 4 }}>
            {metaIcon} {metaTitle}
          </Text>
          <div role="group" aria-label={t('palette.aria.quickAction')}>
            {section.statics.map((action, idx) => {
              const flatIdx = section.offset + idx;
              const active = flatIdx === activeIndex;
              return (
                <div
                  key={action.key}
                  role="option"
                  id={`${OPTION_ID_PREFIX}${flatIdx}`}
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
          {metaIcon} {metaTitle}
        </Text>
        {res.status === 'loading' && (
          <Text type="secondary" style={{ display: 'block', padding: '4px 8px', fontSize: 12 }}>
            {t('palette.searching')}
          </Text>
        )}
        {res.status === 'error' && (
          <Text type="warning" style={{ display: 'block', padding: '4px 8px', fontSize: 12 }}>
            {t('palette.loadFailed', { group: metaTitle })}
          </Text>
        )}
        {res.status === 'ok' && section.items.length > 0 && (
          <div role="group" aria-label={t('palette.aria.searchResults', { group: metaTitle })}>
            {section.items.map((item, idx) => {
              const flatIdx = section.offset + idx;
              const active = flatIdx === activeIndex;
              return (
                <div
                  key={item.key}
                  role="option"
                  id={`${OPTION_ID_PREFIX}${flatIdx}`}
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
                    {metaIcon}
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
                      aria-label={t('palette.aria.inlineActions', { name: item.title })}
                      onClick={(e) => e.stopPropagation()}
                      style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }}
                    >
                      {item.actions.map((ak) => {
                        const amLabel = t(TASK_ACTION_LABEL_KEY[ak]);
                        const amIcon = TASK_ACTION_ICON[ak];
                        return (
                          <button
                            key={ak}
                            type="button"
                            aria-label={t('palette.aria.taskAction', {
                              action: amLabel,
                              name: item.title,
                            })}
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
                            {amIcon}
                            {amLabel}
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
      // UI-12：补可访问名——antd 已渲染 role="dialog" + aria-modal="true"，
      // 但本弹层为 closable=false 且无 title，dialog 长期无名；sr-only 标题
      // 只供读屏消费（antd 会据此设置 aria-labelledby），不占视觉版面。
      title={<span id="command-palette-title" style={SR_ONLY_STYLE}>{t('palette.dialogTitle')}</span>}
      // 打开动画结束后再补一次聚焦（与上面 setTimeout 兜底互为冗余，两条路径幂等）
      afterOpenChange={(visible) => {
        if (visible) inputRef.current?.focus();
      }}
      footer={null}
      width={560}
      destroyOnHidden
      closable={false}
      style={{ top: 88 }}
      styles={{
        header: { padding: 0, marginBottom: 0, background: 'transparent', borderBottom: 'none' },
        body: { paddingTop: 12 },
      }}
    >
      <Input
        ref={inputRef}
        size="large"
        variant="borderless"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onKeyDown={onInputKeyDown}
        placeholder={t('palette.placeholder')}
        prefix={<SearchOutlined style={{ color: token.colorTextTertiary }} />}
        allowClear
        // UI-12：组合框语义——读屏据此播报「可编辑组合框」，并把候选列表与
        // 当前高亮项（aria-activedescendant）关联起来，↑↓ 移动可被感知。
        aria-label={t('palette.aria.search')}
        role="combobox"
        aria-expanded={flatItems.length > 0}
        aria-controls={LISTBOX_ID}
        aria-autocomplete="list"
        aria-activedescendant={
          flatItems.length > 0 ? `${OPTION_ID_PREFIX}${activeIndex}` : undefined
        }
      />
      <div
        ref={listRef}
        id={LISTBOX_ID}
        role="listbox"
        aria-label={t('palette.aria.results')}
        style={{ maxHeight: 380, overflowY: 'auto' }}
      >
        {sections.map(renderSection)}
        {showGlobalEmpty && (
          <Text type="secondary" style={{ display: 'block', textAlign: 'center', padding: '16px 0', fontSize: 13 }}>
            {t('palette.noResults')}
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
        <Text type="secondary" style={{ fontSize: 12 }}>{t('palette.hint.navigate')}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>{t('palette.hint.enter')}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>{t('palette.hint.esc')}</Text>
        <Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>
          {t('palette.hint.inlineActions')}
        </Text>
      </div>
    </Modal>
  );
}
