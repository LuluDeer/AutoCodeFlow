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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { Input, Modal, Typography, theme } from 'antd';
import type { InputRef } from 'antd';
import {
  AppstoreOutlined,
  ClusterOutlined,
  HistoryOutlined,
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

type EntityKind = 'task' | 'execution' | 'executor' | 'application';

/** 分组渲染顺序：任务 → 执行记录 → 执行器 → 应用 */
const GROUP_ORDER: EntityKind[] = ['task', 'execution', 'executor', 'application'];

const GROUP_META: Record<EntityKind, { title: string; icon: ReactNode }> = {
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
}

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
  const [keyword, setKeyword] = useState('');
  const debouncedKeyword = useDebounce(keyword, DEBOUNCE_MS);
  const [results, setResults] = useState<SearchResults>(IDLE_RESULTS);
  const [activeIndex, setActiveIndex] = useState(0);
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

  // 客户端包含匹配（小写化）已返回页数据，每组截断前 5 条，并计算扁平索引偏移
  const sections = useMemo<Section[]>(() => {
    const contains = (s?: string | null) => !!s && s.toLowerCase().includes(kwLower);
    const byKind: Record<EntityKind, PaletteItem[]> = {
      task: results.task.items
        .filter((t) => contains(t.name) || contains(t.description))
        .slice(0, MAX_PER_GROUP)
        .map((t) => ({
          key: `task-${t.id}`,
          id: t.id,
          title: t.name,
          description: [t.status, t.triggerType].filter(Boolean).join(' · '),
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
      const section: Section = { kind, items: byKind[kind], offset };
      offset += byKind[kind].length;
      return section;
    });
  }, [results, kwLower]);

  const flatItems = useMemo(
    () => sections.flatMap((s) => s.items.map((item) => ({ kind: s.kind, item }))),
    [sections],
  );

  const go = useCallback(
    (kind: EntityKind, item: PaletteItem) => {
      if (kind === 'task') nav(`/tasks/${item.id}`);
      else if (kind === 'executor') nav(`/executors/${item.id}`);
      else if (kind === 'application') nav(`/applications/${item.id}`);
      else nav(`/tasks/${item.taskId}/executions/${item.id}`);
      onOpenChange(false);
    },
    [nav, onOpenChange],
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
      if (entry) go(entry.kind, entry.item);
    } else if (e.key === 'Escape') {
      // 显式关闭（与 Modal keyboard 行为幂等，保证任意 antd 版本下 Esc 均生效）
      onOpenChange(false);
    }
  };

  const renderSection = (section: Section) => {
    const res = results[section.kind];
    const meta = GROUP_META[section.kind];
    // 空闲未搜索、或搜索完成但该组无匹配 → 整组隐藏（配合全局空态）
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
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const hasError = GROUP_ORDER.some((kind) => results[kind].status === 'error');
  const allSettled = GROUP_ORDER.every((kind) => results[kind].status === 'ok');
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
        placeholder="搜索任务、执行记录、执行器、应用…"
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
      </div>
    </Modal>
  );
}
