/**
 * LANG-ERR-01：错误码表的**共享解析层**（生成器与守卫共用同一份）。
 *
 * ## 为什么必须共享
 *
 * 「生成物」与「漂移守卫」若各写一份解析正则，两者的**口径差异**会变成最坏的
 * 一类假绿：守卫用旧口径解析不出新增的码 → 它算出的"应有产物"与生成器的不同 →
 * 要么守卫误报漂移（噪声），要么更糟：**守卫解析不到任何码而判定"没有差异"**
 * （本仓真实踩过——守卫首版的正则只认单行条目，而码表已改成多行格式，于是
 * 它报"未能解析出任何错误码"，若当时把这条降级成警告就会直接变假绿）。
 *
 * 故解析规则只有这一份，两个消费方都 import 它。零依赖（只用 node 内置）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 解析一段分片源码，抽出 `CODE: { status, zh, en }`。
 *
 * 用正则而非 import 的理由：CI 守卫 job 是**零依赖 node 脚本**，不该为读一张
 * 码表去编译整个 NestJS 应用（那会把秒级守卫变成分钟级、且依赖 node_modules）。
 * 源码字面量本身就是事实源。
 *
 * ⚠️ **必须同时接受单引号与双引号字面量**（本轮真实踩到的静默漏解析）：
 * `en` 文案里常含双引号（如 `Task name "{{name}}" already exists`），写码的人
 * 自然会用**单引号**包住它以免转义；首版解析器只认 `en: "..."`，于是这些条目
 * 被**整条跳过**——而且生成器与守卫**共享**这个口径，两边算出的都是"45 个码"
 * 从而判定"无漂移"，前端却缺了那些 key（`i18n.exists` 返回 false，用户读到
 * 裸 key）。这正是"两边共享同一份错误口径 = 一起假绿"的形态。
 *
 * 故下面：
 *   ① 两个字段都接受 `"` 或 `'`；
 *   ② 结尾做**条目数交叉校验**（见 readCatalog）——解析数少于实际 `CODE: {`
 *      出现次数即抛错，杜绝"漏解析但不报错"。
 */
const STRING_FIELD = (name) =>
  new RegExp(`${name}:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)')`);

const ZH_RE = STRING_FIELD('zh');
const EN_RE = STRING_FIELD('en');
const STATUS_RE = /status:\s*(\d+)/;

/** 取出某个字段的字面量值（兼容两种引号），并把转义还原。 */
function field(body, re) {
  const m = re.exec(body);
  if (!m) return null;
  const raw = m[1] !== undefined ? m[1] : m[2];
  return raw.replace(/\\"/g, '"').replace(/\\'/g, "'");
}

export function parseCatalog(src) {
  const out = new Map();
  const re = /\n {2}([A-Z][A-Z0-9_]*):\s*\{([\s\S]*?)\n {2}\},/g;
  for (const m of src.matchAll(re)) {
    const code = m[1];
    const body = m[2];
    const status = STATUS_RE.exec(body);
    const zh = field(body, ZH_RE);
    const en = field(body, EN_RE);
    if (!status || zh === null || en === null) continue;
    out.set(code, { status: Number(status[1]), zh, en });
  }
  return out;
}

/** 数出源码里出现了多少条 `CODE: {` 条目（用于与解析结果交叉校验）。 */
export function countDeclaredEntries(src) {
  return (src.match(/\n {2}[A-Z][A-Z0-9_]*:\s*\{/g) || []).length;
}

/**
 * 读取并合并全部分片。
 *
 * 两条**硬失败**（都不是噪声，而是判据已失效的信号）：
 *   · 分片目录为空 / 解析不出任何码 → 抛错（否则守卫会"永远通过"）；
 *   · 同一码出现在多个分片 → 抛错。合并点是 `{...A, ...B}`，后者会**静默覆盖**
 *     前者，等于悄悄丢了一个域的定义（比重复更隐蔽）。
 */
export function readCatalog(root, catalogDir) {
  const dir = path.join(root, catalogDir);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .sort();
  if (files.length === 0) {
    throw new Error(`分片目录 ${catalogDir} 下没有 .ts 文件——码表分片丢失`);
  }
  const merged = new Map();
  let declared = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf-8');
    declared += countDeclaredEntries(src);
    for (const [code, def] of parseCatalog(src)) {
      if (merged.has(code)) {
        throw new Error(`错误码重复定义于多个分片：${code}（${f}）`);
      }
      merged.set(code, def);
    }
  }
  if (merged.size === 0) {
    throw new Error(
      `未能从分片目录 ${catalogDir} 解析出任何错误码——解析口径与源码格式已失配（判据失效）`,
    );
  }
  // 交叉校验：解析数必须等于源码里的条目数。**少一条即抛错**——这是防"某个
  // 条目因为引号风格/换行形态没被认出来"的唯一有效手段（本轮真实漏解析过一次：
  // `en` 用单引号包住含双引号的英文时，整条被跳过，而生成器与守卫共享同一口径
  // 于是**双双假绿**，前端缺 key 却无人发现）。
  if (merged.size !== declared) {
    throw new Error(
      `分片条目数与解析结果不一致：源码声明 ${declared} 条，只解析出 ${merged.size} 条。` +
        `多半是某条的字面量写法（引号风格/换行）未被识别——请修 scripts/lib/error-catalog.mjs 的解析口径，` +
        `不要放过差异。`,
    );
  }
  return merged;
}
