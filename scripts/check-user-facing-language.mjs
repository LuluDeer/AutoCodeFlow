#!/usr/bin/env node
/**
 * LANG-ZH-01：**面向用户文字必须中文**守卫（棘轮门）。
 *
 * ## 为什么需要这道守卫
 *
 * 产品要求（用户明确指令）：「平台、api 所有面全部中文化，因为面向用户的。
 * 执行器侧也按需跟进或者双语展示」。而实测本仓现状是**英文占绝大多数**：
 *   · openapi.json 的 schemas 字段 description：795 条里 **685 条纯英文**；
 *   · admin-api 的 `throw new *Exception(<英文>)`：**338 处**；
 *   · 执行器侧（node/python）面向用户的消息亦以英文为主。
 *
 * 这类缺口**没有度量就无法推进**（不知道在哪、不知道有没有倒退），而且它们
 * 全都"不报错、不影响构建"——只影响用户读到什么。故与
 * `check-openapi-response-schema.mjs`（响应 schema 覆盖率棘轮）、
 * `check-failure-reasons.mjs`（枚举漂移）同思路：把"合规"变成可度量、
 * **只减不增**的棘轮。
 *
 * ## 为什么是棘轮而不是"立刻全绿"
 *
 * 1222 条 description + 338 处异常消息是跨多轮的工程。若本守卫一上来就要求
 * 零英文，它会在中文化进行中途**持续红**，从而失去信号（红灯疲劳）——
 * 那正是本仓 `openapi-empty-schema-whitelist.json` 存在的原因（PK-15 先例：
 * 允许一份**显式登记**的欠账清单，改一处就少一处）。
 *
 * 故口径与 PK-15 完全一致：
 *   ① 未被基线登记的英文 → **红**（新增欠账必须显式登记，杜绝静默新增）；
 *   ② 基线里已登记的**已消失**（有人中文化了）→ **提示上探基线**（棘轮收紧）；
 *   ③ 基线登记项**数量不得增长**（防"登记代替修复"）。
 *
 * ## 判据（三面）
 *
 *   A. `openapi.json` schemas 字段 description + paths summary/description
 *      —— 这是**面向用户的 API 文档面**（文档站与前端类型注释都消费它）。
 *   B. `apps/admin-api/src/**` 的 `throw new *Exception(<字面量>)`
 *      —— 这是**直接返回给用户/前端展示**的错误文案。
 *   C. 执行器侧（node/python）面向用户的错误/提示消息。
 *
 * ## 什么**不算**违规（刻意的豁免面，避免把守卫做成噪音）
 *
 *   · 代码注释、JSDoc、`logger.*` 内部日志（开发者面，非用户面）；
 *   · 纯技术标识：HTTP 头名、env 变量名、MIME、文件扩展名、协议 token；
 *   · **品牌/专有名词**：AutoCodeFlow、Slack、Webhook、Python、Node 等
 *     （翻译它们反而错——`Python` 不应译作「蟒蛇」）；
 *   · 测试文件（断言可保留英文，但它们会因实现中文化而红，属**必须同步**
 *     的连带修改，由中文化批次一并处理，不在本守卫判据内）。
 *
 * ## 用法
 *   node scripts/check-user-facing-language.mjs              # 守卫
 *   node scripts/check-user-facing-language.mjs --report     # 打印全部命中
 *   node scripts/check-user-facing-language.mjs --update     # 重写基线（棘轮上探）
 *   node scripts/check-user-facing-language.mjs --selftest   # 验证判据本身
 *
 * 纯静态读取已提交产物 + 源码正则，无需 npm ci / PG / Redis，秒级。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SPEC = 'apps/admin-api/openapi.json';
const BASELINE = 'scripts/user-facing-language-baseline.json';

/** 含 CJK 统一表意文字即视为「已中文化」。 */
export const CJK_RE = /[\u4e00-\u9fff]/;

/**
 * **豁免词表**：品牌名 / 专有名词 / 技术标识。
 *
 * 判据是「该字符串**去掉豁免词后是否还有实质英文正文**」——这样
 * `"Python"`、`"Slack"`、`"AutoCodeFlow"` 不违规，而
 * `"Python runtime is not available"` 违规（去掉 Python 后仍有正文）。
 *
 * 刻意**不**把 `webhook`/`api` 之外的通用技术词放进豁免表：它们出现在
 * 用户文案里通常应当中文化（如 "Download timed out" → 「下载超时」）。
 */
export const EXEMPT_TOKENS = [
  // 品牌 / 产品名
  'AutoCodeFlow', 'AutoFlow', 'Feishu', 'Lark', 'Slack', 'DingTalk', 'WeCom',
  'Telegram', 'GitHub', 'GitLab', 'Gitee', 'Docker', 'Kubernetes', 'Redis',
  'Postgres', 'PostgreSQL', 'MySQL', 'MinIO', 'S3', 'Qwen', 'OpenAI', 'Claude',
  'Playwright', 'Chromium', 'Electron', 'Vite', 'NestJS', 'TypeORM', 'BullMQ',
  'Prometheus', 'Grafana', 'Alertmanager', 'OIDC', 'SAML', 'JWT', 'TOTP', 'LDAP',
  // 语言 / 运行时（专有名词，不译）
  'Python', 'Node', 'Node.js', 'Shell', 'Bash', 'PowerShell', 'JavaScript',
  'TypeScript', 'Java', 'Go', 'Rust', 'Ruby', 'PHP', 'Deno', 'Bun', 'uv', 'pip',
  'npm', 'pnpm', 'yarn', 'git', 'curl', 'wget', 'zip', 'tar', 'gzip',
  // 协议 / 格式 / 头 / 通用技术缩写
  'HTTP', 'HTTPS', 'JSON', 'YAML', 'XML', 'CSV', 'SSE', 'WebSocket', 'CORS',
  'URL', 'URI', 'UUID', 'SHA', 'MD5', 'HMAC', 'AES', 'TLS', 'SSL', 'IP', 'DNS',
  'API', 'SDK', 'CLI', 'MCP', 'UI', 'UX', 'ID', 'OK', 'CPU', 'RAM', 'GPU',
  // ⚠️ 这里**刻意不放 `Webhook`**（虽然它是常见技术词）：它是**可译的普通名词**
  //    （中文文案里一贯写作「Webhook」或「回调」，视上下文），不是品牌名。
  //
  //    把它放进豁免表会造成一个**实测踩到的判据空洞**：
  //    `"Alertmanager v2 webhook body"` 去掉 `Alertmanager`（品牌）与 `Webhook`
  //    （被豁免）之后只剩 `v2` + `body` → 有效词仅 `body` 一个**全小写**词 →
  //    按「单个全小写词视为标识符」的规则判**合规**。于是这条纯英文描述在中文
  //    文档面上长期存在而门禁全绿。
  //
  //    本文件头注早已写明「刻意**不**把 `webhook`/`api` 之外的通用技术词放进豁免表」，
  //    但表里确实列了 `Webhook`——**注释与实现自相矛盾**，且实现那侧是错的。
  //    现按注释的意图移除，让判据与声明的纪律一致。
  //
  //    头名类（`ETag`/`Bearer`/`Content-Type`…）保留豁免：它们**必须**逐字照抄，
  //    译了客户端就不认。
  'Cookies', 'Cookie', 'ETag', 'Referer', 'Bearer', 'Basic',
  'Content-Type', 'Authorization', 'Accept', 'Origin', 'Host', 'User-Agent',
  // 环境变量名（AUTOFLOW_* / EXECUTOR_* 等）与技术标识
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
  'PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'USERPROFILE',
  'NODE_ENV', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONIOENCODING', 'PYTHONUTF8',
];

/** 去掉 URL、路径、env 名、代码标识后剩余的"英文正文"。 */
export function residualEnglish(text) {
  if (typeof text !== 'string') return '';
  let s = text;
  // URL / 路径 / 文件名 / 主机:端口
  s = s.replace(/https?:\/\/\S+/g, ' ');
  s = s.replace(/[\w.-]+\.(ts|js|json|py|md|sh|yml|yaml|log|gz|zip|txt|html|css)\b/g, ' ');
  s = s.replace(/\b[\w.-]+\/[\w./-]*/g, ' ');
  // env 变量名（全大写+下划线，≥2 段）
  s = s.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, ' ');
  // 豁免词
  for (const t of EXEMPT_TOKENS) {
    s = s.replace(new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ');
  }
  // camelCase / PascalCase / snake_case 标识符（代码标识，非用户正文）
  s = s.replace(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g, ' ');
  s = s.replace(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g, ' ');
  s = s.replace(/\b\w+_\w+\b/g, ' ');
  return s.trim();
}

/**
 * 是否含**实质英文正文**。
 *
 * 判据刻意区分「散文」与「代码标识符」——这是本守卫最容易做错的一处：
 *   · 散文：**≥2 个残留词**（`Executor not found`、`Download timed out`），
 *     或**单个首字母大写的词**（`Unauthorized`、`Forbidden`）——都判违规；
 *   · 标识符：**单个全小写的词**（`unparseable`、`timeout`、`unknown`）判**合规**。
 *
 * 为什么必须放过「单个全小写词」：`zip-guard.util.ts` 的 `ZipGuardError` 首参是
 * **机器枚举** `ZipGuardViolation`（`unparseable` / `too_many_entries` …），
 * 代码以 `err.violation === "unparseable"` 比较、并把它插值进 400 响应体。
 * 首版把这类值全判成欠账（实测 27 条），于是基线里永久躺着永远不会被"修"的
 * 项——棘轮因此永远收不紧号，属"守卫自己制造假红"。翻译它们则**会破坏语义**。
 */
export function hasSubstantiveEnglish(text) {
  const r = residualEnglish(text);
  if (!r) return false;
  const words = r.match(/[A-Za-z]{2,}/g) ?? [];
  if (words.length >= 2) return true;
  // 单残留词：仅当首字母大写（散文形态，如 Unauthorized）才判违规；
  // 全小写单词视为代码标识/枚举值。
  return words.length === 1 && /^[A-Z]/.test(words[0]);
}

/** 该字符串是否属于"面向用户"（含中文即已合规，返回 false）。 */
export function isNonChineseUserText(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (CJK_RE.test(text)) return false;
  return hasSubstantiveEnglish(text);
}

// ── 采集面 A：openapi.json ────────────────────────────────────────────────
export function collectOpenApi(spec) {
  const out = [];
  const schemas = spec.components?.schemas ?? {};
  for (const [name, s] of Object.entries(schemas)) {
    for (const [prop, v] of Object.entries(s?.properties ?? {})) {
      if (isNonChineseUserText(v?.description)) {
        out.push({ kind: 'schema', key: `${name}.${prop}`, text: v.description });
      }
    }
  }
  for (const [p, ops] of Object.entries(spec.paths ?? {})) {
    for (const [m, op] of Object.entries(ops)) {
      for (const field of ['summary', 'description']) {
        if (isNonChineseUserText(op?.[field])) {
          out.push({ kind: 'path', key: `${m.toUpperCase()} ${p}.${field}`, text: op[field] });
        }
      }
    }
    // ⚠️ 以下三类**曾经是判据的盲区**（实测漏掉过一条真实英文，见下），
    //    它们同样是公开文档面上「面向用户的文字」，必须一并扫：
    //      · operation 的 parameters[].description
    //      · operation 的 requestBody.description
    //      · operation 的 responses.*.description
    //
    //    漏掉的实例：`POST /alerts/webhook` 的
    //    `@ApiBody({ description: "Alertmanager v2 webhook body" })`——一条**纯英文**
    //    描述在中文文档面上挂了很久而门禁全绿，因为顶层只扫了 summary/description。
    //    这正是"判据面不完整 ⇒ 门禁假绿"的形态，故补齐。
    for (const [m, op] of Object.entries(ops)) {
      const where = `${m.toUpperCase()} ${p}`;
      for (const param of op?.parameters ?? []) {
        if (isNonChineseUserText(param?.description)) {
          out.push({
            kind: 'param',
            key: `${where}.parameters[${param?.name ?? '?'}].description`,
            text: param.description,
          });
        }
      }
      const rb = op?.requestBody;
      if (isNonChineseUserText(rb?.description)) {
        out.push({
          kind: 'requestBody',
          key: `${where}.requestBody.description`,
          text: rb.description,
        });
      }
      for (const [code, r] of Object.entries(op?.responses ?? {})) {
        if (isNonChineseUserText(r?.description)) {
          out.push({
            kind: 'response',
            key: `${where}.responses.${code}.description`,
            text: r.description,
          });
        }
      }
    }
  }
  return out;
}

// ── 采集面 B：admin-api 异常消息 ──────────────────────────────────────────
/**
 * 只抓 `throw new *Exception(<字符串字面量>` / `throw new Error(<...>)` 的第一个
 * 实参（用户可见文案）。
 *
 * **`Error` 也在判据内**（这一点是 selftest 抓出来的）：首版只匹配
 * `\w*Exception`，于是 `throw new Error(\`Task ${id} not found\`)` 整类被漏掉——
 * 而 task.service 的派发失败消息正是 `Error`，它会落进 `task_executions.
 * errorMessage` **直接显示在管理台的执行详情/失败原因**里。漏掉它就是漏掉
 * 用户最常看到的那一类文案。
 */
export const THROW_RE =
  /throw new \w*(?:Exception|Error)\(\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)")/g;

/**
 * 去掉 `//` 行注释与 `/* … *\/` 块注释（**保留字符串字面量内的内容**）。
 *
 * ⚠️ 为什么必须去注释（实测踩到，且是"守卫自己造假红"）：
 * `collectThrownMessages` 是在**源码文本**上跑 `THROW_RE` 的。而本仓的迁移纪律
 * 要求把「旧实现是什么」写进 JSDoc 以便追溯，于是注释里会出现
 * `` `throw new UnauthorizedException("OIDC identity not linked …")` `` 这种
 * **引用**。不去注释，这些引用就会被当成**真实的英文抛点**判红——修的人只能
 * 二选一：删掉有价值的溯源注释，或往基线里加假欠账（棘轮被污染）。
 *
 * 实现要点（两处都容易写错）：
 *   · 必须**感知字符串**：`"http://x"` 里的 `//` 不是注释开头，
 *     `"a /* b"` 里的 `/*` 也不是。故用一个状态机，而不是正则一把梭。
 *   · 保留换行（把注释内容替换成等量换行/空格）以维持行号，便于报错定位。
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let inS = null; // 当前字符串引号类型
  let inTpl = false; // 是否在模板串里（模板串内 ${} 也按普通文本处理，够用）
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (inS) {
      out += c;
      if (c === '\\') {
        out += c2 ?? '';
        i += 2;
        continue;
      }
      if (c === inS) inS = null;
      i++;
      continue;
    }
    if (inTpl) {
      out += c;
      if (c === '\\') {
        out += c2 ?? '';
        i += 2;
        continue;
      }
      if (c === '`') inTpl = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inS = c;
      out += c;
      i++;
      continue;
    }
    if (c === '`') {
      inTpl = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function collectThrownMessages(src) {
  const out = [];
  // 先剥注释：注释里对旧实现的**引用**不是真实抛点（见 stripComments 的长注释）。
  for (const m of stripComments(src).matchAll(THROW_RE)) {
    const text = m[1] ?? m[2] ?? m[3] ?? '';
    if (isNonChineseUserText(text)) out.push(text);
  }
  return out;
}

/**
 * 递归收集源文件。
 *
 * ⚠️ **必须排除依赖目录**：`apps/executor-python/.venv/Lib/site-packages` 里有
 * 大量第三方库的 `raise` 语句（实测 typing_extensions 85 条、pydantic 43 条…）。
 * 首版没排除它们，于是守卫把**第三方库的英文**算成了本项目的欠账——基线被灌进
 * 上千条噪音，棘轮随之失去意义（永远不可能收紧到 0，且真正的欠账被淹没）。
 * 这是"守卫自己制造假红/假绿"的又一形态：判据面必须**只覆盖本仓源码**。
 */
const SKIP_DIRS = [
  'node_modules',
  'dist',
  'generated',
  '__tests__',
  '.venv',
  'venv',
  'site-packages',
  '__pycache__',
  '.git',
  'coverage',
  'build',
];

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.includes(e.name)) continue;
      walk(p, acc);
    } else if (/\.(ts|py)$/.test(e.name) && !/\.(spec|test|selftest)\./.test(e.name)) {
      acc.push(p);
    }
  }
  return acc;
}

export function collectAdminApi() {
  const out = [];
  const base = path.join(root, 'apps/admin-api/src');
  if (!fs.existsSync(base)) return out;
  for (const f of walk(base)) {
    if (!f.endsWith('.ts')) continue;
    if (f.includes(`${path.sep}dto${path.sep}`)) continue; // DTO 走 openapi 面
    const src = fs.readFileSync(f, 'utf-8');
    for (const text of collectThrownMessages(src)) {
      out.push({ kind: 'throw', key: path.relative(root, f), text });
    }
  }
  return out;
}

// ── 采集面 C：执行器侧（node / python）面向用户的抛出文案 ─────────────────
/**
 * 执行器的 `throw new *Error("...")` / `raise *Error("...")` 消息会经回调
 * `errorMessage` 显示在中台的执行详情/失败原因里——与 admin 的 throw 同属
 * **用户可见文案**，故纳入同一判据面。
 *
 * 刻意**不**采集 `logger.*` / 注释 / docstring：那些是开发者面。执行器侧
 * 另有一批 `code`/`failureReason` 类的**机器标识符**（如 `bad_archive`），
 * 它们不是散文、翻译它们会破坏语义——本判据靠"≥2 个英文词或 ≥1 个 ≥6 字母词"
 * 的实质正文门槛天然放过单词标识符。
 */
const PY_RAISE_RE = /raise\s+\w*(?:Error|Exception)\(\s*(?:f?)(?:`([^`]*)`|'([^']*)'|"([^"]*)")/g;

export function collectExecutors() {
  const out = [];
  const targets = [
    { dir: path.join(root, 'apps/executor-node/src'), ext: '.ts', py: false },
    { dir: path.join(root, 'apps/executor-python'), ext: '.py', py: true },
  ];
  for (const t of targets) {
    if (!fs.existsSync(t.dir)) continue;
    for (const f of walk(t.dir)) {
      if (!f.endsWith(t.ext)) continue;
      // python 的 tests/ 由 walk 的 __tests__ 规则覆盖不到，这里显式排除。
      if (t.py && (f.includes(`${path.sep}tests${path.sep}`) || path.basename(f).startsWith('test_'))) {
        continue;
      }
      const src = fs.readFileSync(f, 'utf-8');
      const texts = t.py
        ? [...src.matchAll(PY_RAISE_RE)].map((m) => m[1] ?? m[2] ?? m[3] ?? '')
        : collectThrownMessages(src);
      for (const text of texts) {
        if (isNonChineseUserText(text)) {
          out.push({ kind: 'executor', key: path.relative(root, f), text });
        }
      }
    }
  }
  return out;
}

// ── 主流程 ───────────────────────────────────────────────────────────────
function loadJson(p) {
  return JSON.parse(fs.readFileSync(path.join(root, p), 'utf-8'));
}

/** 稳定键：kind + 位置 + 文本（文本本身进键，避免同位置换文案被漏检）。 */
function itemKey(it) {
  return `${it.kind}\t${it.key}\t${it.text}`;
}

export function run({ report = false } = {}) {
  const spec = loadJson(SPEC);
  const items = [
    ...collectOpenApi(spec),
    ...collectAdminApi(),
    ...collectExecutors(),
  ];

  if (report) {
    const byKind = items.reduce((a, i) => ((a[i.kind] = (a[i.kind] ?? 0) + 1), a), {});
    console.log(`LANG-ZH-01 报告：面向用户英文文字共 ${items.length} 处`);
    for (const [k, v] of Object.entries(byKind)) console.log(`   ${k}: ${v}`);
    const byFile = items
      .filter((i) => i.kind === 'throw')
      .reduce((a, i) => ((a[i.key] = (a[i.key] ?? 0) + 1), a), {});
    console.log('   英文异常消息最多的文件：');
    for (const [f, c] of Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`     ${String(c).padStart(3)}  ${f}`);
    }
    return 0;
  }

  if (!fs.existsSync(path.join(root, BASELINE))) {
    console.error(`✘ 基线缺失：${BASELINE}（用 --update 生成）`);
    return 1;
  }
  const baseline = loadJson(BASELINE);
  const known = new Set(baseline.known ?? []);
  const current = new Set(items.map(itemKey));

  const added = [...current].filter((k) => !known.has(k));
  const fixed = [...known].filter((k) => !current.has(k));
  const cap = baseline.maxKnown ?? known.size;

  let bad = false;
  if (added.length > 0) {
    bad = true;
    console.error(`✘ 新增 ${added.length} 处**面向用户的英文文字**（未被基线登记）：`);
    for (const k of added.slice(0, 25)) {
      const [, where, text] = k.split('\t');
      console.error(`   · [${where}] ${String(text).slice(0, 90)}`);
    }
    if (added.length > 25) console.error(`   … 其余 ${added.length - 25} 处见 --report`);
    console.error(
      '\n  处置：把面向用户的文案改为中文（**注释/日志/技术标识不在此列**）；' +
        '确属品牌名或专有名词的，加进本脚本的 EXEMPT_TOKENS。',
    );
  }
  if (known.size > cap) {
    bad = true;
    console.error(
      `✘ 基线登记项增长（${known.size} > 上限 ${cap}）——棘轮只许收紧不许放松。`,
    );
  }
  if (fixed.length > 0 && !bad) {
    console.log(
      `✔ 无新增英文；另有 ${fixed.length} 处已中文化（棘轮可上探）——` +
        '跑 --update 收紧基线。',
    );
  }
  if (!bad) {
    console.log(
      `✔ LANG-ZH-01 通过：面向用户英文 ${current.size} 处，全部在基线内（上限 ${cap}）。`,
    );
  }
  return bad ? 1 : 0;
}

/** --update：把当前命中写成新基线（棘轮上探/初始化）。 */
export function update() {
  const spec = loadJson(SPEC);
  const items = [
    ...collectOpenApi(spec),
    ...collectAdminApi(),
    ...collectExecutors(),
  ];
  const keys = [...new Set(items.map(itemKey))].sort();
  const payload = {
    $comment:
      'LANG-ZH-01 面向用户英文文字欠账清单（棘轮）。只许减少，不许新增；' +
      '新增英文会被 check-user-facing-language.mjs 判红。中文化后跑 --update 收紧。',
    maxKnown: keys.length,
    known: keys,
  };
  fs.writeFileSync(
    path.join(root, BASELINE),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf-8',
  );
  console.log(`✔ 基线已写入 ${BASELINE}：${keys.length} 处`);
  return 0;
}

// ── 自检：验证判据本身（防"永真/永假"） ──────────────────────────────────
function selftest() {
  let fail = 0;
  const t = (name, cond) => {
    if (cond) console.log(`  ✔ ${name}`);
    else {
      fail++;
      console.error(`  ✘ ${name}`);
    }
  };
  console.log('LANG-ZH-01 selftest:');

  // ① 必须判为违规（英文用户文案）
  t('纯英文句子 → 违规', isNonChineseUserText('Executor not found') === true);
  t('英文技术说明 → 违规', isNonChineseUserText('Download timed out') === true);
  t('含豁免词但仍有正文 → 违规', isNonChineseUserText('Python runtime is not available') === true);
  t('英文长单词 → 违规', isNonChineseUserText('Unauthorized') === true);

  // ② 必须判为合规（不该误报）
  t('中文 → 合规', isNonChineseUserText('执行器不存在') === false);
  t('中英混排（已中文化）→ 合规', isNonChineseUserText('执行器 Python 运行时不可用') === false);
  t('纯品牌名 → 合规', isNonChineseUserText('AutoCodeFlow') === false);
  t('纯专有名词 → 合规', isNonChineseUserText('Python') === false);
  t('技术标识 → 合规', isNonChineseUserText('GET') === false);
  t('env 名 → 合规', isNonChineseUserText('AUTOFLOW_EXECUTOR_ADDRESS') === false);
  t('空串 → 合规', isNonChineseUserText('') === false);
  t('非字符串 → 合规', isNonChineseUserText(undefined) === false);
  t('主机:端口 → 合规', isNonChineseUserText('10.0.0.9:3002') === false);
  t('文件路径 → 合规', isNonChineseUserText('apps/admin-api/src/main.ts') === false);

  // ③ 采集器行为
  t(
    'collectThrownMessages 抓英文实参',
    collectThrownMessages(`throw new NotFoundException("Executor not found")`).length === 1,
  );
  t(
    'collectThrownMessages 放过中文实参',
    collectThrownMessages(`throw new NotFoundException("执行器不存在")`).length === 0,
  );
  t(
    'collectThrownMessages 抓模板字面量',
    collectThrownMessages('throw new Error(`Task ${id} not found`)').length === 1,
  );

  // 执行器侧采集（面 C）：python `raise` 与 node `throw` 同判据。
  //
  // 断言的是**采集器形态**而非"剩多少条"：中文化完成后存量本来就会归零，
  // 若断言 `length > 0` 就会在达标后把守卫自己打红（"守卫把成功判成失败"）。
  // 故用**合成样本**验证两个采集面都真的在跑，与实际存量解耦。
  t(
    'collectExecutors 覆盖 node 与 python 两个面（形态）',
    (() => {
      const all = collectExecutors();
      return all.every((i) => i.kind === 'executor');
    })(),
  );
  t(
    'collectExecutors 能采到 node 侧英文（合成样本）',
    collectThrownMessages('throw new Error("Download timed out")').length === 1 &&
      isNonChineseUserText('Download timed out') === true,
  );
  t(
    'python raise 英文被采到（形态覆盖）',
    (() => {
      const re = new RegExp(PY_RAISE_RE.source, 'g');
      const m = [...`raise ValueError("disk watermark percent must be in [1, 100]")`.matchAll(re)];
      // 注意 groups 顺序：第 1 组是反引号、第 2 组单引号、第 3 组双引号
      // （groups[0] 是整个匹配），故双引号形态取 groups[3]。
      const captured = m[0]?.[3];
      return m.length === 1 && isNonChineseUserText(captured) === true;
    })(),
  );
  t(
    '机器标识符单词（bad_archive）因实质正文门槛被放过',
    isNonChineseUserText('bad_archive') === false,
  );
  // ⚠️ 回归钉：`Webhook` 曾误列在 EXEMPT_TOKENS 里，与本文件头注声明的纪律
  //（「刻意不把 webhook/api 之外的通用技术词放进豁免表」）自相矛盾，并造成一个
  // 真实空洞——`"Alertmanager v2 webhook body"` 去掉品牌 `Alertmanager` 与被豁免的
  // `Webhook` 后只剩 `v2 body`，有效词仅一个全小写 `body`，遂判**合规**，
  // 于是一条纯英文描述长期挂在中文文档面上而门禁全绿。
  t(
    'Webhook 不是豁免词（去掉品牌后仍应判违规）',
    isNonChineseUserText('Alertmanager v2 webhook body') === true,
  );
  t(
    '含中文的 Webhook 文案合规（中英混排不算欠账）',
    isNonChineseUserText('Alertmanager v2 Webhook 请求体') === false,
  );
  // 反向：真正的品牌名与头名仍须被豁免，否则守卫变成噪音（会把正确写法判红）
  t('品牌名仍豁免（Alertmanager 单独出现不算违规）', isNonChineseUserText('Alertmanager') === false);
  t(
    '头名仍豁免（Content-Type 必须逐字照抄）',
    isNonChineseUserText('Content-Type 请求头') === false,
  );

  // ⚠️ 注释剥离的**双向**判据（缺任一侧都会出事）：
  //   · 正向：注释里的旧实现引用**不得**判红——否则迁移时写溯源注释就会假红，
  //     逼人删注释或往基线塞假欠账；
  //   · 反向：剥离**不得**把真实抛点也一起吃掉——那是把守卫变成永真，比假红更糟。
  t(
    '注释里的 throw 引用不判红（溯源注释可保留）',
    collectThrownMessages(
      '// 旧实现：throw new UnauthorizedException("OIDC identity not linked to any platform account")\n',
    ).length === 0,
  );
  t(
    '块注释里的 throw 引用不判红',
    collectThrownMessages(
      '/**\n * `throw new ForbiddenException("Executor version … is below the required minimum …")`\n */\n',
    ).length === 0,
  );
  t(
    '真实抛点仍被抓（剥离没有变成永真）',
    collectThrownMessages(
      'if (!x) throw new BadRequestException("Executor not found");',
    ).length === 1,
  );
  t(
    '注释与真实抛点并存时只抓后者',
    collectThrownMessages(
      '// throw new Error("Commented out message")\nthrow new Error("Real failure message");',
    ).length === 1,
  );
  t(
    '字符串里的 // 不当作注释（URL 不被截断）',
    collectThrownMessages(
      'throw new Error("Contact https://example.com now");',
    ).length === 1,
  );

  console.log(fail === 0 ? '\n✔ selftest 全通过' : `\n✘ selftest ${fail} 项失败`);
  return fail === 0 ? 0 : 1;
}

// ⚠️ **主模块守卫**：只有被直接执行时才跑 CLI。
//
// 为什么必须加：本文件导出 `collectOpenApi` / `hasSubstantiveEnglish` 等判据，
// 供 selftest 与排障时**单独调用**。首版没有守卫，于是 `import` 本模块会**立刻
// 执行守卫并 process.exit** —— 探针脚本永远只打印一行"✔ 通过"就退出，看不到
// 任何判据内部状态（实测排查 `requestBody` 盲区时被这个坑误导了一轮：
// 探针报"通过"，却无法判断是"判据没扫到"还是"扫到了但没判违规"）。
// 用 `pathToFileURL` 比较而非字符串拼接，避免 Windows 盘符/大小写差异误判。
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  let code = 0;
  if (argv.includes('--selftest')) code = selftest();
  else if (argv.includes('--update')) code = update();
  else code = run({ report: argv.includes('--report') });
  process.exit(code);
}
