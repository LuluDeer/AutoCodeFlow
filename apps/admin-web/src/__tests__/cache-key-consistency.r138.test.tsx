/**
 * R138-A1（数据层审计 · 轴 1）：缓存键的两条**结构性**钉子。
 *
 * ① 失效键必须有真实消费者。
 *    React Query 的失效是纯字符串前缀匹配：`invalidateQueries({ queryKey:
 *    ['auth-profile'] })` 在没有任何查询用这个 key 时**不报错、不重取、不打
 *    日志**——完全静默。本仓库真的踩到了（src/pages/settings/SecuritySettings
 *    的 TOTP 开关，见 totp-state-sync.r138.test.tsx），而当时全量 225 个测试
 *    文件全绿。这条扫描把整类缺陷变成红灯：页面里每个**字面量**失效键的根
 *    必须能在某处找到真正的消费者（`queryKey: ['root'…]` 的查询，或
 *    `queryKey: queryKeys.<ns>` 工厂——后者的根由工厂常量决定）。
 *
 *    局限（如实标注）：只覆盖**字面量**根，不覆盖 queryKeys 工厂的深层子键，
 *    也不覆盖"失效了但漏了详情/统计"这种覆盖面缺口（那由
 *    queries-invalidate.test.tsx 按面逐条钉住）。
 *
 * ② 分页/筛选参数必须进 key。
 *    没进 key 的话切页/换筛选会读到别人的缓存条目（且不会有任何报错）。
 *    这里对每个参数逐个断言"改它就换键"，并钉住 `undefined` 与 `''` 的游标
 *    三态不可互相命中（'undefined' 键值 vs 空串）。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { queryKeys } from '../api/queries';

/**
 * 定位 `src/`。
 *
 * 不能用 `import.meta.url`：本仓库的 vitest 环境（jsdom + v5）下它不是
 * `file:` scheme，`fileURLToPath` 直接抛 "The URL must be of scheme file"。
 * 改为从 cwd 向上找含 package.json 的 admin-web 目录（兼容"在 apps/admin-web
 * 里跑"与"在仓库根跑"两种姿势）。
 */
function findSrcRoot(): string {
  const direct = join(process.cwd(), 'src');
  if (existsSync(join(direct, 'api', 'queries.ts'))) return direct;
  const nested = join(process.cwd(), 'apps', 'admin-web', 'src');
  if (existsSync(join(nested, 'api', 'queries.ts'))) return nested;
  // 最后兜底：从本文件真实位置往上找（path.resolve 不做 URL 解析）
  let dir = dirname(resolve(process.cwd()));
  for (let i = 0; i < 5; i += 1) {
    const candidate = join(dir, 'src');
    if (existsSync(join(candidate, 'api', 'queries.ts'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`找不到 admin-web 的 src 目录（cwd=${process.cwd()}）`);
}

const SRC_ROOT = findSrcRoot();

/** 会"消费"缓存键的调用——除此之外的 queryKey 出现都算读方（useQuery 等）。 */
const WRITE_FN = /(invalidateQueries|cancelQueries|refetchQueries|removeQueries|setQueryData|getQueryData|getQueryState|ensureQueryData|prefetchQuery|fetchQuery)\s*\(\s*\{?\s*$/;

/** queryKeys 工厂命名空间 → 缓存键根字符串。 */
const FACTORY_ROOTS: Record<string, string> = {
  metrics: 'metrics',
  tasks: 'tasks',
  executions: 'executions',
  executors: 'executors',
  scheduler: 'scheduler',
  taskTemplates: 'task-templates',
  projects: 'projects',
};

/** queryKey: ['root' …] | queryKey: ["root" …] | queryKey: queryKeys.<ns> */
const KEY_RE = /queryKey:\s*(?:\[\s*'([^']+)'|\[\s*"([^"]+)"|queryKeys\.(\w+))/g;

/**
 * 剥掉注释再扫描。
 *
 * 必须剥：源文件里的**文档注释**会大段引用真实的调用文本（本仓库的注释文化
 * 就是贴代码片段）。不剥的话，注释里那句 `queryKey: ['auth-profile']` 会被
 * 当成"消费者"，正好把这个键的孤立性掩盖掉——扫描器会被注释骗过（已实测）。
 * 行注释只剥 `//` 前面不是 `:` 的（保住 `https://` / `http://` 这类字符串）。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(p);
  }
  return out;
}

interface ScanResult {
  /** 失效/取消方用到的键根 → 出处文件 */
  writeRoots: Map<string, string>;
  /** 真正被查询消费的键根 */
  consumerRoots: Set<string>;
  /** 扫描到的 queryKey 出现次数（防扫描器自己坏掉后"永远绿"） */
  keyOccurrences: number;
}

function scan(): ScanResult {
  const writeRoots = new Map<string, string>();
  const consumerRoots = new Set<string>();
  let keyOccurrences = 0;

  for (const file of walk(SRC_ROOT)) {
    const text = stripComments(readFileSync(file, 'utf8'));
    const rel = file.slice(SRC_ROOT.length + 1).replace(/\\/g, '/');
    KEY_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = KEY_RE.exec(text)) !== null) {
      keyOccurrences += 1;
      const literalRoot = m[1] ?? m[2];
      const factoryRoot = m[3] ? FACTORY_ROOTS[m[3]] : undefined;
      const root = literalRoot ?? factoryRoot;
      if (!root) continue; // 未知工厂命名空间：另由类型检查兜住
      const isWrite = WRITE_FN.test(text.slice(Math.max(0, m.index - 120), m.index));
      if (!isWrite) consumerRoots.add(root);
      else if (!writeRoots.has(root)) writeRoots.set(root, rel);
    }
  }
  return { writeRoots, consumerRoots, keyOccurrences };
}

describe('R138-A1 ① 每个失效键都必须有真实消费者（否则是静默空操作）', () => {
  const { writeRoots, consumerRoots, keyOccurrences } = scan();

  it('扫描器自身是活的（找到足够多的 queryKey 出现，不是空跑通过）', () => {
    expect(keyOccurrences).toBeGreaterThan(50);
    expect(writeRoots.size).toBeGreaterThan(5);
    expect(consumerRoots.size).toBeGreaterThan(5);
  });

  it('字面量失效键的根 ⊆ 真实查询键的根', () => {
    const orphans = [...writeRoots.entries()].filter(([root]) => !consumerRoots.has(root));
    // 断言消息直接给出"哪个文件失效了一个没人读的键"，便于定位
    expect(
      orphans.map(([root, file]) => `${file} → 失效键根 '${root}' 没有任何消费者`),
    ).toEqual([]);
  });
});

describe('R138-A1 ② 分页/筛选参数必须进缓存键', () => {
  const ser = (k: readonly unknown[]) => JSON.stringify(k);

  it('tasks.list：page/pageSize/q/name/status/triggerType/lastStatus/cursor 逐一换键', () => {
    const base = { page: 1, pageSize: 20 };
    const baseKey = ser(queryKeys.tasks.list(base));
    // 同参数 → 同键（否则同一次渲染会反复打后端）
    expect(ser(queryKeys.tasks.list({ page: 1, pageSize: 20 }))).toBe(baseKey);

    const variants: Record<string, unknown>[] = [
      { page: 2 },
      { pageSize: 50 },
      { q: '备份' },
      { name: 'backup' },
      { status: 'paused' },
      { triggerType: 'cron' },
      { lastStatus: 'failed' },
      { cursor: '' }, // keyset 起点
      { cursor: 'abc' }, // keyset 中途页
    ];
    for (const v of variants) {
      const key = ser(queryKeys.tasks.list({ ...base, ...v } as never));
      expect(key, `参数 ${JSON.stringify(v)} 没有进缓存键`).not.toBe(baseKey);
    }
    // undefined（OFFSET 路径）与 ''（keyset 起点）不可互相命中
    expect(ser(queryKeys.tasks.list({ ...base, cursor: undefined }))).not.toBe(
      ser(queryKeys.tasks.list({ ...base, cursor: '' })),
    );
  });

  it('executions.list：status/taskName/executorAddress/startTime/endTime/cursor 逐一换键', () => {
    const base = { page: 1, pageSize: 20 };
    const baseKey = ser(queryKeys.executions.list(base));
    const variants: Record<string, unknown>[] = [
      { page: 3 },
      { pageSize: 100 },
      { status: 'failed' },
      { taskName: 'nightly' },
      { executorAddress: '10.0.0.1:9000' },
      { startTime: '2026-09-01T00:00:00Z' },
      { endTime: '2026-09-02T00:00:00Z' },
      { cursor: '' },
      { cursor: 'cur-1' },
    ];
    for (const v of variants) {
      const key = ser(queryKeys.executions.list({ ...base, ...v } as never));
      expect(key, `参数 ${JSON.stringify(v)} 没有进缓存键`).not.toBe(baseKey);
    }
  });

  it('详情/维度键都带实体 id 与分页参数（跨实体不串味）', () => {
    expect(ser(queryKeys.tasks.detail('a'))).not.toBe(ser(queryKeys.tasks.detail('b')));
    expect(ser(queryKeys.tasks.stats('a'))).not.toBe(ser(queryKeys.tasks.stats('b')));
    expect(ser(queryKeys.executions.detail('t1', 'e1'))).not.toBe(
      ser(queryKeys.executions.detail('t1', 'e2')),
    );
    expect(
      ser(queryKeys.executions.byTask('t1', { page: 1, pageSize: 20 })),
    ).not.toBe(ser(queryKeys.executions.byTask('t1', { page: 2, pageSize: 20 })));
    expect(
      ser(queryKeys.executions.byExecutor('x1', { page: 1, pageSize: 20 })),
    ).not.toBe(ser(queryKeys.executions.byExecutor('x2', { page: 1, pageSize: 20 })));
    expect(ser(queryKeys.executors.detail('a'))).not.toBe(ser(queryKeys.executors.detail('b')));
  });

  it('钉子：DAG 全量表键挂在 tasks/list 前缀下（写操作失效可级联到它）', () => {
    expect(queryKeys.tasks.allForDag.slice(0, 2)).toEqual(['tasks', 'list']);
    expect(queryKeys.tasks.all.slice(0, 1)).toEqual(['tasks']);
  });
});
