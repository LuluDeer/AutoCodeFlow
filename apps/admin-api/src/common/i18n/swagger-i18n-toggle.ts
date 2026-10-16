/**
 * API 文档双语（API-I18N）· Swagger UI 的语言开关。
 *
 * ## 背景：为什么开关要注入到 Swagger UI 里，而不是另做一个页面
 *
 * `openapi.json` 是**入库的生成物**（`npm run swagger:export`），英文由
 * `scripts/api-i18n/inject-openapi-en.mjs` 以 `x-i18n-en` 扩展键注入
 * （为什么不用内联装饰器，见该脚本头注的长说明：`@nestjs/swagger` 的 options
 * 类型是 type 别名，无法模块增强，内联会触发 1318 处 TS2353）。
 *
 * 于是运行时的**唯一读者**是 `/api/docs` 上的 Swagger UI。两种语言都已在文档里
 * （中文在 `description`/`summary`，英文在 `x-i18n-en`），差的只是**让读者选**。
 * 另做页面会把"文档"和"接口"分成两个真相源，必然漂移；注入到 Swagger UI 则
 * 零新增路由、零重复渲染逻辑。
 *
 * ## 做法：DOM 层的文本替换（而非改 Swagger UI 的渲染管线）
 *
 * VitePress/Swagger UI 都没有"按 key 取文案"的口子：`x-i18n-en` 是**自定义扩展键**，
 * Swagger UI 的内置渲染器不认识它（它会把 `x-i18n-en` 当普通扩展字段展示）。
 * 所以开关的实现是：
 *   1. 启动时把文档里所有「中文 → 英文」的对应关系**提取成一张映射**，
 *      连同每个文本所在的 DOM 定位（靠"当前显示的文本内容"反查）注入页面；
 *   2. 切换语言时遍历文档 DOM 的文本节点，把命中的中文替换成英文（反之亦然），
 *      并把原值记在 `data-acf-i18n-zh` 上以便切回。
 *
 * 为什么"按文本内容反查"是可接受的：中文原文在文档里是**唯一键**（映射表就是以它
 * 为键生成的，实测 1278 条；同文案共用一条英文）。Swagger UI 渲染出的文本节点就是
 * 这些原文本身或其中一段，故内容匹配是**充分**的。反过来，用 CSS 选择器定位每个
 * 字段（`#operations-... .opblock-summary-description`）会与 Swagger UI 的内部
 * 结构强耦合——它一升级就全断，且不同 Swagger UI 版本类名不同。
 *
 * ## 边界（刻意不做的事）
 *
 * · **不改 `description` 本身**：只改 DOM。故"复制 curl / 下载 JSON"拿到的仍是
 *   原始文档（中文 description + `x-i18n-en`），行为可预期、不与生成物打架；
 * · **不翻译非文案节点**：只替换命中映射表的字符串，参数名/枚举值/代码块一律不动
 *   （机器标识符译了就错——与 LANG-ZH-01 的纪律一致）；
 * · **不持久化到 localStorage**：Swagger UI 是内部调试页，刷新回到默认（中文，
 *   即产品默认语言）比"上次切到英文导致下次打开全是英文、排查时对不上别人的截图"
 *   更可预期。若将来要持久化，加一行即可，但需先确认这个取舍。
 */

/** 英文扩展键名（与 `api-i18n.ts` 的 `I18N_EN_KEY` 同值，见那边的"两处书写"说明）。 */
export const X_I18N_EN = "x-i18n-en";

/** 记在 DOM 上的"原始中文"属性名，供切回中文时还原。 */
export const ZH_ATTR = "data-acf-i18n-zh";

export interface I18nEntry {
  /** 节点在文档里的路径（仅用于诊断，不参与替换）。 */
  path: string;
  zh: string;
  en: string;
}

/**
 * 从 OpenAPI 文档里提取全部「中文 → 英文」对。
 *
 * 覆盖与注入脚本**同一批**位置（schema 属性 / operation summary+description /
 * param / requestBody / responses），否则会出现"注入了但开关找不到"的单侧失效。
 * 同一中文文案只保留一条（文档里重复出现很常见；共用一条英文是设计使然）。
 */
export function collectEntries(doc: unknown): I18nEntry[] {
  const out = new Map<string, I18nEntry>();
  const walk = (node: unknown, path: string): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    const obj = node as Record<string, unknown>;
    const ext = obj[X_I18N_EN];
    if (typeof ext === "string" && typeof obj.description === "string") {
      if (!out.has(obj.description)) {
        out.set(obj.description, { path, zh: obj.description, en: ext });
      }
    } else if (ext && typeof ext === "object") {
      const e = ext as Record<string, unknown>;
      // operation 面：summary / description 各自成对
      for (const field of ["summary", "description"] as const) {
        const zh = obj[field];
        const en = e[field];
        if (typeof zh === "string" && typeof en === "string" && !out.has(zh)) {
          out.set(zh, { path, zh, en });
        }
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k === X_I18N_EN) continue;
      walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(doc, "");
  return [...out.values()];
}

/**
 * 生成注入到 Swagger UI 页面的自包含脚本。
 *
 * 为什么是**字符串**而不是一个静态 .js 文件：Swagger UI 由 `SwaggerModule.setup`
 * 挂载，本仓没有配静态资源目录；塞一个字符串进 `customJs` 是零新增基建的做法
 * （也不需要处理打包与路径前缀）。代价是这段脚本无法被 TS 直接检查——故它的
 * **纯函数部分**（`collectEntries`）留在本文件里由单测覆盖，字符串里只留 DOM 操作。
 */
export function buildSwaggerI18nScript(entries: I18nEntry[]): string {
  const payload = JSON.stringify(
    entries.map((e) => [e.zh, e.en] satisfies [string, string]),
  );
  return `
(function () {
  var PAIRS = ${payload};
  var ZH_ATTR = ${JSON.stringify(ZH_ATTR)};
  // 长键优先：短文案若是长文案的子串，先替换短串会把长串切碎、导致长串再也匹配不上。
  PAIRS.sort(function (a, b) { return b[0].length - a[0].length; });
  var EN2ZH = {};
  PAIRS.forEach(function (p) { EN2ZH[p[1]] = p[0]; });
  var lang = 'zh';

  function textNodes(root) {
    var out = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      // 跳过脚本/样式与代码块：代码块里是示例，不应被文案替换（可能与原文重合）
      var p = n.parentNode;
      if (!p) continue;
      var tag = (p.nodeName || '').toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CODE' || tag === 'PRE') continue;
      out.push(n);
    }
    return out;
  }

  function findPair(text) {
    // 精确匹配优先（绝大多数节点就是整条文案）
    for (var i = 0; i < PAIRS.length; i++) if (PAIRS[i][0] === text) return PAIRS[i];
    return null;
  }

  function toEn() {
    textNodes(document.body).forEach(function (n) {
      var v = n.nodeValue;
      if (!v) return;
      var pair = findPair(v.trim());
      if (pair) {
        n.parentNode.setAttribute(ZH_ATTR, v);
        n.nodeValue = v.replace(pair[0], pair[1]);
        return;
      }
      // 部分匹配：整条文案被 Markdown 拆成多段时（如带 ** 强调），逐段替换
      for (var i = 0; i < PAIRS.length; i++) {
        if (PAIRS[i][0].length >= 4 && v.indexOf(PAIRS[i][0]) !== -1) {
          n.parentNode.setAttribute(ZH_ATTR, v);
          n.nodeValue = v.split(PAIRS[i][0]).join(PAIRS[i][1]);
          return;
        }
      }
    });
  }

  function toZh() {
    textNodes(document.body).forEach(function (n) {
      var p = n.parentNode;
      if (!p || !p.hasAttribute || !p.hasAttribute(ZH_ATTR)) return;
      n.nodeValue = p.getAttribute(ZH_ATTR);
      p.removeAttribute(ZH_ATTR);
    });
  }

  function apply() { if (lang === 'en') { toEn(); } else { toZh(); } }

  function mount() {
    var bar = document.querySelector('.swagger-ui .topbar .wrapper');
    if (!bar || document.getElementById('acf-lang-toggle')) return;
    var box = document.createElement('div');
    box.id = 'acf-lang-toggle';
    box.style.cssText = 'float:right;padding:8px 12px;font-size:13px';
    var label = document.createElement('span');
    label.textContent = '文档语言 / Docs: ';
    label.style.cssText = 'color:#fff;margin-right:6px';
    box.appendChild(label);
    [['zh', '中文'], ['en', 'English']].forEach(function (opt) {
      var b = document.createElement('button');
      b.textContent = opt[1];
      b.setAttribute('data-lang', opt[0]);
      b.style.cssText =
        'margin-right:4px;padding:2px 10px;border-radius:3px;border:1px solid #fff;cursor:pointer;' +
        (opt[0] === lang ? 'background:#fff;color:#1b1b1b;' : 'background:transparent;color:#fff;');
      b.onclick = function () {
        if (lang === opt[0]) return;
        if (lang === 'en') toZh();
        lang = opt[0];
        apply();
        box.querySelectorAll('button').forEach(function (x) {
          var on = x.getAttribute('data-lang') === lang;
          x.style.background = on ? '#fff' : 'transparent';
          x.style.color = on ? '#1b1b1b' : '#fff';
        });
      };
      box.appendChild(b);
    });
    bar.appendChild(box);
  }

  // Swagger UI 是异步渲染的：等它把内容挂上再装开关。
  var tries = 0;
  var timer = setInterval(function () {
    mount();
    if (document.getElementById('acf-lang-toggle') || ++tries > 100) clearInterval(timer);
  }, 100);
})();
`;
}
