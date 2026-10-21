#!/usr/bin/env node
/**
 * API 文档双语（API-I18N）：把英文注入 `openapi.json` 的 `x-i18n-en` 扩展键。
 *
 * ## 为什么不把英文内联写在装饰器里（**这是本设计的关键取舍，别改回去**）
 *
 * 第一版把英文内联进每个 `@ApiProperty`/`@ApiOperation` 的 options：
 * `{ description: "中文", "x-i18n-en": "English" }`。它**能编译不过**——因为
 * `@nestjs/swagger` 的 options 类型里没有这个键，触发 TypeScript 的**多余属性
 * 检查**（`TS2353`）。实测全仓 **1318 处**报错（`ApiPropertyOptions` 634、
 * `ApiResponseOptions` 142、`ApiResponseNoStatusOptions` 77、`ApiParamOptions` 63、
 * `ApiQueryOptions` 27、`ApiBodyOptions` 21、`ApiHeaderOptions` 1）。
 *
 * 想用 `declare module` 增强这些类型也不行——它们**大多是 type 别名**
 * （`type ApiPropertyOptions = A | (A & {…})`）。对别名写同名 `interface`
 * **不会合并**，只会新建同名标识符并报 `TS2300: Duplicate identifier`
 * （实测：1318 → 1323，多出的 5 条正是重复标识符，而键**依然**不被接受）。
 * 能增强的只有 `ApiHeaderOptions` / `ApiResponseCommonMetadata` 两个导出接口；
 * `@ApiParam` / `@ApiQuery` / `@ApiBody` 的 metadata 是别名或未导出接口，
 * **在库的类型设计上就封死了**。
 *
 * 剩下的出路只有两条，都不可接受：给全仓数百个调用点加 `as` 断言（丢类型安全、
 * 噪声巨大），或者与库的类型定义搏斗。
 *
 * ## 本设计：源码零改动，导出期注入
 *
 *   · 源码里**只写中文**（保持现状，一个字都不用改）；
 *   · 英文集中在 `data/openapi-en-map.json`，**以中文原文为键**；
 *   · `swagger:export` 之后跑本脚本，把 `x-i18n-en` 注入生成物。
 *
 * 收益：
 *   1. **零类型摩擦**——不碰任何装饰器，`tsc` 不可能因此报错；
 *   2. **重复文案自动共用一条英文**（以中文为键，去重是免费的）——
 *      实测 974 条中文对应 1258 条映射，天然对齐；
 *   3. 新增中文文案若没配英文 ⇒ 本脚本**如实报缺**（见 `--check`），
 *      门禁有牙，不会静默积累中文单语条目；
 *   4. 生成物里依然是「中英同行携带」，文档站消费方式不变（读 `x-i18n-en`）。
 *
 * ## 注入位置
 *
 *   · schema 属性（`components.schemas.*.properties.*.description`）→ `x-i18n-en: "<英文>"`
 *   · operation（`paths.*.*.summary` / `.description`）→
 *     `x-i18n-en: { summary?, description? }`
 *   · `parameters[].description` / `requestBody.description` / `responses.*.description`
 *     → `x-i18n-en: "<英文>"`（与属性同形态）
 *
 * ## 用法
 *   node scripts/api-i18n/inject-openapi-en.mjs            # 注入（就地改写生成物）
 *   node scripts/api-i18n/inject-openapi-en.mjs --check    # 只报缺，不改文件（门禁用）
 *   node scripts/api-i18n/inject-openapi-en.mjs --selftest # 验判据本身
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const OPENAPI = path.join(root, "apps/admin-api/openapi.json");
const MAP = path.join(here, "data/openapi-en-map.json");

/** 含中日韩字符即视为"需要英文的中文文案"。 */
const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/** 读取映射表（中文原文 → 英文）。 */
export function readMap() {
  if (!fs.existsSync(MAP)) {
    throw new Error(`缺英文映射表：${path.relative(root, MAP)}`);
  }
  const m = JSON.parse(fs.readFileSync(MAP, "utf8"));
  if (typeof m !== "object" || m === null || Array.isArray(m)) {
    throw new Error("英文映射表必须是 { 中文: 英文 } 对象");
  }
  return m;
}

/**
 * 递归下钻**内联对象**的属性描述。
 *
 * `components.schemas.<name>.properties.*.description` 只覆盖一层；实测存在
 * 「属性本身还是个内联对象」的写法（如 `ExecutorMetricsDto.current.reservedSlots`），
 * 以及 `requestBody.content.*.schema` 里的内联对象（如
 * `/executor-packages/{id}/push` 的 `executorIds`）。这些节点以前**根本不进收集面**，
 * 于是「有中文、映射表里也有英文，却永远是中文单语」——差集实测 4 个（第 5 个在
 * `example` 载荷里，见下）。
 *
 * ⚠️ 只顺着 schema 的**结构**键下钻（properties / items / allOf|oneOf|anyOf /
 * additionalProperties），**绝不**进 `example` / `examples` / `default` / `enum`：
 * 那些是样例**载荷数据**，往里面塞 `x-i18n-en` 会污染示例本身。
 */
function collectInlineProps(schema, push, depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  if (depth > 8) return; // 防递归爆炸（本仓实测最深 3 层）
  for (const key of ["properties", "patternProperties"]) {
    const props = schema[key];
    if (!props || typeof props !== "object" || Array.isArray(props)) continue;
    for (const prop of Object.values(props)) {
      if (!prop || typeof prop !== "object" || Array.isArray(prop)) continue;
      if (typeof prop.description === "string") push(prop, "value", "description");
      collectInlineProps(prop, push, depth + 1);
    }
  }
  if (schema.items && typeof schema.items === "object") collectInlineProps(schema.items, push, depth + 1);
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    const arr = schema[key];
    if (Array.isArray(arr)) for (const sub of arr) collectInlineProps(sub, push, depth + 1);
  }
  const ap = schema.additionalProperties;
  if (ap && typeof ap === "object") collectInlineProps(ap, push, depth + 1);
}

/** 遍历一个 OpenAPI 文档，收集所有"需要英文"的节点与其装载方式。 */
export function collectTargets(doc) {
  const targets = [];
  const push = (node, kind, field) =>
    targets.push({ node, kind, field, text: node[field] });

  const schemas = doc?.components?.schemas ?? {};
  for (const schema of Object.values(schemas)) {
    // 顶层 properties 由此函数的首层循环覆盖，内联对象由递归覆盖（顺序与旧版一致）
    collectInlineProps(schema, push);
  }

  /**
   * 扫 operation 的**下级容器**（参数/请求体/响应）。
   *
   * ⚠️ 刻意**不**扫 `obj.description` 自身：operation 自己的 description 要以
   * 对象形态 `{ description }` 与 summary 共存，若这里也当成 value 面收一遍，
   * 同一个 `x-i18n-en` 会被"先写对象、再写裸字符串"覆盖掉（selftest 的
   * "operation 面注入对象 description" 正是抓的这个）。operation 自身的
   * summary/description 由调用处显式收集。
   */
  const scanOpChildren = (obj) => {
    for (const p of obj?.parameters ?? []) {
      if (typeof p?.description === "string") push(p, "value", "description");
    }
    const rb = obj?.requestBody;
    if (typeof rb?.description === "string") push(rb, "value", "description");
    // requestBody 的内联 JSON schema 也带属性描述（以前漏收）
    for (const media of Object.values(rb?.content ?? {})) {
      if (media && typeof media === "object") collectInlineProps(media.schema, push);
    }
    for (const r of Object.values(obj?.responses ?? {})) {
      if (typeof r?.description === "string") push(r, "value", "description");
    }
  };

  // ⚠️ `scanOpLike(item)` **不能**对 path item 调用：OpenAPI 的 path item 与
  // operation 不同层，但 `{...item}` 里直接就有 `summary`/`description` 键时
  // （path 级 summary），会被当成 value 面写成裸字符串；而 operation 自己的
  // summary 需要对象形态 `{ summary }`。两者撞在同一个 `x-i18n-en` 上就会
  // 互相覆盖（selftest 的 "operation 面注入对象 summary" 正是这样抓出来的）。
  // 故 path 级只扫它**独有的**容器：parameters。
  for (const item of Object.values(doc?.paths ?? {})) {
    for (const p of item?.parameters ?? []) {
      if (typeof p?.description === "string") push(p, "value", "description");
    }
    for (const op of Object.values(item ?? {})) {
      if (!op || typeof op !== "object" || Array.isArray(op)) continue;
      // operation 自身的 summary/description
      if (typeof op.summary === "string") push(op, "summary", "summary");
      if (typeof op.description === "string")
        push(op, "description", "description");
      scanOpChildren(op);
    }
  }
  return targets;
}

/** 给一个节点写入英文（按形态合并，不覆盖已有键）。 */
export function writeTarget({ node, kind, field }, en) {
  if (kind === "value") {
    node["x-i18n-en"] = en;
    return;
  }
  const cur = node["x-i18n-en"];
  const obj = cur && typeof cur === "object" ? cur : {};
  obj[kind] = en;
  node["x-i18n-en"] = obj;
}

/** 主流程：返回 { injected, missing }。`apply=false` 时不改内存里的文档。 */
export function inject(doc, map, { apply = true } = {}) {
  const targets = collectTargets(doc);
  const missing = new Map();
  let injected = 0;
  let already = 0;
  // 三类计数分开记（R31-D2 复查发现的口径缺陷）：total 把「空描述」也算成
  // 「可翻译节点」，于是输出「1614 个可翻译节点全部有英文」——其中 99 个根本没有
  // 文本可翻。报数口径夸大 = 让读者以为覆盖面比实际更大，是门禁最不该有的形态。
  let empty = 0;
  let alreadyEnglish = 0;
  let translatable = 0;
  for (const t of targets) {
    const text = t.text;
    if (typeof text !== "string" || !text.trim()) {
      empty++;
      continue;
    }
    // 已经是英文（无 CJK）→ 无需双语：它就是英文读者的那份
    if (!CJK.test(text)) {
      alreadyEnglish++;
      continue;
    }
    translatable++;
    const en = map[text];
    if (typeof en !== "string" || !en.trim()) {
      if (!missing.has(text)) missing.set(text, []);
      missing.get(text).push(`${t.node?.operationId ?? ""}`.trim() || "(schema)");
      continue;
    }
    if (apply) {
      const had =
        t.kind === "value"
          ? node_has(t.node, "x-i18n-en")
          : t.node["x-i18n-en"]?.[t.kind] !== undefined;
      writeTarget(t, en);
      if (had) already++;
      else injected++;
    } else {
      injected++;
    }
  }
  return {
    injected,
    already,
    missing,
    total: targets.length,
    translatable,
    empty,
    alreadyEnglish,
  };
}

function node_has(node, key) {
  return Object.prototype.hasOwnProperty.call(node, key);
}

/**
 * **收集面下界（只增不减的地板）**。
 *
 * 为什么需要它：本闸此前唯一的判据是「收集到的中文节点是否都有英文」，而
 * **收集不到 = 永远绿**。R31-D2 就此实测到真实缺口——内联对象的嵌套 properties
 * 与 requestBody 内联 schema 从未进收集面，4 个节点有中文、映射表里也有英文，
 * 却始终是中文单语，而门禁一路绿。换句话说：这道闸只能防「有中文没英文」，
 * 防不住「压根没被看见」。
 *
 * 地板把「悄悄少收一批节点」从**静默单语化**变成**CI 红**：任何重构如果让收集面
 * 收缩到 1500 个以下，先红再谈。上探方式：收集面扩大后把本常量一起调高（棘轮）。
 */
const MIN_TRANSLATABLE_NODES = 1500;

/**
 * 映射表里**在文档中找不到**的条目（疑似死条目）。只报告、不失败：
 * 同一条文可能被 docs-site 或历史版本消费，贸然删除会让别人的构建缺英文。
 */
function deadMapEntries(doc, map) {
  const seen = new Set();
  for (const t of collectTargets(doc)) {
    if (typeof t.text === "string" && t.text.trim()) seen.add(t.text);
  }
  return Object.keys(map).filter((zh) => !seen.has(zh));
}

// ───────────────────────── CLI ─────────────────────────

function run() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const map = readMap();
  const doc = JSON.parse(fs.readFileSync(OPENAPI, "utf8"));
  const res = inject(doc, map, { apply: !check });

  if (res.missing.size > 0) {
    console.error(
      `✘ API-I18N 失败：${res.missing.size} 条中文文案缺英文（映射表 ${path.relative(root, MAP)}）`,
    );
    let i = 0;
    for (const [zh, where] of res.missing) {
      if (i++ >= 20) {
        console.error(`   … 其余 ${res.missing.size - 20} 条见 --report`);
        break;
      }
      console.error(`   · ${zh.slice(0, 90)}`);
      console.error(`     （出现在 ${where.slice(0, 3).join(", ")}）`);
    }
    console.error(
      `\n  处置：把英文补进 ${path.relative(root, MAP)}（键=中文原文），再跑本脚本。`,
    );
    return 1;
  }

  // 收集面棘轮：先于「注入成功」输出——收集面收缩时这里必须比任何"✔"更早红。
  if (res.translatable < MIN_TRANSLATABLE_NODES) {
    console.error(
      `✘ API-I18N 收集面收缩：只收集到 ${res.translatable} 个中文可翻译节点，` +
        `低于地板 ${MIN_TRANSLATABLE_NODES}。`,
    );
    console.error(
      `  历史上这类收缩不会报错，只会让相应文档**静默变回中文单语**（R31-D2 实测：` +
        `内联对象的嵌套 properties 与 requestBody 内联 schema 从未进收集面，4 个节点因此永久单语）。`,
    );
    console.error(
      `  处置：检查 collectTargets / collectInlineProps 是否漏掉某个子树；确属合理收缩才调低该常量，并在提交信息里写清理由。`,
    );
    return 1;
  }

  const dead = argv.includes("--report") ? deadMapEntries(doc, map) : [];

  if (!check) {
    fs.writeFileSync(OPENAPI, JSON.stringify(doc, null, 2) + "\n", "utf8");
    console.log(
      `✔ API-I18N 已注入 ${res.injected} 处 x-i18n-en（覆盖 ${res.translatable} 个中文可翻译节点；` +
        `另有 ${res.alreadyEnglish} 个纯英文、${res.empty} 个空描述不计入）。`,
    );
  } else {
    console.log(
      `✔ API-I18N 检查通过：${res.translatable} 个中文可翻译节点全部有英文` +
        `（纯英文 ${res.alreadyEnglish} 个、空描述 ${res.empty} 个不计入；映射表 ${Object.keys(map).length} 条` +
        `${dead.length ? `，其中 ${dead.length} 条在本文档中未出现（疑似死条目，见 --report）` : ""}）。`,
    );
  }
  if (dead.length) {
    console.log("\n映射表中未在本文档出现的条目（仅供参考，不据此删除）：");
    for (const zh of dead.slice(0, 30)) console.log(`  · ${zh.slice(0, 80)}`);
    if (dead.length > 30) console.log(`  … 其余 ${dead.length - 30} 条`);
  }
  return 0;
}

function selftest() {
  let fail = 0;
  const t = (name, cond) => {
    if (cond) console.log(`  ✔ ${name}`);
    else {
      fail++;
      console.error(`  ✘ ${name}`);
    }
  };
  console.log("API-I18N selftest:");

  const mk = () => ({
    components: {
      schemas: {
        A: { properties: { p: { description: "执行器不存在" } } },
      },
    },
    paths: {
      "/x": {
        get: {
          summary: "列出执行器",
          description: "返回全部执行器",
          parameters: [{ name: "q", description: "关键字" }],
          responses: { "200": { description: "成功" } },
        },
      },
    },
  });

  // 判据：CJK 判定
  t("识别中文文案", CJK.test("执行器不存在"));
  t("英文不算待翻译", !CJK.test("Executor not found"));

  // 收集面
  const targets = collectTargets(mk());
  t("收集到 schema 属性", targets.some((x) => x.kind === "value" && x.text === "执行器不存在"));
  t("收集到 operation summary", targets.some((x) => x.kind === "summary" && x.text === "列出执行器"));
  t("收集到 operation description", targets.some((x) => x.kind === "description" && x.text === "返回全部执行器"));
  t("收集到 parameter", targets.some((x) => x.text === "关键字"));
  t("收集到 response", targets.some((x) => x.text === "成功"));

  // 内联对象：嵌套 properties 与 requestBody 内联 schema 必须进收集面（否则永远中文单语）；
  // example 是**样例载荷**，里面的 description 是数据不是散文，必须**不**进收集面。
  const mkNested = () => ({
    components: {
      schemas: {
        B: {
          properties: {
            cur: { type: "object", properties: { nested: { description: "嵌套字段" } } },
            ex: { type: "object", example: { description: "样例值" } },
          },
        },
      },
    },
    paths: {
      "/y": {
        post: {
          requestBody: {
            description: "请求体",
            content: {
              "application/json": { schema: { properties: { ids: { description: "目标 ID" } } } },
            },
          },
          responses: { "200": { description: "成功" } },
        },
      },
    },
  });
  const tNested = collectTargets(mkNested());
  t("收集到嵌套内联属性", tNested.some((x) => x.text === "嵌套字段"));
  t("收集到 requestBody 内联 schema 属性", tNested.some((x) => x.text === "目标 ID"));
  t("不收集 example 载荷里的字段（它是数据不是散文）", !tNested.some((x) => x.text === "样例值"));
  const docNested = mkNested();
  const rNested = inject(docNested, { 嵌套字段: "Nested field", "目标 ID": "Target IDs", 请求体: "Request body", 成功: "OK" });
  t("嵌套面无缺失", rNested.missing.size === 0);
  t(
    "嵌套内联属性注入裸字符串",
    docNested.components.schemas.B.properties.cur.properties.nested["x-i18n-en"] === "Nested field",
  );

  // 注入形态：value 面是裸字符串，operation 面是对象
  const doc = mk();
  const map = {
    执行器不存在: "Executor not found",
    列出执行器: "List executors",
    返回全部执行器: "Return all executors",
    关键字: "Keyword",
    成功: "OK",
  };
  const r = inject(doc, map);
  t("无缺失", r.missing.size === 0);
  t("属性面注入裸字符串", doc.components.schemas.A.properties.p["x-i18n-en"] === "Executor not found");
  const op = doc.paths["/x"].get;
  t("operation 面注入对象 summary", op["x-i18n-en"]?.summary === "List executors");
  t("operation 面注入对象 description", op["x-i18n-en"]?.description === "Return all executors");
  t("参数面注入裸字符串", op.parameters[0]["x-i18n-en"] === "Keyword");
  t("响应面注入裸字符串", op.responses["200"]["x-i18n-en"] === "OK");

  // 缺英文必须被如实报出（否则门禁是永真的）
  const doc2 = mk();
  const r2 = inject(doc2, { 执行器不存在: "x" });
  t("缺英文被报出（门禁有牙）", r2.missing.size === 4);

  // 已是英文的文案不要求双语
  const doc3 = { components: { schemas: { A: { properties: { p: { description: "Already English" } } } } }, paths: {} };
  t("纯英文文案不索取映射", inject(doc3, {}).missing.size === 0);

  console.log(fail === 0 ? "\n✔ selftest 全通过" : `\n✘ selftest ${fail} 项失败`);
  return fail === 0 ? 0 : 1;
}

const argv = process.argv.slice(2);
process.exit(argv.includes("--selftest") ? selftest() : run());
