/**
 * 审计列表**标签映射**守卫（R3）：`ACTION_LABEL_KEYS` 必须覆盖后端可能写入的
 * 全部 audit action。
 *
 * ## 为什么需要（本题的由来）
 *
 * i18n 孤儿棘轮（`i18n-orphans.test.ts`）扫出两条"字典里有、源码里没有"的词条：
 * `audit.action.task_webhook_enable` / `audit.action.task_webhook_rotate`。追下去
 * 发现不是死词条，而是**映射表漏登记**：后端 `task-webhook.service.ts:198/206`
 * 确实写入这两个 action，字典两侧也早有词条，唯独 `pages/audit/index.tsx` 的
 * `ACTION_LABEL_KEYS` 只有 `task.webhook_disable`。于是审计列表里"启用/轮换
 * webhook"两行渲染的是原始代码 `task.webhook_enable`——既有中文标签、也点不进
 * 本地化，属于"能查到但读不懂"的可见缺陷。
 *
 * 只修两行没有意义：**下一次后端加 action，同样会静默漏**。所以判据是
 * "映射表 ⊇ 后端动作全集"，把这类漏登记从"靠人眼发现"变成"测试红"。
 *
 * ## 事实源与它的局限（**必读**）
 *
 * 优先用**后端源码**（唯一能证明"后端真的会写"的来源），抽取三条规则：
 *
 *   ① `action: "<a.b>"` —— `audit.log({ action, … })` 的直接写法；
 *   ② 任何**函数名含 audit** 的调用，其字符串字面量实参（`auditHighRisk("a.b", …)`、
 *      `writeTransitionAudit("deployment.reject", …)` 都落在这一条）；
 *   ③ 形参名为 `action`、类型是**字符串字面量联合**的声明（`action: "deployment.approve"
 *      | "deployment.reject" | …`）——把联合成员也当作"可能写入"。
 *
 * 再用 `docs/atlas/01-apps/admin-api/modules/audit.md` 的「谁在写审计」表**交叉验证**：
 * 那张表由 `scripts/check-audit-actions-doc.mjs` 从后端源码生成、CI 守卫其与代码一致，
 * 脚本自述"表格是事实源"。两者不一致时本测试只 **warn**（文档漂移归那个脚本管），
 * 但覆盖判据取**并集**——宁可多要求一条映射，也不要漏。
 *
 * **已知局限（必须写在这里，避免下一个人误以为这是完备判据）**：
 *   · 后端若把 action 拼成变量/模板（`action: \`task.${verb}\``）或经纯 `string` 形参
 *     透传，静态扫不到——本轮就有一个真实例子：`issueSecret(id, user, ip, "task.webhook_enable")`
 *     的函数名不含 audit、形参是 `action: string`，①②③ 全抓不到，是靠**字典反推**补上的。
 *   · 因此额外保留**退化判据**：字典里 `audit.action.*` 的键（去掉工具栏按钮那 4 条）
 *     必须全部被映射覆盖。字典是"有人认真写过文案"的集合，能兜住源码扫不到的动作；
 *     但它也会**多**（历史动作、UI 文案共用前缀），所以反向差异只 warn。
 *   · 文档表允许保留历史动作（该脚本明确"反向不校验"），故文档有、代码没有的 action
 *     不判红，只在映射里出现时给 warn。
 *
 * ## 断言方向
 *
 *   · **红**：后端 ∪ 文档已知的 action 未出现在映射里（且不在 `KNOWN_UNLABELED`）；
 *   · **红**：字典 `audit.action.*`（排除 UI 标签）未被映射覆盖；
 *   · **红**：映射指向的词条在 zh/en 任一缺失（渲染出来就是裸 key）；
 *   · **红**：`KNOWN_UNLABELED` 已过期（动作已被映射 / 字典已有词条）——逼着回收豁免；
 *   · **warn**：映射里有、后端/文档都没有（疑似历史动作，允许保留）；
 *   · **warn**：文档与后端源码不一致（漂移归 `check-audit-actions-doc.mjs`，此处只提示）。
 *
 * ## `KNOWN_UNLABELED`：为什么不直接判红
 *
 * 设计初衷：后端会写、但字典暂无词条的动作，既不造词条（文案是产品决策），也不把测试
 * 留红——豁免表 = 显式记账，每条写清"为什么还没标签"，且**豁免过期即红**（词条一补齐，
 * 第 6 条断言立刻要求删豁免 + 补映射），不会悄悄放过。
 *
 * **当前为空**：2026-11-03 产品拍板补齐 `deployment.cancel` / `executor.delete` /
 * `executor.install_cmd_viewed` 三条词条，映射同步补上，豁免清零。机制保留给下一次。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import zh from '../locales/zh';
import en from '../locales/en';

const REPO_ROOT = resolve(__dirname, '../../../..');
const PAGE_PATH = resolve(__dirname, '../pages/audit/index.tsx');
const DOC_PATH = resolve(REPO_ROOT, 'docs/atlas/01-apps/admin-api/modules/audit.md');
const API_SRC = resolve(REPO_ROOT, 'apps/admin-api/src');

/** action 代码形态：`<域>.<动作>`，域小写、动作允许 camelCase（`task.killExecution`）。 */
const ACTION_CODE_RE = /^[a-z][a-z0-9_]*\.[A-Za-z0-9_.]+$/;

/**
 * `audit.action.*` 前缀下**不是动作码**的 4 条：审计页工具栏按钮文案
 * （`index.tsx:535/673/674/676/752` 的 查看/搜索/重置/导出 CSV）。
 * 从字典反推动作集时必须排除，否则会要求给按钮造 action 映射。
 */
const UI_LABEL_KEYS = new Set([
  'audit.action.view',
  'audit.action.search',
  'audit.action.reset',
  'audit.action.export',
]);

/**
 * 后端会写、但**字典没有词条**的动作（不造词条，只记账；详见文件头）。
 *
 * **当前为空**（2026-11-03 三条词条补齐后清零）。机制保留：将来再遇到"后端已写、
 * 文案未定"的动作，登记在这里而不是把判据改宽；词条一旦补上，第 6 条断言会红，
 * 要求删掉豁免并补映射。
 */
const KNOWN_UNLABELED: ReadonlyMap<string, string> = new Map();

// ── 采集：页面映射 ──────────────────────────────────────────────────────

/**
 * 从页面源码里抠出 `ACTION_LABEL_KEYS` 的对象字面量。
 *
 * 不把它 `export` 出来：`pages/**` 是 React 组件文件，多一个非组件导出会触发
 * `react-refresh/only-export-components` 的告警，且会让"映射表"变成对外 API。
 * AST 取字面量既零侵入，又能保证读到的是**真实运行的那份**（不是测试里另抄一份）。
 */
export function extractLabelMap(source: string): Map<string, string> {
  const sf = ts.createSourceFile('audit-index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let obj: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ACTION_LABEL_KEYS' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      obj = node.initializer;
    }
    node.forEachChild(visit);
  };
  visit(sf);
  if (!obj) throw new Error('audit/index.tsx 里找不到 ACTION_LABEL_KEYS 对象字面量（被重命名/拆分了？）');
  const map = new Map<string, string>();
  for (const prop of (obj as ts.ObjectLiteralExpression).properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isStringLiteral(prop.name) || !ts.isStringLiteral(prop.initializer)) {
      throw new Error(`ACTION_LABEL_KEYS 里有非字面量条目，静态判据无法覆盖：${prop.getText()}`);
    }
    map.set(prop.name.text, prop.initializer.text);
  }
  return map;
}

// ── 采集：后端源码里的 action ──────────────────────────────────────────

export interface ActionSite {
  file: string;
  line: number;
  how: string;
}

/** 纯函数版本（反证用例喂假源码，不依赖真实仓库）。 */
export function scanBackendSources(inputs: { file: string; source: string }[]): Map<string, ActionSite> {
  const found = new Map<string, ActionSite>();
  const add = (value: string, file: string, line: number, how: string): void => {
    if (ACTION_CODE_RE.test(value) && !found.has(value)) found.set(value, { file, line, how });
  };

  for (const { file, source } of inputs) {
    // 快筛：不含 audit 字样的文件不可能写审计（548 → ~100 个，秒级）
    if (!/audit/i.test(source)) continue;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const lineOf = (node: ts.Node): number =>
      sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

    const visit = (node: ts.Node): void => {
      // ① 直接写法：action: "a.b"
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === 'action' &&
        ts.isStringLiteral(node.initializer)
      ) {
        add(node.initializer.text, file, lineOf(node), 'action:');
      }
      // ② 审计透传调用：函数名含 audit（auditHighRisk / writeTransitionAudit …）
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sf);
        if (/audit/i.test(callee)) {
          for (const arg of node.arguments) {
            if (ts.isStringLiteral(arg)) add(arg.text, file, lineOf(arg), `call:${callee}`);
          }
        }
      }
      // ③ 形参联合类型：action: "a.b" | "c.d"
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === 'action' && node.type) {
        if (ts.isUnionTypeNode(node.type)) {
          for (const t of node.type.types) {
            if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) {
              add(t.literal.text, file, lineOf(node), 'param-union');
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(sf);
  }
  return found;
}

/** 读真实后端源码树；目录不存在（admin-web 单包检出）时返回 skipped。 */
export function readBackendSources(): { inputs: { file: string; source: string }[]; skipped: boolean } {
  if (!existsSync(API_SRC)) return { inputs: [], skipped: true };
  const inputs: { file: string; source: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry !== 'node_modules') walk(p);
      } else if (/\.ts$/.test(entry) && !/\.spec\.ts$/.test(entry)) {
        inputs.push({ file: p.slice(REPO_ROOT.length + 1).replace(/\\/g, '/'), source: readFileSync(p, 'utf-8') });
      }
    }
  };
  walk(API_SRC);
  return { inputs, skipped: false };
}

// ── 采集：文档表（交叉验证）────────────────────────────────────────────

export function docActions(markdown: string): Set<string> {
  const section = markdown.split('## 谁在写审计')[1]?.split(/\n## /)[0] ?? '';
  const actions = new Set<string>();
  for (const line of section.split('\n')) {
    const row = /^\|\s*`([^`]+)`\s*\|(.*)\|\s*$/.exec(line);
    if (!row) continue;
    for (const m of row[2].matchAll(/`([^`]+)`/g)) actions.add(m[1]);
  }
  return actions;
}

// ── 判据（纯函数，便于反证）────────────────────────────────────────────

export function missingCoverage(
  expected: Iterable<string>,
  mapped: Iterable<string>,
  allowlisted: Iterable<string> = [],
): string[] {
  const mappedSet = new Set(mapped);
  const allow = new Set(allowlisted);
  return [...new Set(expected)].filter((a) => !mappedSet.has(a) && !allow.has(a)).sort();
}

export function danglingLabelKeys(
  map: Map<string, string>,
  dicts: Record<string, unknown>[],
): string[] {
  const out: string[] = [];
  for (const [action, key] of [...map.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const missingIn = dicts.map((d, i) => (key in d ? null : i)).filter((i): i is number => i !== null);
    if (missingIn.length > 0) out.push(`${action} → ${key}（缺于${missingIn.map((i) => (i === 0 ? 'zh' : 'en')).join('/')}）`);
  }
  return out;
}

/** 统一差异文案：计数 + 前 N 条（与 i18n 两个守卫同款，便于对齐阅读）。 */
export function reportDiff(label: string, entries: readonly string[], maxShown = 20): string {
  if (entries.length === 0) return `${label}：共 0 条`;
  const head = entries.slice(0, maxShown).join(', ');
  const rest = entries.length > maxShown ? `（另有 ${entries.length - maxShown} 条未列出）` : '';
  return `${label}：共 ${entries.length} 条（列前 ${Math.min(entries.length, maxShown)} 条）：${head}${rest}`;
}

// ── 真实仓库采集（模块求值期一次）──────────────────────────────────────

const labelMap = extractLabelMap(readFileSync(PAGE_PATH, 'utf-8'));
const backend = readBackendSources();
const backendActions = scanBackendSources(backend.inputs);
const doc = existsSync(DOC_PATH) ? docActions(readFileSync(DOC_PATH, 'utf-8')) : new Set<string>();
const zhRec = zh as unknown as Record<string, unknown>;
const enRec = en as unknown as Record<string, unknown>;

/**
 * 字典里的动作词条**键名**（排除工具栏按钮那 4 条）。
 * 注意：词条键名是 `audit.action.<域>_<动作>`（点换下划线，如
 * `audit.action.task_webhook_enable`），而 action 代码是 `task.webhook_enable`
 * ——两者不是同一形态，所以"字典覆盖"这条判据比的是 **label key 集合**
 * （`dictLabelKeys ⊆ 映射值集合`），不能拿词条名去和 action 代码求差。
 */
const dictLabelKeys = new Set(
  Object.keys(zhRec).filter((k) => k.startsWith('audit.action.') && !UI_LABEL_KEYS.has(k)),
);

const mappedActions = new Set(labelMap.keys());
const mappedLabelKeys = new Set(labelMap.values());
/** 覆盖判据的 action 全集：后端源码（含透传/联合类型）+ 文档表交叉验证。 */
const expectedActions = new Set<string>([...backendActions.keys(), ...doc]);

// ── 用例 ────────────────────────────────────────────────────────────────

describe('审计动作标签映射：覆盖后端可能写入的全部 action', () => {
  it('扫描面非空（反永真：后端树/文档/映射任一读空都不该判绿）', () => {
    if (backend.skipped) {
      // 单包检出（没有 apps/admin-api）时退化为"文档 + 字典"，不静默判绿：
      // 打印明确告警，后续三条断言仍按退化口径执行。
      console.warn('[audit-action-labels] ⚠ 未找到 apps/admin-api，退化：后端源码未参与判据');
    } else {
      expect(backend.inputs.length).toBeGreaterThan(300);
      expect(backendActions.size).toBeGreaterThan(60);
    }
    expect(doc.size).toBeGreaterThan(60);
    expect(labelMap.size).toBeGreaterThan(60);
    console.log(
      `[audit-action-labels] 后端源码 ${backendActions.size} 个 action（扫 ${backend.inputs.length} 个文件）｜文档 ${doc.size}｜映射 ${labelMap.size}｜字典动作词条 ${dictLabelKeys.size}｜无词条豁免 ${KNOWN_UNLABELED.size}`,
    );
  });

  it('后端/文档已知的每个 action 都有本地化标签（缺一个就红）', () => {
    const missing = missingCoverage(expectedActions, mappedActions, KNOWN_UNLABELED.keys());
    expect(reportDiff('未映射的 action（会渲染原始代码）', missing)).toBe(
      '未映射的 action（会渲染原始代码）：共 0 条',
    );
  });

  it('字典里的动作词条全部被映射（源码扫不到时的兜底判据）', () => {
    // 反向兜底：像 `task.webhook_enable` 这种"后端经纯 string 形参透传、静态扫不到"
    // 的动作，只能靠字典里"已经有人写好文案"这件事反推。缺一条就红。
    const unmapped = [...dictLabelKeys].filter((key) => !mappedLabelKeys.has(key)).sort();
    expect(reportDiff('字典有词条但映射未引用', unmapped)).toBe('字典有词条但映射未引用：共 0 条');
  });

  it('映射指向的词条在 zh 与 en 都存在（否则界面渲染裸 key）', () => {
    expect(reportDiff('词条缺失的映射', danglingLabelKeys(labelMap, [zhRec, enRec]))).toBe(
      '词条缺失的映射：共 0 条',
    );
  });

  it('映射值形状统一：都是 audit.action.*，且无重复指向', () => {
    const shape = [...labelMap.entries()]
      .filter(([, key]) => !key.startsWith('audit.action.'))
      .map(([action, key]) => `${action} → ${key}`);
    expect(reportDiff('非 audit.action.* 的映射值', shape)).toBe('非 audit.action.* 的映射值：共 0 条');

    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const [action, key] of labelMap) {
      const prev = seen.get(key);
      if (prev) dup.push(`${key}（${prev} / ${action}）`);
      else seen.set(key, action);
    }
    expect(reportDiff('多个 action 指向同一词条', dup)).toBe('多个 action 指向同一词条：共 0 条');
  });

  it('KNOWN_UNLABELED 卫生：仍未被映射，且字典确实没有词条（过期即红）', () => {
    // 词条命名约定：action 代码里的点换成下划线（`task.webhook_enable` →
    // `audit.action.task_webhook_enable`，全仓 84 条词条皆此约定）。
    const stale = [...KNOWN_UNLABELED.keys()].filter(
      (action) => mappedActions.has(action) || `audit.action.${action.replace(/\./g, '_')}` in zhRec,
    );
    expect(reportDiff('已过期的无标签豁免（词条/映射已补齐，请删豁免）', stale)).toBe(
      '已过期的无标签豁免（词条/映射已补齐，请删豁免）：共 0 条',
    );
  });

  it('（warn）映射里有、后端/文档都没有的 action —— 疑似历史动作，允许保留', () => {
    // 例外：词条在字典里 ⇒ 这条映射是"有文案背书"的（后端可能经静态扫不到的路径
    // 写入，如 `issueSecret(…, "task.webhook_enable")`），不算历史动作。
    const historical = [...mappedActions]
      .filter((a) => !expectedActions.has(a) && !dictLabelKeys.has(labelMap.get(a) as string))
      .sort();
    // 不判红：历史动作/手工补录的映射不该阻塞。打印出来供审计。
    if (historical.length > 0) {
      console.warn(`[audit-action-labels] ⚠ 映射中的非当前动作：${historical.join(', ')}`);
    }
    expect(Array.isArray(historical)).toBe(true);
  });

  it('（warn）文档表与后端源码的差异 —— 漂移归 check-audit-actions-doc.mjs', () => {
    if (!backend.skipped) {
      const codeNotDoc = [...backendActions.keys()].filter((a) => !doc.has(a)).sort();
      const docNotCode = [...doc].filter((a) => !backendActions.has(a)).sort();
      if (codeNotDoc.length || docNotCode.length) {
        console.warn(
          `[audit-action-labels] ⚠ 后端源码与 audit.md 不一致：代码有文档无 [${codeNotDoc.join(', ')}]；文档有代码无 [${docNotCode.join(', ')}]`,
        );
      }
    }
    expect(true).toBe(true);
  });
});

describe('守卫自身有牙（反证：不改真实仓库也能证明判据会红）', () => {
  it('映射提取只认 ACTION_LABEL_KEYS，形状不对会明确报错', () => {
    const sample = `
      const OTHER = { 'x.y': 'audit.action.x' };
      const ACTION_LABEL_KEYS: Record<string, string> = {
        'task.create': 'audit.action.task_create',
        'task.delete': 'audit.action.task_delete',
      };`;
    expect([...extractLabelMap(sample).keys()]).toEqual(['task.create', 'task.delete']);
    expect(() =>
      extractLabelMap(`const ACTION_LABEL_KEYS = { ['x.y']: 'audit.action.x' };`),
    ).toThrow(/静态判据无法覆盖/);
  });

  it('缺映射 ⇒ missingCoverage 报出来（红路径）：人为塞一个假 action', () => {
    const mapped = new Map([['task.create', 'audit.action.task_create']]);
    const expected = ['task.create', 'task.webhook_enable'];
    expect(missingCoverage(expected, mapped.keys())).toEqual(['task.webhook_enable']);
    // 进豁免后放行；豁免一旦过期（已被映射）由"KNOWN_UNLABELED 卫生"那条抓
    expect(missingCoverage(expected, mapped.keys(), ['task.webhook_enable'])).toEqual([]);
  });

  it('多缺几条时文案带计数与截断（失败信息可定位）', () => {
    const expected = Array.from({ length: 25 }, (_, i) => `domain.a${i}`);
    const text = reportDiff('未映射', missingCoverage(expected, []));
    expect(text).toContain('共 25 条');
    expect(text).toContain('另有 5 条未列出');
  });

  it('映射指向不存在的词条 ⇒ danglingLabelKeys 报出（红路径）', () => {
    const map = new Map([['task.create', 'audit.action.task_create'], ['task.delete', 'audit.action.nope']]);
    const zhFake = { 'audit.action.task_create': '创建' };
    const enFake = { 'audit.action.task_create': 'Create' };
    expect(danglingLabelKeys(map, [zhFake, enFake])).toEqual([
      'task.delete → audit.action.nope（缺于zh/en）',
    ]);
  });

  it('后端扫描三条规则都能抓到（含 audit 透传与形参联合类型）', () => {
    const sample = `
      function writeTransitionAudit(action: "deployment.approve" | "deployment.reject", d: unknown) {}
      writeTransitionAudit("deployment.rollback", {});
      await this.auditHighRisk("executor.delete", executor);
      await this.audit.log({ action: "task.create", resource: "task" });`;
    const found = scanBackendSources([{ file: 'fake.service.ts', source: sample }]);
    expect([...found.keys()].sort()).toEqual([
      'deployment.approve',
      'deployment.reject',
      'deployment.rollback',
      'executor.delete',
      'task.create',
    ]);
  });

  it('后端扫描不吃非 action 形态的字面量（URL/相对路径/大写域）', () => {
    const sample = `
      this.audit.log({ action: "task.create" });
      this.auditHighRisk("../relative/path");
      this.auditHighRisk("http://x.y/z");
      this.auditHighRisk("Task.Upper");`;
    expect([...scanBackendSources([{ file: 'fake.ts', source: sample }]).keys()]).toEqual(['task.create']);
  });

  it('文档表解析：按行取反引号、忽略表头（防"把域列当成 action"）', () => {
    const md = ['## 谁在写审计', '| 域 | action |', '|---|---|', '| `task` | `task.create` · `task.delete` |', '', '## 其他'].join('\n');
    expect([...docActions(md)].sort()).toEqual(['task.create', 'task.delete']);
  });
});
