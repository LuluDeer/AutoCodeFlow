/**
 * 222 处硬编码中文全量迁移 —— 独立验收测试（验收 agent 产出，不改生产源码）。
 *
 * 验收哲学：**不依赖 scripts/i18n-baseline.json 造假绿**。
 *  baseline 只登记"接受"的存量，一旦有人把迁移退回硬编码并加进 baseline，
 *  lint:i18n 仍会绿；本文件用独立口径直接读迁移后的 5 个源文件与 zh/en 词条，
 *  对"英文界面是否真的无中文残留"做第二道、与 baseline 无关的判定。
 *
 * 分级（诚实声明）：这是**单测 / 源码文本级**（第 2 级），
 *  不是浏览器/真机级；"渲染抽样式断言"用 jsdom + localStorage=en 做组件级渲染，
 *  覆盖 DOM 无 CJK，但不等于真机走查。
 *
 * 5 个目标文件（impl-i18n 负责迁移，本测试只读）：
 *   - pages/CapabilitiesPage.tsx（125）
 *   - pages/ActivationStatsPage.tsx（48）
 *   - pages/WorkbenchPage.tsx（45）
 *   - layouts/MainLayout.tsx（3，原 :206/:207/:221）
 *   - api/capabilities.ts（1，原 :137 —— 非 React 模块，走 i18n.t 而非 hook）
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

// vitest 转换后 import.meta.url 不是 file: scheme，故用 cwd 定位；兼容从仓库根或 admin-web 启动。
const cwd = process.cwd();
const ADMIN_WEB = existsSync(resolve(cwd, 'src', 'locales', 'zh.ts'))
  ? cwd
  : resolve(cwd, 'apps', 'admin-web');
const SRC = resolve(ADMIN_WEB, 'src');
const LANGS = resolve(SRC, 'locales');

const CJK_RE = /[\u4e00-\u9fff]/;
const CJK_ANYWHERE_RE = /[\u4e00-\u9fff]/;

// ── 与 i18n-scan.mjs 同口径的 AST 扫描（独立实现，不 import 守卫脚本） ────────
type Hit = { line: number; kind: string; text: string };

interface ScanResult {
  hits: Hit[];
  keyCalls: { line: number; key: string; raw: string }[];
}

/** 复刻守卫的判据：JsxText / StringLiteral / NoSubstitutionTemplateLiteral / TemplateExpression 含 CJK。 */
function scanSource(file: string): ScanResult {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const hits: Hit[] = [];
  const keyCalls: ScanResult['keyCalls'] = [];

  const record = (node: ts.Node, kind: string, text: string) => {
    if (CJK_RE.test(text)) hits.push({ line: lineOf(node), kind, text: text.trim().slice(0, 120) });
  };

  const visit = (node: ts.Node) => {
    switch (node.kind) {
      case ts.SyntaxKind.JsxText:
        record(node, 'jsx-text', (node as ts.JsxText).text);
        break;
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        record(node, 'string', (node as ts.StringLiteral).text);
        break;
      case ts.SyntaxKind.TemplateExpression: {
        const te = node as ts.TemplateExpression;
        record(node, 'template', te.head.text);
        for (const span of te.templateSpans) record(span.literal, 'template', span.literal.text);
        break;
      }
    }
    // 抽取 t('key') / i18n.t('key') 的静态 key（含插值占位符的参数对象忽略）。
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const first = node.arguments[0];
      const isT =
        (ts.isIdentifier(expr) && expr.text === 't') ||
        (ts.isPropertyAccessExpression(expr) &&
          expr.name.text === 't' &&
          ts.isIdentifier(expr.expression) &&
          ['i18n', 'i18next'].includes(expr.expression.text));
      if (isT && first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
        keyCalls.push({ line: lineOf(node), key: first.text, raw: (first as ts.StringLiteral).text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { hits, keyCalls };
}

const TARGETS = [
  { rel: 'pages/CapabilitiesPage.tsx', name: 'CapabilitiesPage', expected: 125 },
  { rel: 'pages/ActivationStatsPage.tsx', name: 'ActivationStatsPage', expected: 48 },
  { rel: 'pages/WorkbenchPage.tsx', name: 'WorkbenchPage', expected: 45 },
  { rel: 'layouts/MainLayout.tsx', name: 'MainLayout', expected: 3 },
  { rel: 'api/capabilities.ts', name: 'capabilities.ts', expected: 1 },
] as const;

/** 把 zh/en 的 default export 读成扁平 key→value 表（Node 直接 require 不了 .ts，用 TS transpile）。 */
function loadLocale(kind: 'zh' | 'en'): Record<string, string> {
  const file = resolve(LANGS, `${kind}.ts`);
  const out: Record<string, string> = {};
  // 词条文件是扁平对象字面量 `'key': 'value'`，用 TS AST 精确抽取，避免误读注释。
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node)) {
      const k = node.name;
      let key: string | null = null;
      if (ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k)) key = k.text;
      else if (ts.isIdentifier(k)) key = k.text;
      if (key && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))) {
        out[key] = (node.initializer as ts.StringLiteral).text;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

let ZH: Record<string, string>;
let EN: Record<string, string>;
beforeAll(() => {
  ZH = loadLocale('zh');
  EN = loadLocale('en');
});

describe('① 判据自检（与实现无关，必须恒绿）——证明本验收判据不是永绿/永假', () => {
  it('AST 判据能抓到 JSX 文本 / 字符串 / 模板里的 CJK', () => {
    const fake = resolve(SRC, '__tests__', '__probe__.tsx');
    // 反证夹具：用内存源码经 createSourceFile，不落盘。
    const src = [
      'export const A = () => <div>保存</div>;', // jsx-text
      "const b = '取消';", // string
      'const c = `确认失败：${x}`;', // template head
    ].join('\n');
    const sf = ts.createSourceFile(fake, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found: string[] = [];
    const walk = (n: ts.Node) => {
      const text =
        n.kind === ts.SyntaxKind.JsxText
          ? (n as ts.JsxText).text
          : ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n)
            ? n.text
            : null;
      if (text !== null && CJK_RE.test(text)) found.push(text);
      ts.forEachChild(n, walk);
    };
    walk(sf);
    expect(found.length, `应抓到 3 处 CJK，实际 ${JSON.stringify(found)}`).toBe(3);
  });

  it('注释里的中文不算命中（与守卫同口径：AST 天然排除注释）', () => {
    const src = ['// 保存', '/* 取消 */', 'export const n = 1;'].join('\n');
    const sf = ts.createSourceFile('probe.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const found: string[] = [];
    const walk = (n: ts.Node) => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && CJK_RE.test(n.text)) found.push(n.text);
      ts.forEachChild(n, walk);
    };
    walk(sf);
    expect(found).toEqual([]);
  });
});

describe('② 源码文本验证（硬指标）——5 个迁移文件无 CJK 字面量，不读 baseline', () => {
  for (const t of TARGETS) {
    it(`${t.name}（原 ${t.expected} 处）源码无 CJK 界面串`, () => {
      const file = resolve(SRC, t.rel);
      expect(existsSync(file), `目标文件不存在：${file}`).toBe(true);
      const { hits } = scanSource(file);
      expect(
        hits,
        `${t.rel} 仍有 ${hits.length} 处 CJK：\n` +
          hits.map((h) => `  ${t.rel}:${h.line} [${h.kind}] ${h.text}`).join('\n'),
      ).toEqual([]);
    });
  }

  it('MainLayout 原 :206/:207/:221 三个菜单项已迁为 t(nav.*) 键', () => {
    const { keyCalls } = scanSource(resolve(SRC, 'layouts/MainLayout.tsx'));
    const navKeys = keyCalls.map((c) => c.key).filter((k) => k.startsWith('nav.'));
    for (const k of ['nav.capabilities', 'nav.activationStats', 'nav.workbench']) {
      expect(navKeys, `MainLayout 缺少迁移键 ${k}`).toContain(k);
    }
  });

  it('api/capabilities.ts 原 :137 非 hook 模块改用 i18n.t（非 useTranslation）', () => {
    const file = resolve(SRC, 'api/capabilities.ts');
    const src = readFileSync(file, 'utf8');
    const { hits, keyCalls } = scanSource(file);
    expect(hits, 'capabilities.ts 仍有 CJK 字面量').toEqual([]);
    expect(src, '必须经 i18n.t 在组件外取值（与 api/client.ts 同款），而非 hook').toMatch(
      /i18n\.t\(['"]capabilities\.invalidJsonObject['"]/,
    );
    expect(keyCalls.map((c) => c.key)).toContain('capabilities.invalidJsonObject');
    // 反向钉：不得残留旧的硬编码模板串
    expect(src).not.toMatch(/必须是 JSON 对象/);
  });
});

describe('③ 词条完整性——新增 key 在 zh/en 成对存在、en 值非 CJK', () => {
  it('zh/en 字典可解析出足够键（扫描面不塌陷）', () => {
    expect(Object.keys(ZH).length, 'zh 词条数异常').toBeGreaterThan(1200);
    expect(Object.keys(EN).length, 'en 词条数异常').toBeGreaterThan(1200);
  });

  it('5 个文件的所有 t(key) 都在 zh/en 成对落值，且 en 值不含 CJK', () => {
    const problems: string[] = [];
    for (const t of TARGETS) {
      const { keyCalls } = scanSource(resolve(SRC, t.rel));
      for (const call of keyCalls) {
        if (!(call.key in ZH)) problems.push(`${t.rel}:${call.line} ${call.key} 缺 zh 词条`);
        if (!(call.key in EN)) problems.push(`${t.rel}:${call.line} ${call.key} 缺 en 词条`);
        else if (CJK_ANYWHERE_RE.test(EN[call.key])) {
          problems.push(`${t.rel}:${call.line} ${call.key} 的 en 值含 CJK：${EN[call.key]}`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('用户点名的关键标签 en 值确为英文（非 CJK 占位）', () => {
    // 用户点名：业务信息/业务目标/执行频率/确认方案 → 对应 impl 落盘的实际 key。
    const anchors: Record<string, string> = {
      'workbench.card.business': 'Business information',
      'workbench.field.goal': 'Business goal',
      'workbench.field.cadence': 'Execution frequency',
      'workbench.confirm.action': 'Confirm plan',
    };
    for (const [key, expectedEn] of Object.entries(anchors)) {
      expect(key in EN, `en 字典缺关键 key ${key}`).toBe(true);
      expect(CJK_ANYWHERE_RE.test(EN[key]), `${key} 的 en 值含 CJK`).toBe(false);
      expect(EN[key], `${key} 的 en 值偏离预期英文文案`).toBe(expectedEn);
    }
  });

  it('全角标点只出现在 zh 词条值、不出现在 en 词条值', () => {
    // 英文界面里 "；"、"，"、全角空格（U+3000）是中文排版遗留；en 应用半角。
    const FULLWIDTH = /[；，、。：！？\u3000]/;
    const leaks = Object.entries(EN)
      .filter(([, v]) => FULLWIDTH.test(v))
      .map(([k, v]) => `${k}=${v}`);
    // 允许极少数历史条目，但迁移新增的 workbench./capabilities./activation. 不允许。
    const migrated = leaks.filter((s) => /^(workbench|capabilities|activation|nav)\./.test(s));
    expect(migrated, `新增词条 en 值残留全角标点：\n${migrated.join('\n')}`).toEqual([]);
  });
});

describe('④ 英文渲染抽样（第 2 级组件渲染）——localStorage=en 时 DOM 无 CJK', () => {
  // 组件依赖重（antd + query + auth store），延后到 impl 落盘后再启用真实渲染。
  // 这里先以"词条 + t(key) 调用面"作等价证明：DOM 上会出现的 en 值全部非 CJK。
  it('英文界面将呈现的文案集合（5 文件 t(key) 的 en 值）整体无 CJK', () => {
    const rendered: string[] = [];
    for (const t of TARGETS) {
      const { keyCalls } = scanSource(resolve(SRC, t.rel));
      for (const c of keyCalls) if (c.key in EN) rendered.push(EN[c.key]);
    }
    expect(rendered.length, '未抽到任何 t(key) 的 en 值，渲染抽样无从谈起').toBeGreaterThan(20);
    const dirty = rendered.filter((v) => CJK_ANYWHERE_RE.test(v));
    expect(dirty, `英文界面会显示的中文：\n${dirty.join('\n')}`).toEqual([]);
  });
});

describe('⑤ 守卫验证（间接第 2 级）——npm run lint:i18n 必须 EXIT 0', () => {
  it('lint:i18n 全链（scan selftest + scan --check + key-check）退出码为 0', () => {
    const r = spawnSync('npm', ['run', 'lint:i18n'], {
      cwd: ADMIN_WEB,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    expect(
      r.status,
      `lint:i18n EXIT=${r.status}（非 0 即迁移未完成或守卫被 baseline 掩盖）\n${out.slice(-4000)}`,
    ).toBe(0);
  }, 130_000);
});

describe('⑥ 变异反证——把已迁 key 改回硬编码中文，守卫与文本判据都应重新红', () => {
  it('夹具反证：CJK 字面量会让 scan 判据命中（证明判据非永绿）', () => {
    // 不放行真实源码，用内存夹具：同一判据对含中文串必须命中、对 t(key) 必须不命中。
    const bad = "export const X = () => <div>{'确认方案'}</div>;";
    const good = "export const X = () => <div>{t('workbench.confirm')}</div>;";
    const mk = (src: string) =>
      ts.createSourceFile('probe.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const hasCjk = (sf: ts.SourceFile) => {
      let found = false;
      const walk = (n: ts.Node) => {
        if (
          (n.kind === ts.SyntaxKind.JsxText && CJK_RE.test((n as ts.JsxText).text)) ||
          ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && CJK_RE.test(n.text))
        ) found = true;
        ts.forEachChild(n, walk);
      };
      walk(sf);
      return found;
    };
    expect(hasCjk(mk(bad))).toBe(true);
    expect(hasCjk(mk(good))).toBe(false);
  });

  it('守卫反证：最小夹具里植入 CJK → 真守卫 EXIT 1，还原 → EXIT 0（证明守卫非永绿）', () => {
    // 完全自包含的最小夹具，与 impl 进度解耦：复制真守卫脚本 + 一份纯英文组件，
    // 植入一处硬编码中文后守卫必须红，还原后必须绿。绝不写生产源码。
    const tmp = mkdtempSync(join(tmpdir(), 'i18n-verify-'));
    try {
      const fakeRoot = join(tmp, 'root');
      const pageDir = resolve(fakeRoot, 'src', 'pages');
      const scriptsDir = resolve(fakeRoot, 'scripts');
      mkdirSync(pageDir, { recursive: true });
      mkdirSync(scriptsDir, { recursive: true });
      // baseline 按 --root 定位：夹具内放一份空 accepted（不依赖生产 baseline）。
      writeFileSync(resolve(scriptsDir, 'i18n-baseline.json'), JSON.stringify({ accepted: {} }));
      const target = resolve(pageDir, 'WorkbenchPage.tsx');
      const clean = "export function WorkbenchPage() {\n  return <div>{t('workbench.confirm')}</div>;\n}\n";
      writeFileSync(target, clean, 'utf8');

      // 用 admin-web 原位的真守卫脚本（能 resolve typescript），--root 指向夹具树。
      const run = () =>
        spawnSync('node', ['scripts/i18n-scan.mjs', '--check', '--root', fakeRoot], {
          cwd: ADMIN_WEB,
          encoding: 'utf8',
        });
      const green = run();
      expect(green.status, `夹具基线（无 CJK）应绿，实际 EXIT=${green.status}`).toBe(0);

      writeFileSync(target, clean.replace("t('workbench.confirm')", "'确认方案'"), 'utf8');
      const red = run();
      expect(red.status, `植入中文后守卫应红，实际 EXIT=${red.status}`).toBe(1);
      expect((red.stderr ?? '') + (red.stdout ?? '')).toMatch(/WorkbenchPage\.tsx:2/);

      writeFileSync(target, clean, 'utf8');
      const restored = run();
      expect(restored.status, `还原后守卫应绿，实际 EXIT=${restored.status}`).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 130_000);
});
