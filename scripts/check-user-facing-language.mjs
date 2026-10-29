#!/usr/bin/env node
/**
 * LANG-ZH-01：**面向用户文字**语言守卫（棘轮门）
 *
 * ## 为什么需要这道守卫
 *
 * 产品要求（用户明确指令）：「平台、api 所有面全部中文化，因为面向用户的。
 * 执行器侧也按需跟进或者双语展示」。首版守卫（本文件 2026-10-15）把"合规"
 * 定义成「文本里出现任一 CJK 字符」，于是把当时实测的 2795 处英文收敛到 0，
 * 基线一路收紧到空。
 *
 * ## 第 4 轮审计（docs/archive/audits/2026-10-29-round4/test-guard-quality.md §2.9）
 * ## 实证的三个洞 —— 本文件因此改判据、扩面
 *
 *   1. **「含一个汉字即合规」⇒ 半英半中永久免检**。这条判据**结构上无法区分**
 *      「中英混排的用户文案」与「带技术标识的中文文案」，所以它不给任何信号。
 *      实测 `apps/admin-api/src` 里「含 CJK 且残留 ≥2 个英文词」的串 23 处。
 *      ⇒ 判据从「有没有汉字」升级为「**CJK 之外是否还有残留英文散文**」：
 *        判据二 `residualEnglish()`（见下）；无 CJK 的串仍走判据一
 *        `hasSubstantiveEnglish()`（原逻辑，一字未改）。
 *   2. **`apps/admin-web/**` 完全不在扫描面**（全文件 grep `admin-web` 无命中）。
 *      产品面向用户的主界面是 React，`t()` 未覆盖的硬编码文案无人守。
 *      ⇒ 新增采集面 D：JSX 文本节点（跳过代码样例）+ 用户可见属性 +
 *        `message.*` / `notification.*` / `Modal.confirm` 文案。
 *        **刻意排除 `src/locales/**`**：那是 i18n 资源，`en.ts` 本来就该是英文，
 *        而 `zh.ts` 里的 Token/Cron/Agent 是刻意的技术名词（扫它只会灌噪音）。
 *   3. **Python 的 `detail=` 不在面内**：`HTTPException(status_code=400, detail='…')`
 *      才是真正回给用户的 HTTP 文案（审计点名 `routers/logs.py:32,37,40`、
 *      `config.py:126,133`）。首版只认 `raise *Error(`。⇒ 采集面 C 加 `detail=`。
 *
 * 另外补一个审计没提但**更关键**的面：LANG-ERR-01 之后 admin-api 的用户文案
 * 已经不写在 `throw` 实参里，而是 `throw new AppError(CODE)` + 码表
 * `catalog/*.ts` 的 `zh` 字段（`en` 字段是刻意的英文，不扫）。只扫 `throw`
 * 等于扫一个**已经搬家的空房子**。⇒ 新增采集面 B2：码表 `zh` 文案。
 *
 * ## 判据（精确口径）
 *
 *   判据一（无 CJK）：`hasSubstantiveEnglish(text)` —— 去掉 URL/路径/env/
 *     豁免词/代码标识后仍 ≥2 个英文词，或 1 个首字母大写的词 ⇒ 违规。
 *   判据二（有 CJK）：`residualEnglish(text)` 非空 ⇒ 违规。规则：
 *     ① 先做**结构性掩码**（URL、路径/文件名、email、`X-Header-Name`、`{placeholder}`、
 *        `{{x}}`、`${expr}`、`[A-Za-z0-9._/ :\-]` 这种字符类、`key=value`
 *        （`status=end`、`force=true`）、点号标识符（`params.dir`）、
 *        连字符小写复合词（`front-matter`、`zip-bomb`）、shell flag、ENV 名、
 *        camelCase/PascalCase/snake_case、豁免词表）；
 *     ② 再按 CJK 切段（汉字是断点），每段取 ≥4 字母的英文词；
 *     ③ 段内全是**小写**词 ⇒ 视为技术名词组/枚举值列表/标识符，放过
 *        （`config reload`、`video | screenshot | other`、`params`）；
 *     ④ 段内出现**英文虚词**（`not/please/use/instead/to/of/…`）⇒ 违规
 *        （`… use GIT_ASKPASS / a credential helper instead`）；
 *     ⑤ 段内出现**首字母大写的非缩写词** ⇒ 违规（`Failed to 保存`、`Unauthorized`）。
 *        全大写词（`HEAD`/`YAML`/`API`）是缩写/常量，放过。
 *
 * 这套判据刻意偏保守：**宁可漏掉一个技术名词，也不要把「Webhook 鉴权失败」
 * 这种正确的中文文案判红**——守卫制造假红会驱使人去改**对的**东西（审计 §2.9
 * 已经点出这条风险）。
 *
 * ## 棘轮（只许变好，且**不许赖账**）
 *
 *   ① 未被基线登记的新增命中 ⇒ **红**（新增欠账必须显式登记）；
 *   ② 基线里登记过、但现在**已经不命中**（有人中文化了）⇒ **红**，要求跑
 *      `--update` 收紧基线。这是第 4 轮审计 §3.1「基线只增不减是反模式」的
 *      落地点：修好了却把旧条目留在基线里，等于用登记代替修复，棘轮永远收不紧；
 *   ③ 基线登记项数量不得增长（`known.length > maxKnown` ⇒ 红）。
 *
 * ## 采集面
 *
 *   A. `openapi.json`：components.schemas 字段 description、paths 的
 *      summary/description/parameters[].description/requestBody.description/
 *      responses.*.description。
 *   B. `apps/admin-api/src/**` 的 `throw new *Exception|Error(<字面量>)`（剥注释后）。
 *   B2. `apps/admin-api/src/common/errors/catalog/*.ts` 的 `zh:` 文案（AppError 码表）。
 *   C. 执行器侧：`apps/executor-node/src/**` 的 throw、`apps/executor-python/**`
 *      与 `packages/**` 的 `raise *Error(` 与 `detail=`。
 *   D. `apps/admin-web/src/**` 的 JSX 文本 / 用户可见属性 / message·notification·Modal 文案。
 *
 * ## 什么**不算**违规（刻意豁免面）
 *
 *   · 代码注释、JSDoc、`logger.*` 日志（开发者面）；`src/locales/**` 的 i18n 资源；
 *   · 纯技术标识：HTTP 头名、env 名、MIME、文件扩展名、协议 token、`{placeholder}`；
 *   · 品牌/专有名词（`AutoCodeFlow`、`Python`、`Redis`…）与中文技术文案里惯用的
 *     技术名词（`Webhook`、`Token`、`Cron`…，见 `MIXED_EXEMPT_TOKENS` 的逐条理由）；
 *   · 测试文件（`*.spec.ts` / `__tests__` / `test_*.py`）。
 *
 * ## 用法
 *   node scripts/check-user-facing-language.mjs              # 守卫
 *   node scripts/check-user-facing-language.mjs --report     # 打印全部命中（带 file:line）
 *   node scripts/check-user-facing-language.mjs --update     # 重写基线（只允许收紧；变大需 --force）
 *   node scripts/check-user-facing-language.mjs --selftest   # 验证判据本身（含退出码断言）
 *   node scripts/check-user-facing-language.mjs --root <dir> # 把该目录当仓库根（selftest 专用）
 *
 * ## T4（第 4 轮守卫自检审计）修掉的假绿
 *
 *   · **只测函数，不测闸门（最贵的一条）**：旧 `--selftest` 23 条全是内存断言
 *     （`violatesLanguage('…') === true`、`evaluateBaseline({items, baseline})`），
 *     **一次都没跑过 CLI**。把 `process.exit(code)` 里那条 `code` 改成 0、或者让
 *     `run()` 永远 return 0，23 条断言照样全绿——「报告在说话，闸不关门」。
 *     现在每条用例在 `mkdtemp` 里造**真仓库树**（openapi.json + src + 最小基线），
 *     以 `--root` 跑真子进程，断言退出码 + 关键文本。
 *   · **`--report` / `--update` 吞结构错**：旧实现里 `--report` **无条件 return 0**，
 *     `--update` 直接 `collectAll()`——openapi.json 缺失时前者报绿、后者抛 ENOENT 栈
 *     （CI 里看到的是「守卫崩了」，不是「事实源缺失」）。两者都不会因为「扫描面塌了」
 *     而红。现在三条出口共用 `preflight()`：事实源缺失 → **结构红**，不再有栈。
 *   · **`--update` 会把「扫描面为空」写成合法基线**：采集正则/路径失配 ⇒ 0 命中 ⇒
 *     `--update` 写出一份空基线 ⇒ 从此永远绿（这是最贵的一种「用登记代替修复」）。
 *     现在 0 命中也是结构红，`--update` 拒绝写盘。
 *   · **棘轮「只许收紧」没有在磁盘上被验证**：旧 selftest 只断言
 *     `update` 的**返回值**，没看基线文件是否真的没变。现在用例跑完 `--update` 后
 *     **读回基线文件**断言条目数，并再跑一次守卫确认真的收紧了。
 *   · **`import` 即执行**：旧 CLI 用 `pathToFileURL(process.argv[1] ?? '')` 比较，
 *     本身是对的；但模块顶层 `const root = …` 与四个采集器把它钉死，selftest 只能
 *     在**本仓库**上跑，没法对「另一棵树」验证闸门。现在采集器接 `root` 参数、
 *     默认 `DEFAULT_ROOT`（由脚本位置推出）。
 *   · **前缀误配（大小写敏感）**：`EXEMPT_TOKENS` 里的 `DELETE/GET/POST` 是 HTTP 方法，
 *     必须**区分大小写**匹配（`Delete task` 是英文散文，不是方法名）。这条已有实现，
 *     但旧 selftest 只用 `isNonChineseUserText` 侧面覆盖；现在由 `title="Delete task"`
 *     的子进程用例正面钉住。
 *
 * 纯静态读取已提交产物 + 源码正则，无需 npm ci / PG / Redis，秒级。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expectExit, makeFixtureRepo, reportCases, runGuard } from './lib/guard-selftest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 默认仓库根：脚本位于 `<repo>/scripts/`，由脚本位置推出，不依赖调用方 cwd。 */
export const DEFAULT_ROOT = path.resolve(here, '..');
const SPEC = 'apps/admin-api/openapi.json';
const BASELINE = 'scripts/user-facing-language-baseline.json';

/**
 * 扫描面下界：至少 1 处命中。
 *
 * 取 1 而不是历史规模（实测 9 处）：这条钉的是「四个采集面还能不能扫到东西」，
 * 不是「欠账有几条」。`items.length === 0` 时「全部在基线内」是一句**没有宾语**的
 * 真话——要么真的全中文化了（那该收紧基线到空、并考虑退役本守卫），要么采集正则/
 * 路径已失配。两种情形的处置相反，所以判红（失败方向）。
 */
export const MIN_ITEMS = 1;

/** 含 CJK 统一表意文字。 */
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
  // 操作系统 / 格式名（专有名词，译了反而错；`Windows 上不受支持` 是正确中文）
  'Windows', 'Linux', 'macOS', 'Darwin', 'Ubuntu', 'CentOS', 'Debian', 'Alpine',
  'Markdown', 'Base32', 'Base64', 'UTF-8', 'ISO', 'RFC', 'Cron', 'Crontab',
  // 语言名（语言切换菜单里显示的就是语言自己的名字）
  'English', 'Chinese',
  'Prometheus', 'Grafana', 'Alertmanager', 'OIDC', 'SAML', 'JWT', 'TOTP', 'LDAP',
  // 语言 / 运行时（专有名词，不译）
  'Python', 'Node', 'Node.js', 'Shell', 'Bash', 'PowerShell', 'JavaScript',
  'TypeScript', 'Java', 'Go', 'Rust', 'Ruby', 'PHP', 'Deno', 'Bun', 'uv', 'pip',
  'npm', 'pnpm', 'yarn', 'git', 'curl', 'wget', 'zip', 'tar', 'gzip',
  // 协议 / 格式 / 头 / 通用技术缩写
  'HTTP', 'HTTPS', 'JSON', 'YAML', 'XML', 'CSV', 'SSE', 'WebSocket', 'CORS',
  'URL', 'URI', 'UUID', 'SHA', 'MD5', 'HMAC', 'AES', 'TLS', 'SSL', 'IP', 'DNS',
  'API', 'SDK', 'CLI', 'MCP', 'UI', 'UX', 'ID', 'OK', 'CPU', 'RAM', 'GPU',
  'SQL', 'PG', 'TTL', 'UID', 'RPC', 'IPC', 'MIME', 'CDN', 'JVM', 'PID', 'AI',
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

/**
 * **仅在中英混排里放行的技术名词**。
 *
 * 为什么要和 `EXEMPT_TOKENS` 分开：判据一（纯英文）与判据二（混排）的"合理"
 * 阈值不同。`"Alertmanager v2 webhook body"` 是**纯英文欠账**（必须红，
 * 有回归钉），而 `"Webhook 鉴权失败"` 是**正确的中文文案**（红它就是假红）。
 * 把后者放进全局豁免表会让前者一起漏掉，所以单独一张表。
 *
 * 每一条都必须是「中文技术文案里惯用、且译了反而更差」的词。加词之前先问：
 * 这条出现在纯英文串里该不该红？该红 ⇒ 只能进本表。
 */
export const MIXED_EXEMPT_TOKENS = [
  // 产品概念（本仓文档/UI 里一贯沿用英文，译成「智能体/钩子」反而与界面不一致）
  'Webhook', 'Token', 'Agent', 'Cron', 'Glue', 'Runbook', 'Ollama', 'Verdaccio',
  // OAuth2 / JWT 里成对出现的专有名词（`返回 Access Token 与 Refresh Token` 是惯用中文）
  'Access', 'Refresh', 'Events', 'EventSource',
  'Commit', 'Pull', 'Push', 'Sandbox', 'Runtime', 'Workflow', 'Prompt',
  'Provider', 'Capability', 'Capabilities', 'Embedding', 'Rerank', 'Streaming',
  // 国际化 / OIDC / 通知面
  'Google', 'Microsoft', 'Authenticator', 'DingTalk', 'Feishu', 'Slack',
  // 运行时/工具名（`uv venv`、`bwrap` 属专有名词）
  'venv', 'bwrap', 'systemd', 'nginx', 'etcd', 'k8s',
];

/**
 * **英文虚词**（语法词）。区分"英文散文漏进中文文案"与"中文文案里带技术名词"：
 * 只有出现虚词的英文段才可能是句子碎片。名词/形容词（`failed`/`error`/`invalid`）
 * 刻意**不**列进来——它们靠"首字母大写"这条判据抓（`Failed to 保存`）。
 */
export const FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'else', 'then', 'than', 'so',
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'without', 'from', 'into',
  'onto', 'over', 'under', 'about', 'per', 'via', 'as', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'done', 'have',
  'has', 'had', 'will', 'would', 'shall', 'should', 'can', 'could', 'may',
  'might', 'must', 'not', 'no', 'yes', 'please', 'use', 'using', 'used',
  'instead', 'only', 'also', 'any', 'all', 'some', 'more', 'less', 'out',
  'up', 'down', 'here', 'there', 'this', 'that', 'these', 'those', 'it',
  'its', 'you', 'your', 'we', 'our', 'they', 'their', 'which', 'what', 'who',
  'when', 'where', 'why', 'how', 'because', 'while', 'during', 'after',
  'before', 'until', 'unless', 'once', 'again', 'too', 'very', 'just',
  'cannot', 'expected', 'unexpected',
]);

/**
 * 豁免词的匹配正则。
 *
 * ⚠️ **全大写标识必须区分大小写**（第 4 轮审计顺带发现的真实空洞）：首版对
 * 所有豁免词都用 `/gi`，而表里有 HTTP 方法 `DELETE`/`GET`/`POST`/`PUT`/`PATCH`、
 * 头名 `HEAD`… 于是普通英文动词 `Delete`、`Get` 也被当成"技术标识"抹掉了：
 *
 *     isNonChineseUserText('Delete task')  // 旧实现 → false（漏判）
 *
 * 用户界面里 `title="Delete task"` 这类硬编码英文正是 D6 要抓的形态，抹掉动词
 * 等于把判据做空。⇒ 全大写 token 走 `g`（区分大小写），其余（品牌名
 * `Redis`/`python` 这类大小写不敏感的专有名词）保持 `gi`。
 */
function exemptRe(token) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isConstToken = /^[A-Z][A-Z0-9_.-]*$/.test(token);
  return new RegExp(`\\b${esc}\\b`, isConstToken ? 'g' : 'gi');
}

/**
 * **结构性掩码**（判据一/判据二共用）：把"不是散文"的东西抹成空格。
 *
 * 覆盖：URL / email / 头名 / 字符类 / `{placeholder}` / `${expr}` / 文件名 /
 * 路径 / ENV 名 / `key=value` / shell flag / camelCase / PascalCase / snake_case /
 * 点号标识符 / 连字符复合词 / 比较表达式（`createdAt < until`）。
 *
 * ⚠️ 这一层是**判据一的既有行为 + 第 4 轮补的结构项**。补结构项的判据是
 * 「它不可能是用户要读的中文散文」——例如 `placeholder="oncall@example.com"`
 * 是示例值，`${e.name} (${e.address})` 是模板插值，`daily-report` 是 slug。
 * 首版只抹了 URL/路径/文件扩展名，于是这些示例值全被当成"未中文化的英文"，
 * 一旦把 admin-web 纳入扫描面就会变成几百条假红（守卫自己制造噪音）。
 */
function maskCore(text) {
  let s = text;
  s = s.replace(/https?:\/\/\S+/g, ' ');
  s = s.replace(/\b[\w.+-]+@[\w.-]+\.\w+/g, ' ');
  s = s.replace(/\bX-[A-Za-z]+(?:-[A-Za-z]+)+\b/g, ' ');
  s = s.replace(/\$\{[^{}]*\}/g, ' ');
  s = s.replace(/`[^`\n]*`/g, ' '); // 行内代码字面量（`` `# truncated at N rows` `` 是格式标记，不是散文）
  s = s.replace(/\{[^{}]*\}/g, ' '); // {placeholder} / {{name}}
  s = s.replace(/\[[^[\]\n]*\]/g, ' '); // [A-Za-z0-9._/ :\-] 字符类 / [tag]
  s = s.replace(/[\w.-]+\.(tsx?|jsx?|json|py|md|sh|yml|yaml|log|gz|zip|txt|html|css|toml|cfg|ini)\b/g, ' ');
  s = s.replace(/\b[\w.-]+\/[\w./-]*/g, ' ');
  s = s.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, ' '); // ENV_NAME
  // `key=value`：**值必须是单个 token**才抹（`mode=down`、`secret=…`）。
  // 刻意不抹 `empty = upstream reachable but no packages` 这种短语——那正是
  // 要抓的半英半中（抹了就把真实欠账一起埋掉）。
  s = s.replace(/\b[A-Za-z_][\w.]*\s*=\s*[A-Za-z0-9_.:-]+/g, ' ');
  s = s.replace(/\s=\s*[A-Za-z_][\w.]*/g, ' '); // `元类型 = Object`
  s = s.replace(/\s--?[A-Za-z][\w-]*/g, ' '); // shell flag
  s = s.replace(/[<>]=?\s*[A-Za-z_]\w*/g, ' '); // 比较表达式（先抹右侧，`createdAt < until` 才不会漏 until）
  s = s.replace(/[A-Za-z_]\w*\s*[<>]=?/g, ' '); // createdAt <
  s = s.replace(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g, ' '); // camelCase
  s = s.replace(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g, ' '); // PascalCase
  s = s.replace(/\b\w+_\w+\b/g, ' '); // snake_case
  s = s.replace(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b/g, ' '); // params.dir
  s = s.replace(/\b[A-Za-z]+(?:-[A-Za-z0-9]+)+\b/g, ' '); // front-matter / ADMIN-only / Server-Sent
  return s.trim();
}

function applyExemptTokens(s, tokens) {
  let out = s;
  for (const t of tokens) out = out.replace(exemptRe(t), ' ');
  return out;
}

/** 判据二用：结构掩码 + 全局豁免词 + **混排专用**技术名词。 */
export function maskExempt(text) {
  if (typeof text !== 'string') return '';
  return applyExemptTokens(maskCore(text), [...EXEMPT_TOKENS, ...MIXED_EXEMPT_TOKENS]);
}

/** 判据一用：结构掩码 + 全局豁免词（**不含**混排专用表，见 MIXED_EXEMPT_TOKENS 说明）。 */
export function maskExemptForPureEnglish(text) {
  if (typeof text !== 'string') return '';
  return applyExemptTokens(maskCore(text), EXEMPT_TOKENS);
}

/**
 * **判据二（残留英文）**：返回"不该出现在中文文案里的英文词"。
 *
 * 只在**含 CJK** 的串上调用；返回空数组 = 无残留。
 * 完整规则见文件头「判据（精确口径）」②–⑤。
 */
export function residualEnglish(text) {
  if (typeof text !== 'string' || !CJK_RE.test(text)) return [];
  const masked = maskExempt(text);
  const out = [];
  // 汉字/其它非 ASCII 是断点：一段英文只可能出现在"同一语段"里
  for (const run of masked.split(/[^\x20-\x7e]+/)) {
    const all = run.match(/[A-Za-z]+/g) ?? [];
    const long = all.filter((w) => w.length >= 4);
    if (long.length === 0) continue;
    // 全大写词（HEAD / YAML / API / PDF）是缩写或常量，不是散文
    const prose = long.filter((w) => !/^[A-Z]{2,}$/.test(w));
    if (prose.length === 0) continue;
    const funcs = all.filter((w) => FUNCTION_WORDS.has(w.toLowerCase()));
    if (funcs.length > 0) {
      // 有虚词 ⇒ 英文句子碎片漏进中文（`… helper instead`、`not found`）
      out.push(...new Set([...prose, ...funcs]));
      continue;
    }
    // 无虚词：全小写段视为技术名词组 / 枚举值列表 / 标识符，放过
    if (prose.every((w) => /^[a-z]+$/.test(w))) continue;
    // 首字母大写的非缩写词 ⇒ 散文（`Failed to 保存`、`Unauthorized 401`）
    out.push(...prose);
  }
  return [...new Set(out)];
}

/**
 * 是否含**实质英文正文**（判据一，无 CJK 的串）。
 *
 * 判据刻意区分「散文」与「代码标识符」：
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
  const r = maskExemptForPureEnglish(text);
  if (!r) return false;
  // 全大写词（`VL`、`PDF`、`ID`）是缩写/常量：`Qwen VL` 这种**型号显示名**不该红。
  const words = (r.match(/[A-Za-z]{2,}/g) ?? []).filter((w) => !/^[A-Z]{2,}$/.test(w));
  if (words.length >= 2) return true;
  // 单残留词：仅当首字母大写（散文形态，如 Unauthorized）才判违规；
  // 全小写单词视为代码标识/枚举值。
  return words.length === 1 && /^[A-Z]/.test(words[0]);
}

/** 无 CJK 的串是否属于"未中文化"（判据一）。 */
export function isNonChineseUserText(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (CJK_RE.test(text)) return false;
  return hasSubstantiveEnglish(text);
}

/**
 * **统一判据入口**：这个字符串是不是面向用户文字里的语言欠账。
 *
 * 含 CJK ⇒ 判据二（残留英文散文）；不含 CJK ⇒ 判据一（实质英文正文）。
 * 所有采集器都调这个函数，避免出现"某个面忘了升级判据"的裂缝
 * （首版的裂缝正是：`isNonChineseUserText` 一见汉字就返回 false）。
 */
export function violatesLanguage(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (CJK_RE.test(text)) return residualEnglish(text).length > 0;
  return hasSubstantiveEnglish(text);
}

// ── 采集面 A：openapi.json ────────────────────────────────────────────────
export function collectOpenApi(spec) {
  const out = [];
  const schemas = spec.components?.schemas ?? {};
  for (const [name, s] of Object.entries(schemas)) {
    for (const [prop, v] of Object.entries(s?.properties ?? {})) {
      if (violatesLanguage(v?.description)) {
        out.push({ kind: 'schema', key: `${name}.${prop}`, text: v.description });
      }
    }
  }
  for (const [p, ops] of Object.entries(spec.paths ?? {})) {
    for (const [m, op] of Object.entries(ops)) {
      for (const field of ['summary', 'description']) {
        if (violatesLanguage(op?.[field])) {
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
        if (violatesLanguage(param?.description)) {
          out.push({
            kind: 'param',
            key: `${where}.parameters[${param?.name ?? '?'}].description`,
            text: param.description,
          });
        }
      }
      const rb = op?.requestBody;
      if (violatesLanguage(rb?.description)) {
        out.push({
          kind: 'requestBody',
          key: `${where}.requestBody.description`,
          text: rb.description,
        });
      }
      for (const [code, r] of Object.entries(op?.responses ?? {})) {
        if (violatesLanguage(r?.description)) {
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

function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

export function collectThrownMessages(src) {
  const out = [];
  const clean = stripComments(src);
  // 先剥注释：注释里对旧实现的**引用**不是真实抛点（见 stripComments 的长注释）。
  for (const m of clean.matchAll(THROW_RE)) {
    const text = m[1] ?? m[2] ?? m[3] ?? '';
    if (violatesLanguage(text)) out.push({ text, line: lineAt(clean, m.index ?? 0) });
  }
  return out;
}

// ── 采集面 B2：AppError 码表的中文文案 ───────────────────────────────────
/**
 * LANG-ERR-01 之后，admin-api 的用户面文案不再写在 `throw` 实参里，而是
 * 「只抛稳定码 + 参数」，文案由前端按 `errorCode` 从码表翻译。于是：
 *
 *   · 只扫 `throw new *Exception("…")` ＝ 扫一个**已经搬家的空房子**；
 *   · 真正会显示给用户的中文是 `catalog/*.ts` 里的 `zh` 字段。
 *
 * 只取 `zh`：`en` 字段是**刻意的英文**（双语码表），扫它等于把设计判成缺陷。
 */
const CATALOG_ZH_RE = /\bzh\s*:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g;

export function collectCatalogZh(src) {
  const out = [];
  const clean = stripComments(src);
  for (const m of clean.matchAll(CATALOG_ZH_RE)) {
    const text = m[1] ?? m[2] ?? m[3] ?? '';
    if (violatesLanguage(text)) out.push({ text, line: lineAt(clean, m.index ?? 0) });
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
 *
 * 同理排除 `build/`（实测 `packages/autoflow-sdk/build/lib/**` 是打包产物，
 * 与 `src` 同文案，会把同一处欠账记两遍、且改了 src 不改 build 会让棘轮永远
 * 收不紧）与 `locales/`（i18n 资源，见采集面 D 的说明）。
 */
const SKIP_DIRS = [
  'node_modules',
  'dist',
  'build',
  'generated',
  'locales',
  '__tests__',
  '.venv',
  'venv',
  'site-packages',
  '__pycache__',
  '.git',
  'coverage',
];

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.includes(e.name)) continue;
      walk(p, acc);
    } else if (/\.(ts|tsx|py)$/.test(e.name) && !/\.(d)\.ts$/.test(e.name) && !/\.(spec|test|selftest)\./.test(e.name)) {
      acc.push(p);
    }
  }
  return acc;
}

export function collectAdminApi(root = DEFAULT_ROOT) {
  const out = [];
  const base = path.join(root, 'apps/admin-api/src');
  if (!fs.existsSync(base)) return out;
  for (const f of walk(base)) {
    if (!f.endsWith('.ts')) continue;
    const rel = path.relative(root, f);
    const src = fs.readFileSync(f, 'utf-8');
    // 采集面 B2：错误码表的 zh 文案（AppError 之后的用户面真身）
    if (rel.includes(`${path.sep}common${path.sep}errors${path.sep}catalog${path.sep}`)) {
      for (const hit of collectCatalogZh(src)) {
        out.push({ kind: 'catalog-zh', key: rel, text: hit.text, line: hit.line });
      }
      continue;
    }
    if (f.includes(`${path.sep}dto${path.sep}`)) continue; // DTO 走 openapi 面
    for (const hit of collectThrownMessages(src)) {
      out.push({ kind: 'throw', key: rel, text: hit.text, line: hit.line });
    }
  }
  return out;
}

// ── 采集面 C：执行器侧（node / python）面向用户的文案 ──────────────────────
/**
 * 执行器的 `throw new *Error("...")` / `raise *Error("...")` 消息会经回调
 * `errorMessage` 显示在中台的执行详情/失败原因里——与 admin 的 throw 同属
 * **用户可见文案**，故纳入同一判据面。
 *
 * 刻意**不**采集 `logger.*` / 注释 / docstring：那些是开发者面。执行器侧
 * 另有一批 `code`/`failureReason` 类的**机器标识符**（如 `bad_archive`），
 * 它们不是散文、翻译它们会破坏语义——判据一靠"≥2 个英文词或 1 个首字母大写的词"
 * 的实质正文门槛、判据二靠"全小写词段=技术标识"天然放过单词标识符。
 */
const PY_RAISE_RE = /raise\s+\w*(?:Error|Exception)\(\s*(?:f?)(?:`([^`]*)`|'([^']*)'|"([^"]*)")/g;

/**
 * Python 的 `detail=` 关键字实参：`HTTPException(status_code=400, detail='…')`
 * 是 **FastAPI 直接回给客户端**的响应体 `detail` 字段——比 `raise` 更"用户面"。
 * 首版只认 `raise`，于是 `routers/logs.py` / `config.py` 的 detail 文案完全不在面内
 * （审计 §2.9 的第 3 条）。
 */
const PY_DETAIL_RE = /\bdetail\s*=\s*(?:f?)(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g;

export function collectPythonMessages(src, { library = false } = {}) {
  const out = [];
  const clean = stripComments(src);
  // library=true（对外 SDK/库）：纯英文异常消息是惯例，只抓"中文里残留英文"。
  const judge = library ? (t) => (CJK_RE.test(t ?? '') ? residualEnglish(t).length > 0 : false) : violatesLanguage;
  for (const m of clean.matchAll(PY_RAISE_RE)) {
    const text = m[1] ?? m[2] ?? m[3] ?? '';
    if (judge(text)) out.push({ text, line: lineAt(clean, m.index ?? 0) });
  }
  for (const m of clean.matchAll(PY_DETAIL_RE)) {
    const text = m[1] ?? m[2] ?? m[3] ?? '';
    if (judge(text)) out.push({ text, line: lineAt(clean, m.index ?? 0) });
  }
  return out;
}

/**
 * `packages/**` 是**对外发布的 SDK / 库**（`autoflow_sdk`、`autocodeflow_http`…），
 * 它们的异常消息面向第三方开发者、惯例就是英文——把纯英文算成"未中文化"会往
 * 基线里灌 13 条永远不该被"修"的假欠账（棘轮永远收不紧）。故这一面对**库**只
 * 套判据二（中文文案里不许残留英文散文）：中文串必须干净，纯英文串按库的惯例放行。
 * 这与任务口径一致：「python `detail=` / `raise` 的**中文串**纳入」。
 */
export function collectExecutors(root = DEFAULT_ROOT) {
  const out = [];
  const targets = [
    { dir: path.join(root, 'apps/executor-node/src'), py: false, lib: false },
    { dir: path.join(root, 'apps/executor-python'), py: true, lib: false },
    { dir: path.join(root, 'packages'), py: true, lib: true },
  ];
  for (const t of targets) {
    if (!fs.existsSync(t.dir)) continue;
    for (const f of walk(t.dir)) {
      // python 的 tests/ 由 walk 的 __tests__ 规则覆盖不到，这里显式排除。
      if (t.py && (!f.endsWith('.py') || f.includes(`${path.sep}tests${path.sep}`) || path.basename(f).startsWith('test_'))) {
        continue;
      }
      if (!t.py && !f.endsWith('.ts')) continue;
      const src = fs.readFileSync(f, 'utf-8');
      const rel = path.relative(root, f);
      const hits = t.py
        ? collectPythonMessages(src, { library: t.lib })
        : collectThrownMessages(src);
      for (const hit of hits) {
        out.push({ kind: t.py ? 'py-detail' : 'executor', key: rel, text: hit.text, line: hit.line });
      }
    }
  }
  return out;
}

// ── 采集面 D：admin-web 用户界面文案 ──────────────────────────────────────
/**
 * 审计 D6：`apps/admin-web/**` 完全不在扫描面。本仓 admin-web 已 2798 个 i18n
 * key 全覆盖，所以这里的**真正价值**是守住"绕过 `t()` 硬编码英文"这个形态——
 * 它不报错、不影响构建，只有切到中文界面的用户会看到。
 *
 * 判据面刻意做**窄**（否则就是几千条 className/key/URL 噪音）：
 *   · JSX 文本节点（跳过 `code`/`pre`/`kbd` 上下文：那里面 `npm login`、`Promise`
 *     是**代码样例**，译了就是错）；
 *   · 用户可见属性：`placeholder|title|label|tooltip|okText|cancelText|emptyText|
 *     description|header|aria-label|alt|subTitle|help`（只认字符串字面量，
 *     `{t(...)}` 一律不采——那正是正确的写法）；
 *   · `message.*` / `notification.*` 的文案实参、`Modal.confirm({ title, content })`。
 *   · **排除 `locales/**`**：见 SKIP_DIRS 的说明。
 */
const WEB_COPY_ATTRS = [
  'placeholder',
  'title',
  'label',
  'tooltip',
  'okText',
  'cancelText',
  'emptyText',
  'description',
  'header',
  'subTitle',
  'help',
  'alt',
  'aria-label',
];

const WEB_ATTR_RE = new RegExp(
  `\\b(?:${WEB_COPY_ATTRS.join('|')})\\s*=\\s*(?:"([^"]{2,})"|'([^']{2,})'|\\{\\s*"([^"]{2,})"\\s*\\}|\\{\\s*'([^']{2,})'\\s*\\})`,
  'g',
);

const WEB_PROP_RE = new RegExp(
  `\\b(?:${WEB_COPY_ATTRS.join('|')}|content|message)\\s*:\\s*(?:"([^"]{2,})"|'([^']{2,})'|\`([^\`]{2,})\`)`,
  'g',
);

const WEB_MESSAGE_RE =
  /\b(?:message|notification)\.(?:success|error|warning|info|loading|open|warn)\(\s*(?:\{[^{}]*?(?:message|description)\s*:\s*)?["'`]([^"'`]{2,})["'`]/g;

/** JSX 文本节点里"像人话"的内容（排除代码/表达式）。 */
function isProseText(t) {
  if (!t) return false;
  if (!/[A-Za-z\u4e00-\u9fff]/.test(t)) return false;
  if (/[{}()=;|&<>$]/.test(t)) return false; // 表达式/泛型/箭头片段
  if (/^\s*[.,;:!?)\]]+\s*$/.test(t)) return false;
  return t.trim().length > 1;
}

/**
 * 抹掉**模板字面量内容**（保留 `${…}` 之外的结构）。
 *
 * 为什么：`GlueEditor` 的内置示例脚本是一整个模板字面量，里面有
 * `message: 'Task completed successfully'` —— 那是**代码样例**（译了脚本就错），
 * 但 `WEB_PROP_RE` 会把它当成 `message:` 文案捕获（实测 1 条假红）。
 * 同理 `${e.name} (${e.address})` 这类插值也不是文案。
 */
function maskTemplateLiterals(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] !== '`') {
      out += src[i];
      i += 1;
      continue;
    }
    out += '`';
    i += 1;
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '$' && src[i + 1] === '{') {
        depth += 1;
        out += '  ';
        i += 2;
        continue;
      }
      if (depth > 0 && c === '}') {
        depth -= 1;
        out += ' ';
        i += 1;
        continue;
      }
      if (depth === 0 && c === '`') {
        out += '`';
        i += 1;
        break;
      }
      out += c === '\n' ? '\n' : ' ';
      i += 1;
    }
  }
  return out;
}

/** 采集单个 tsx/ts 文件里的面向用户文案。 */
export function collectWebCopy(src) {
  const out = [];
  const clean = maskTemplateLiterals(stripComments(src));
  const push = (text, offset) => {
    if (!text) return;
    const t = text.replace(/\s+/g, ' ').trim();
    if (!violatesLanguage(t)) return;
    out.push({ text: t, line: lineAt(clean, offset) });
  };

  // ① JSX 文本节点：在"一个闭合标签"与"下一个标签开头"之间的纯文本
  const tagRe = /<\/?([A-Za-z][\w.:-]*)((?:\s[^<>]*?)?)\/?>/g;
  const tags = [...clean.matchAll(tagRe)];
  for (let i = 0; i + 1 < tags.length; i++) {
    const open = tags[i];
    const next = tags[i + 1];
    const openName = open[1] ?? '';
    const openAttrs = open[2] ?? '';
    // 代码样例上下文：<code>/<pre>/<kbd>，或带 `code` 属性的 antd Text/Title
    if (/^(code|pre|kbd)$/i.test(openName) || /\scode\b/.test(openAttrs)) continue;
    const between = clean.slice((open.index ?? 0) + open[0].length, next.index ?? 0);
    if (!isProseText(between)) continue;
    push(between, open.index ?? 0);
  }

  // ② 用户可见属性 / 对象字面量里的文案
  for (const re of [WEB_ATTR_RE, WEB_PROP_RE]) {
    for (const m of clean.matchAll(re)) {
      push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '', m.index ?? 0);
    }
  }
  // ③ message.* / notification.*
  for (const m of clean.matchAll(WEB_MESSAGE_RE)) {
    push(m[1] ?? '', m.index ?? 0);
  }
  return out;
}

export function collectAdminWeb(root = DEFAULT_ROOT) {
  const out = [];
  const base = path.join(root, 'apps/admin-web/src');
  if (!fs.existsSync(base)) return out;
  for (const f of walk(base)) {
    if (!/\.tsx?$/.test(f)) continue;
    const src = fs.readFileSync(f, 'utf-8');
    for (const hit of collectWebCopy(src)) {
      out.push({ kind: 'web-copy', key: path.relative(root, f), text: hit.text, line: hit.line });
    }
  }
  return out;
}

// ── 主流程 ───────────────────────────────────────────────────────────────
function loadJson(root, p) {
  return JSON.parse(fs.readFileSync(path.join(root, p), 'utf-8'));
}

/**
 * 事实源预检（run / report / update 三条出口共用）。
 *
 * 旧实现里三条出口各自读文件：`--report` 根本不做检查（缺失也报绿）、`run` 把缺失
 * 当成一条普通提示、`--update` 直接收到 ENOENT 栈。三条处置应当一致：**结构红**。
 *
 * @returns {string[]} structure（空数组 = 事实源齐全）
 */
export function preflight(root = DEFAULT_ROOT) {
  const structure = [];
  const specPath = path.join(root, SPEC);
  if (!fs.existsSync(specPath)) {
    structure.push(
      `事实源缺失：${SPEC} —— 采集面 A（openapi 文档面）无从执行；` +
        `四面的「欠账总数」因此不可信（不是「已经中文化完了」）。`,
    );
    return structure;
  }
  try {
    JSON.parse(fs.readFileSync(specPath, 'utf-8'));
  } catch (error) {
    structure.push(`事实源不可解析：${SPEC}（${error?.message ?? error}）—— 采集面 A 无法读取。`);
  }
  return structure;
}

/** 稳定键：kind + 位置 + 文本（文本本身进键，避免同位置换文案被漏检）。 */
function itemKey(it) {
  return `${it.kind}\t${it.key}\t${it.text}`;
}

export function collectAll(root = DEFAULT_ROOT) {
  const spec = loadJson(root, SPEC);
  return [
    ...collectOpenApi(spec),
    ...collectAdminApi(root),
    ...collectExecutors(root),
    ...collectAdminWeb(root),
  ];
}

/**
 * 棘轮裁决（**纯函数**，可被 selftest 直接喂 items/baseline 断言退出码）。
 *
 * 三种红：
 *   ① `added`：新增欠账未登记（杜绝静默新增）；
 *   ② `fixed`：基线登记项**已不再命中**（有人中文化了却没跑 `--update`）
 *      ⇒ 棘轮该收紧。这是"基线只增不减是反模式"的落地点：修好了却把旧条目
 *      留在基线里，等于用登记代替修复，棘轮永远收不紧。
 *   ③ `capExceeded`：登记项数量超过 `maxKnown`（防"登记代替修复"）。
 */
export function evaluateBaseline({ items, baseline }) {
  const known = new Set(baseline?.known ?? []);
  const current = new Set(items.map(itemKey));
  const added = [...current].filter((k) => !known.has(k));
  const fixed = [...known].filter((k) => !current.has(k));
  const cap = typeof baseline?.maxKnown === 'number' ? baseline.maxKnown : known.size;
  const capExceeded = known.size > cap;
  const code = added.length > 0 || fixed.length > 0 || capExceeded ? 1 : 0;
  return { added, fixed, cap, capExceeded, code };
}

function describeKey(k, byKey) {
  const [, where, text] = k.split('\t');
  const line = byKey.get(k)?.line;
  return `${where}${line ? `:${line}` : ''}  ${String(text).slice(0, 90)}`;
}

export function run({
  root = DEFAULT_ROOT,
  report = false,
  items: injected = null,
  baseline: injectedBaseline = null,
  quiet = false,
} = {}) {
  const err = quiet ? () => {} : (...a) => console.error(...a);

  // 事实源预检：`--report` 也**必须**过这一关。旧实现 `--report` 无条件 return 0，
  // 于是 openapi.json 缺失时它照报「欠账共 N 处」——报告在说话，事实源不在。
  const structure = preflight(root);
  if (structure.length > 0) {
    for (const line of ['', '✖ LANG-ZH-01 结构错误（判据本身不可信，先修事实源）：']) err(line);
    for (const s of structure) err('  · ' + s);
    err('');
    return 1;
  }

  const items = injected ?? collectAll(root);

  if (report) {
    const byKind = items.reduce((a, i) => ((a[i.kind] = (a[i.kind] ?? 0) + 1), a), {});
    console.log(`LANG-ZH-01 报告：面向用户语言欠账共 ${items.length} 处`);
    for (const [k, v] of Object.entries(byKind).sort()) console.log(`   ${k}: ${v}`);
    // 逐条列出（带 file:line 与触发词）——`--report` 的价值就在这里：
    // 让人能直接判断"这条该改文案，还是该进白名单"。
    console.log('   明细（file:line ｜ 触发词 ｜ 原文）：');
    for (const i of items.slice().sort((a, b) => a.key.localeCompare(b.key) || (a.line ?? 0) - (b.line ?? 0))) {
      const words = CJK_RE.test(String(i.text)) ? residualEnglish(String(i.text)) : [];
      console.log(
        `     [${i.kind}] ${i.key}${i.line ? `:${i.line}` : ''}` +
          `  ← ${words.length ? words.join(',') : '英语正文'}\n         ${String(i.text).replace(/\s+/g, ' ').slice(0, 160)}`,
      );
    }
    return 0;
  }

  const baselinePath = path.join(root, BASELINE);
  if (!injectedBaseline && !fs.existsSync(baselinePath)) {
    err('');
    err('✖ LANG-ZH-01 结构错误（判据本身不可信，先修事实源）：');
    err(`  · 事实源缺失：${BASELINE} —— 棘轮没有基线可比（不是「一处欠账都没有」）。`);
    err('    用 --update 生成基线；基线缺失时的「通过」是没有参照物的通过。');
    err('');
    return 1;
  }

  // 扫描面下界：0 命中不是「干净」——它是「四个面一处都没扫到」，与「全中文化了」
  // 不可区分，而两者的处置完全相反（修采集器 vs 收紧基线/退役守卫）。判红。
  if (injected === null && items.length < MIN_ITEMS) {
    err('');
    err('✖ LANG-ZH-01 结构错误：扫描面为空 —— 四个采集面一处欠账都没扫到。');
    err(
      `  · 要么真的全部中文化完了（那就 --update 把基线收紧到空，并考虑退役本守卫），` +
        `要么采集正则/路径已失配。0 命中与「干净」不可区分，故按失败处理。`,
    );
    err('');
    return 1;
  }

  const baseline = injectedBaseline ?? loadJson(root, BASELINE);
  const byKey = new Map(items.map((i) => [itemKey(i), i]));
  const { added, fixed, cap, capExceeded, code } = evaluateBaseline({ items, baseline });

  const log = quiet ? () => {} : (...a) => console.log(...a);
  if (added.length > 0) {
    err(`✘ 新增 ${added.length} 处**面向用户的语言欠账**（未被基线登记）：`);
    for (const k of added.slice(0, 25)) err(`   · [${describeKey(k, byKey)}`);
    if (added.length > 25) err(`   … 其余 ${added.length - 25} 处见 --report`);
    err(
      '\n  处置：把面向用户的文案改为中文（**注释/日志/技术标识不在此列**）；' +
        '确属品牌名或专有名词的，加进本脚本的 EXEMPT_TOKENS / MIXED_EXEMPT_TOKENS。',
    );
  }
  if (fixed.length > 0) {
    err(
      `✘ 基线陈旧：${fixed.length} 处登记项已**不再命中**（有人中文化了，但基线没删）。`,
    );
    for (const k of fixed.slice(0, 10)) err(`   · [${describeKey(k, byKey)}`);
    console.error(
      '\n  处置：跑 `node scripts/check-user-facing-language.mjs --update` 收紧基线。' +
        '\n  为什么这也要红：留着旧条目会让基线永远收不紧（登记代替修复），' +
        '\n  这是审计点名的反模式——棘轮只许变好，且必须真的变好。',
    );
  }
  if (capExceeded) {
    err(`✘ 基线登记项增长（${(baseline.known ?? []).length} > 上限 ${cap}）——棘轮只许收紧不许放松。`);
  }
  if (code === 0) {
    log(
      `✔ LANG-ZH-01 通过：面向用户语言欠账 ${new Set(items.map(itemKey)).size} 处，全部在基线内（上限 ${cap}）。`,
    );
  }
  return code;
}

/**
 * `--update`：把当前命中写成新基线（棘轮收紧）。
 *
 * **只允许收紧**：新基线比旧基线**大**时拒绝写入（除非 `--force`）。理由：
 * 否则"跑一下 --update"就成了最省事的过关方式，棘轮变成单向橡皮图章，
 * 这正是审计说的"基线只增不减是反模式"。新增采集面（首次纳入 admin-web /
 * python detail 这类）才需要 `--force`，且应当在评审里说明。
 */
export function update({ root = DEFAULT_ROOT, items: injected = null, force = false } = {}) {
  // `--update` 也必须先过事实源预检：旧实现直接 collectAll()，openapi.json 缺失时
  // 把 ENOENT 栈打给 CI（读者会以为「守卫崩了」而不是「事实源缺失」）。
  const structure = preflight(root);
  if (structure.length > 0) {
    console.error('');
    console.error('✖ LANG-ZH-01 结构错误（判据本身不可信，先修事实源）：');
    for (const s of structure) console.error('  · ' + s);
    console.error('');
    return 1;
  }

  const items = injected ?? collectAll(root);

  // 扫描面为空时写基线 = 把「守卫失明」固化成「合法基线」，此后永远绿（审计点名的
  // 「用登记代替修复」的最贵形态）。拒绝写盘。
  if (injected === null && items.length < MIN_ITEMS) {
    console.error('');
    console.error('✖ 拒绝写入：扫描面为空（0 处命中），写出的基线会让守卫从此永远绿。');
    console.error('  先确认采集面（正则 / 路径）没坏；确实已全部中文化时，请显式删除基线文件');
    console.error('  并退役本守卫，而不是留下一份「空基线 + 永远通过」。');
    console.error('');
    return 1;
  }

  const keys = [...new Set(items.map(itemKey))].sort();
  const baselinePath = path.join(root, BASELINE);
  const prev = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) : { known: [] };
  const prevCount = (prev.known ?? []).length;
  if (keys.length > prevCount && !force) {
    console.error(
      `✘ 拒绝写入：新基线 ${keys.length} 条 > 旧基线 ${prevCount} 条。` +
        '\n  棘轮只允许收紧。若确实新增了采集面（新面首次纳入基线），' +
        '\n  用 `--update --force`，并把理由写进提交说明。',
    );
    return 1;
  }
  const payload = {
    $comment:
      'LANG-ZH-01 面向用户语言欠账清单（棘轮）。判据：无 CJK 的串须无实质英文正文；' +
      '含 CJK 的串须无残留英文散文（residualEnglish）。新增欠账 ⇒ 红；已修好但基线没删 ⇒ 也红。' +
      '用 check-user-facing-language.mjs --update 收紧。',
    maxKnown: keys.length,
    known: keys,
  };
  fs.writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  console.log(`✔ 基线已写入 ${BASELINE}：${keys.length} 条（旧 ${prevCount} 条）`);
  return 0;
}

// ── 自检：判据（内存）+ 闸门（真子进程）──────────────���─────────────────────
const SELF = fileURLToPath(import.meta.url);

/** 最小 openapi 文档（四个采集面里 A 面的事实源）。 */
const SPEC_JSON = {
  openapi: '3.1.0',
  info: { title: 'fixture', version: '0.0.0' },
  components: { schemas: {} },
  paths: {},
};

const SRC_BAD = 'apps/admin-api/src/bad.ts';
const SRC_KEEP = 'apps/admin-api/src/keep.ts';
const PAGE_BAD = 'apps/admin-web/src/Page.tsx';

/** 违规文案（半英半中）。 */
const BAD_THROW = 'export function bad() {\n  throw new BadRequestException("保存失败 Please retry");\n}\n';
/** 第二处违规（同一份文件 —— 用来钉「捕获组只留最后一个成员」）。 */
const BAD_THROW_2 = 'export function bad2() {\n  throw new BadRequestException("下载超时 Download timed out");\n}\n';
/** 合规中文。 */
const GOOD_THROW = 'export function ok() {\n  throw new BadRequestException("任务不存在");\n}\n';
/** 注释里的引用（不是抛点）。 */
const COMMENTED_THROW = '// 旧实现：throw new Error("Cannot 删除 任务")\n';
/** admin-web 硬编码英文（判据一）。 */
const PAGE_DELETE = 'export const P = () => <Button title="Delete task" />;\n';

/** 稳定键：与 itemKey() 同形（kind \t 相对路径 \t 文本）。 */
const keyOf = (kind, rel, text) => [kind, rel.split('/').join(path.sep), text].join('\t');
const KNOWN_BAD = keyOf('throw', SRC_BAD, '保存失败 Please retry');
const KNOWN_KEEP = keyOf('throw', SRC_KEEP, '下载超时 Download timed out');
const baselineOf = (known, maxKnown = known.length) => ({ $comment: 'fixture 基线', maxKnown, known });

function tree({ files = {}, omitSpec = false, baseline } = {}) {
  const out = { 'package.json': { name: 'fixture', private: true }, ...files };
  if (!omitSpec) out[SPEC] = SPEC_JSON;
  if (baseline !== undefined) out[BASELINE] = baseline;
  return out;
}

/** 读回 fixture 里的基线（验证「只许收紧」是否真的落在磁盘上）。 */
function readBaseline(dir) {
  const raw = fs.readFileSync(path.join(dir, BASELINE), 'utf-8');
  return JSON.parse(raw);
}

function check(cond, detail) {
  if (!cond) throw new Error(detail);
}

/** 自检：内存判据（保留原 23 条断言的语义）+ 真子进程闸门（退出码 + 关键文本）。 */
export function selftest() {
  const cases = [];

  // ── A. 判据本体（原 selftest 的语义，逐条保留）────────────────────────────
  cases.push({
    name: 'A1 判据二：半英半中 / 英文虚词 / `not found` 碎片都违规',
    fn: () => {
      check(violatesLanguage('Failed to 保存') === true, 'hasError: Failed to 保存 应违规');
      check(
        isNonChineseUserText('Failed to 保存') === false,
        '判据一（无 CJK 才走）不得介入含 CJK 的串',
      );
      check(violatesLanguage('保存失败 Please retry') === true, '保存失败 Please retry 应违规');
      check(
        violatesLanguage(
          'Git 仓库 URL 不得内嵌凭据 — use GIT_ASKPASS / a credential helper instead',
        ) === true,
        '英文虚词散文应违规',
      );
      check(violatesLanguage('要重试的任务 not found') === true, 'not found 碎片应违规');
    },
  });

  cases.push({
    name: 'A2 反向：技术名词 / 枚举列表 / 占位符 / 路径 / 大写缩写都不误红',
    fn: () => {
      check(violatesLanguage('执行器不存在') === false, '纯中文不得违规');
      check(
        violatesLanguage('轮换后旧 Token 立即失效，Cron 计划重新注册') === false,
        '中文 + Token/Cron 不得违规',
      );
      check(violatesLanguage('Webhook 鉴权失败') === false, 'Webhook 鉴权失败不得违规');
      check(violatesLanguage('执行器 Python 运行时不可用') === false, 'Python 不得违规');
      check(violatesLanguage('无效的 config reload 请求') === false, '全小写技术词组不得违规');
      check(
        violatesLanguage('kind 必须是 video | screenshot | other') === false,
        '枚举值列表不得违规',
      );
      check(violatesLanguage('参数 {{name}} 必须是整数') === false, '{placeholder} 不得违规');
      check(violatesLanguage('params.dir 不存在且位于 demo 目录之外') === false, '点号标识符不得违规');
      check(violatesLanguage('Redis 客户端已关闭（status=end）') === false, 'key=value 不得违规');
      check(violatesLanguage('git rev-parse HEAD 执行失败') === false, '全大写缩写不得违规');
      check(violatesLanguage('apps/admin-api/src/main.ts 不存在') === false, '路径不得违规');
    },
  });

  cases.push({
    name: 'A3 判据一回归钉：纯英文句子违规 / 纯品牌名合规 / 空值合规',
    fn: () => {
      check(violatesLanguage('Executor not found') === true, '纯英文句子应违规');
      check(violatesLanguage('AutoCodeFlow') === false, '品牌名不得违规');
      check(violatesLanguage('Python') === false, 'Python 不得违规');
      check(violatesLanguage('10.0.0.9:3002') === false, '主机:端口不得违规');
      check(violatesLanguage('AUTOFLOW_EXECUTOR_ADDRESS') === false, 'env 名不得违规');
      check(violatesLanguage('') === false, '空串不得违规');
      check(violatesLanguage(undefined) === false, 'undefined 不得违规');
      check(violatesLanguage('Alertmanager v2 webhook body') === true, 'Webhook 不是全局豁免词');
    },
  });

  cases.push({
    name: 'A4 采集面 B：注释里的 throw 引用不算，真实抛点算',
    fn: () => {
      check(
        collectThrownMessages(
          '// 旧实现：throw new Error("Cannot 删除 任务")\nthrow new Error("参数校验失败 Please retry");',
        ).length === 1,
        '注释里的引用不得计入（否则逼人删溯源注释或灌基线）',
      );
      check(
        collectThrownMessages('throw new BadRequestException("任务「x」不存在 (Task not found)")')
          .length === 1,
        '真实抛点必须采到',
      );
    },
  });

  cases.push({
    name: 'A5 采集面 C：python `detail=` 与 `raise`；库面只判「中文里残留英文」',
    fn: () => {
      check(
        collectPythonMessages("raise HTTPException(status_code=400, detail='Failed to 保存')")
          .length === 1,
        'detail= 必须采到（首版只认 raise）',
      );
      check(
        collectPythonMessages("raise HTTPException(status_code=400, detail='配置无效')").length === 0,
        '中文 detail 不得采',
      );
      check(
        collectPythonMessages('raise ValueError("Failed to 读取 watermark 配置")').length === 1,
        'raise 里的半英半中必须采到',
      );
      check(
        collectPythonMessages('raise ValueError("Connection refused")', { library: true }).length === 0,
        '库面（packages/**）纯英文异常是惯例，不得计入',
      );
      check(
        collectPythonMessages('raise ValueError("连接失败 Connection refused")', { library: true })
          .length === 1,
        '库面的中文串里残留英文仍必须计入',
      );
    },
  });

  cases.push({
    name: 'A6 采集面 B2：码表 zh 采、en 不采',
    fn: () => {
      const catalogSrc = `
        export const X_CODES = {
          A_B: { status: 400, zh: "任务「{{name}}」已存在 (Task exists)", en: "Task exists" },
          C_D: { status: 400, zh: "参数校验失败", en: "Validation failed" },
        } as const;
      `;
      check(collectCatalogZh(catalogSrc).length === 1, 'zh 里的半英半中必须采到，en 不得计入');
    },
  });

  cases.push({
    name: 'A7 采集面 D：JSX 文本 / title / message 采到；code 样例与 t() 不采',
    fn: () => {
      const webSrc = `
        export function A({ t }) {
          return (
            <div>
              <Button title="Delete task">Save changes</Button>
              <Text code>npm login</Text>
              <Text>{t('page.save')}</Text>
              <Input placeholder="请输入任务名" />
            </div>
          );
        }
      `;
      const hits = collectWebCopy(webSrc).map((h) => h.text);
      check(hits.includes('Delete task'), 'title 硬编码英文必须采到');
      check(hits.includes('Save changes'), 'JSX 文本必须采到');
      check(!hits.some((x) => x.includes('npm login')), '<Text code> 代码样例不得采');
      check(!hits.some((x) => x.includes('请输入')), '中文 placeholder 不得采');
      check(hits.length === 2, `命中数应为 2（实际 ${hits.length}: ${JSON.stringify(hits)}）`);
      check(collectWebCopy('message.error("Save failed")').length === 1, 'message.error 必须采到');
    },
  });

  cases.push({
    name: 'A8 采集面 A：schema / parameters / responses 的英文都命中，中文不误报',
    fn: () => {
      const spec = {
        components: {
          schemas: {
            S: {
              properties: {
                a: { description: '执行器不存在' },
                b: { description: 'Task not found' },
              },
            },
          },
        },
        paths: {
          '/x': {
            get: {
              summary: '列表',
              parameters: [{ name: 'p', description: 'Task not found' }],
              responses: { 200: { description: '成功' }, 404: { description: 'Task not found' } },
            },
          },
        },
      };
      const got = collectOpenApi(spec);
      check(got.length === 3, `应命中 3 处（实际 ${got.length}: ${got.map((x) => x.kind)}）`);
    },
  });

  cases.push({
    name: 'A9 棘轮裁决：基线内绿 / 新增红 / 修好没删红 / 登记超上限红',
    fn: () => {
      const items = [
        { kind: 'throw', key: 'a.ts', text: '保存失败 Please retry', line: 3 },
        { kind: 'throw', key: 'b.ts', text: '中文文案', line: 9 },
      ];
      const okBaseline = { known: items.map(itemKey), maxKnown: 2 };
      check(evaluateBaseline({ items, baseline: okBaseline }).code === 0, '基线内应 code 0');
      const added = evaluateBaseline({ items, baseline: { known: [itemKey(items[0])], maxKnown: 1 } });
      check(added.code === 1 && added.added[0].includes('b.ts'), '新增必须红且点名');
      const fixed = evaluateBaseline({ items: [items[0]], baseline: okBaseline });
      check(fixed.code === 1 && fixed.fixed[0].includes('b.ts'), '修好没删必须红且点名 fixed');
      const cap = evaluateBaseline({ items, baseline: { known: items.map(itemKey), maxKnown: 1 } });
      check(cap.code === 1 && cap.capExceeded === true, '登记超上限必须红');
    },
  });

  cases.push({
    name: 'A10 run() 把棘轮结论交成退出码（不是只打印）',
    fn: () => {
      const repo = makeFixtureRepo({ [SPEC]: SPEC_JSON }, { prefix: 'lang-run-' });
      try {
        const items = [{ kind: 'throw', key: 'a.ts', text: '保存失败 Please retry', line: 1 }];
        check(
          run({ root: repo.dir, items, baseline: { known: [itemKey(items[0])], maxKnown: 1 }, quiet: true }) === 0,
          '全部在基线内应 return 0',
        );
        check(
          run({ root: repo.dir, items, baseline: { known: [], maxKnown: 0 }, quiet: true }) === 1,
          '新增欠账应 return 1',
        );
      } finally {
        repo.cleanup();
      }
    },
  });

  // ── B. 闸门（真子进程 + 退出码 + 关键文本）─────────────────────────────────
  const subprocess = (name, files, expect, args = []) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: 'lang-selftest-' });
        try {
          expectExit(runGuard(SELF, { args: ['--root', repo.dir, ...args] }), {
            ...expect,
            withinMs: 1000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocess(
    'B1 基线内全绿 → 退出 0（棘轮的正例控制组）',
    tree({ files: { [SRC_BAD]: BAD_THROW }, baseline: baselineOf([KNOWN_BAD]) }),
    {
      code: 0,
      contains: ['LANG-ZH-01 通过', '欠账 1 处', '全部在基线内'],
      absent: ['结构错误', '新增'],
    },
  );

  subprocess(
    'B2 【反证·只数条数】同一文件两处违规、基线只登记一处 → 红，且只报「新增 1 处」',
    tree({
      files: { [SRC_BAD]: BAD_THROW + BAD_THROW_2 },
      baseline: baselineOf([KNOWN_BAD]),
    }),
    {
      code: 1,
      contains: ['新增 1 处', 'Download timed out', 'bad.ts'],
      absent: ['LANG-ZH-01 通过', '结构错误'],
    },
  );

  subprocess(
    'B3 基线陈旧（已中文化但条目没删）→ 红，点名 fixed 并给出 --update 处置',
    tree({
      files: { [SRC_BAD]: GOOD_THROW, [SRC_KEEP]: BAD_THROW_2 },
      baseline: baselineOf([KNOWN_BAD, KNOWN_KEEP]),
    }),
    {
      code: 1,
      contains: ['基线陈旧', '不再命中', '登记代替修复', '--update'],
      absent: ['LANG-ZH-01 通过'],
    },
  );

  subprocess(
    'B4 登记项超过 maxKnown（登记代替修复）→ 红',
    tree({
      files: { [SRC_BAD]: BAD_THROW, [SRC_KEEP]: BAD_THROW_2 },
      baseline: baselineOf([KNOWN_BAD, KNOWN_KEEP], 1),
    }),
    {
      code: 1,
      contains: ['基线登记项增长', '棘轮只许收紧不许放松'],
      absent: ['LANG-ZH-01 通过', '基线陈旧'],
    },
  );

  subprocess(
    'B5 基线文件缺失 → 结构红（不是「一处欠账都没有」）',
    tree({ files: { [SRC_BAD]: BAD_THROW } }),
    {
      code: 1,
      contains: ['结构错误', '事实源缺失', 'scripts/user-facing-language-baseline.json'],
      absent: ['LANG-ZH-01 通过'],
    },
  );

  subprocess(
    'B6 【反证·`--report` 吞结构错】openapi.json 缺失 → 结构红（旧实现无条件 exit 0）',
    tree({ files: { [SRC_BAD]: BAD_THROW }, baseline: baselineOf([KNOWN_BAD]), omitSpec: true }),
    {
      code: 1,
      contains: ['结构错误', '事实源缺失：apps/admin-api/openapi.json'],
      absent: ['LANG-ZH-01 报告', 'LANG-ZH-01 通过', 'ENOENT'],
    },
    ['--report'],
  );

  {
    const name = 'B7 [反证] `--update` 想把基线放松 → 拒绝写入，且磁盘上的基线一字未改';
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(
          tree({ files: { [SRC_BAD]: BAD_THROW }, baseline: baselineOf([]) }),
          { prefix: 'lang-update-' },
        );
        try {
          const before = readBaseline(repo.dir);
          expectExit(runGuard(SELF, { args: ['--root', repo.dir, '--update'] }), {
            code: 1,
            contains: ['拒绝写入', '棘轮只允许收紧'],
            absent: ['基线已写入'],
            withinMs: 1000,
            label: name,
          });
          const after = readBaseline(repo.dir);
          check(
            JSON.stringify(after) === JSON.stringify(before),
            `拒绝写入时基线必须一字未改（before=${JSON.stringify(before)} after=${JSON.stringify(after)}）`,
          );
        } finally {
          repo.cleanup();
        }
      },
    });
  }

  {
    const name = 'B8 [反证] `--update` 收紧后：磁盘基线变 1 条，再跑守卫真的绿';
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(
          tree({
            files: { [SRC_BAD]: BAD_THROW },
            baseline: baselineOf([KNOWN_BAD, KNOWN_KEEP]),
          }),
          { prefix: 'lang-update2-' },
        );
        try {
          expectExit(runGuard(SELF, { args: ['--root', repo.dir, '--update'] }), {
            code: 0,
            contains: ['基线已写入', '1 条（旧 2 条）'],
            withinMs: 1000,
            label: name,
          });
          const after = readBaseline(repo.dir);
          check(after.known.length === 1, `收紧后基线应只剩 1 条（实际 ${after.known.length}）`);
          check(after.maxKnown === 1, `maxKnown 必须跟着收紧（实际 ${after.maxKnown}）`);
          expectExit(runGuard(SELF, { args: ['--root', repo.dir] }), {
            code: 0,
            contains: ['LANG-ZH-01 通过', '上限 1'],
            withinMs: 1000,
            label: name + '（收紧后再跑）',
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  }

  subprocess(
    'B9 [反证·注释算数] 注释里的英文 throw 引用不算欠账 → 绿（不逼人删溯源注释）',
    tree({
      files: { [SRC_BAD]: COMMENTED_THROW + BAD_THROW },
      baseline: baselineOf([KNOWN_BAD]),
    }),
    {
      code: 0,
      contains: ['LANG-ZH-01 通过', '欠账 1 处'],
      absent: ['新增', '结构错误'],
    },
  );

  subprocess(
    'B10 `--report` 正常出明细（file:line + 分类计数）→ 退出 0',
    tree({ files: { [SRC_BAD]: BAD_THROW }, baseline: baselineOf([KNOWN_BAD]) }),
    {
      code: 0,
      contains: ['LANG-ZH-01 报告', '面向用户语言欠账共 1 处', 'throw: 1', '明细'],
      absent: ['结构错误'],
    },
    ['--report'],
  );

  subprocess(
    'B11 [反证·扫描面为空] 一处都没扫到 + 空基线 → 结构红（0 命中不是「干净」）',
    tree({ files: { [SRC_BAD]: GOOD_THROW }, baseline: baselineOf([]) }),
    {
      code: 1,
      contains: ['结构错误', '扫描面为空'],
      absent: ['LANG-ZH-01 通过'],
    },
  );

  subprocess(
    'B12 [反证·前缀误配] `DELETE` 是 HTTP 方法，不得吞掉散文动词 `Delete task`',
    tree({ files: { [PAGE_BAD]: PAGE_DELETE }, baseline: baselineOf([]) }),
    {
      code: 1,
      contains: ['新增 1 处', 'Delete task'],
      absent: ['LANG-ZH-01 通过'],
    },
  );

  {
    const name = 'B13 [反证] `--update` 在扫描面为空时拒绝写盘（否则从此永远绿）';
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(tree({ files: { [SRC_BAD]: GOOD_THROW } }), {
          prefix: 'lang-update3-',
        });
        try {
          expectExit(runGuard(SELF, { args: ['--root', repo.dir, '--update'] }), {
            code: 1,
            contains: ['拒绝写入', '扫描面为空'],
            withinMs: 1000,
            label: name,
          });
          check(
            !fs.existsSync(path.join(repo.dir, BASELINE)),
            '拒绝写入时不得创建基线文件（空基线 = 永远绿）',
          );
        } finally {
          repo.cleanup();
        }
      },
    });
  }

  subprocess(
    'B14 `--update --force` 明确放行新增采集面（唯一的放松通道）→ 退出 0',
    tree({ files: { [SRC_BAD]: BAD_THROW }, baseline: baselineOf([]) }),
    { code: 0, contains: ['基线已写入', '1 条（旧 0 条）'], absent: ['拒绝写入'] },
    ['--update', '--force'],
  );

  const failed = reportCases(cases, { title: 'check-user-facing-language selftest' });
  if (failed > 0) process.exit(1);
}

// ⚠️ **主模块守卫**：只有被直接执行时才跑 CLI。
//
// 为什么必须加：本文件导出 `collectOpenApi` / `hasSubstantiveEnglish` 等判据，
// 供 selftest 与排障时**单独调用**。首版没有守卫，于是 `import` 本模块会**立刻
// 执行守卫并 process.exit** —— 探针脚本永远只打印一行"✔ 通过"就退出，看不到
// 任何判据内部状态（实测排查 `requestBody` 盲区时被这个坑误导了一轮：
// 探针报"通过"，却无法判断是"判据没扫到"还是"扫到了但没判违规"）。
// 用 `pathToFileURL` 比较而非字符串拼接，避免 Windows 盘符/大小写差异误判。
function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const rootArg = argValue(argv, '--root');
  const cliRoot = rootArg ? path.resolve(rootArg) : DEFAULT_ROOT;
  let code = 0;
  if (argv.includes('--selftest')) code = selftest();
  else if (argv.includes('--update')) code = update({ root: cliRoot, force: argv.includes('--force') });
  else code = run({ root: cliRoot, report: argv.includes('--report') });
  process.exit(code);
}
