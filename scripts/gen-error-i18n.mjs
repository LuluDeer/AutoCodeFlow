#!/usr/bin/env node
/**
 * LANG-ERR-01：从后端错误码表**生成**前端 `err.<CODE>` 词条。
 *
 * ## 为什么是生成而不是两边各写
 *
 * 「后端抛码、前端翻译」把同一句话拆到了两个仓位置。两边各写必然漂移，三种
 * 漂移形态全都**静默**（不报错、不影响构建）：
 *   ① 后端加了码、前端没加词条 → i18next 查不到 key 会把 **key 原样返回**，
 *      用户读到的不是文案而是 `err.EXECUTOR_NOT_FOUND` 这种标识符（本仓
 *      i18n-source-guard 记录过同类生产故障）；
 *   ② zh 两侧措辞不一致 → 同一个失败在 API 文档里一种说法、在界面上另一种；
 *   ③ 前端有词条而后端已删码 → 孤儿词条，永远渲染不到却一直被翻译与评审。
 *
 * 生成 + 漂移门禁把它们一次性消灭：**码表是唯一真值源**，前端 locale 是产物。
 * 这与本仓 `gen:api-types`（openapi.json → api-types.ts）+ `api-types-drift`
 * 的纪律完全同构——已验证的既有模式，不再另造一套。
 *
 * ## 产物
 *
 *   apps/admin-web/src/locales/generated/error-codes.zh.ts
 *   apps/admin-web/src/locales/generated/error-codes.en.ts
 *
 * 由 `zh.ts` / `en.ts` 各 spread 一份（`...errorCodesZh`），故既有的
 * `i18n-infra.test.tsx`（zh/en key 集合必须一致）与 `i18n-source-guard.test.ts`
 * （源码用到的字面量 key 必须在字典里）继续自动覆盖这些词条。
 *
 * ## 用法
 *   node scripts/gen-error-i18n.mjs            # 生成/更新产物
 *   node scripts/gen-error-i18n.mjs --check    # 只校验（CI 漂移门禁用），有差异即红
 *
 * 纯静态解析源码（零依赖、秒级），与 check-error-i18n.mjs 同源解析口径。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCatalog } from './lib/error-catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CATALOG_DIR = 'apps/admin-api/src/common/errors/catalog';
const OUT_DIR = 'apps/admin-web/src/locales/generated';


function emit(locale, catalog) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const lines = [
    '// ⚠️ 本文件由 `node scripts/gen-error-i18n.mjs` 生成，请勿手改。',
    '// 真值源：apps/admin-api/src/common/errors/catalog/*.ts',
    `// 语种：${locale}`,
    '//',
    '// 为什么是生成物：见 scripts/gen-error-i18n.mjs 的头注（三种静默漂移）。',
    '// 改文案请改后端码表分片，然后重跑生成脚本；CI 的 error-i18n-drift 会比对。',
    'export default {',
  ];
  for (const [code, def] of [...catalog].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  'err.${code}': '${esc(def[locale])}',`);
  }
  lines.push('} as const;');
  lines.push('');
  return lines.join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  const catalog = readCatalog(root, CATALOG_DIR);
  const outDir = path.join(root, OUT_DIR);
  const targets = [
    { locale: 'zh', file: 'error-codes.zh.ts' },
    { locale: 'en', file: 'error-codes.en.ts' },
  ];

  let drift = 0;
  for (const { locale, file } of targets) {
    const p = path.join(outDir, file);
    const next = emit(locale, catalog);
    const prev = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
    if (prev === next) {
      console.log(`✔ ${OUT_DIR}/${file} 已是最新（${catalog.size} 个码）`);
      continue;
    }
    if (check) {
      drift++;
      console.error(`✘ ${OUT_DIR}/${file} 与码表不一致（漂移）`);
      continue;
    }
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(p, next, 'utf-8');
    console.log(`✍ 已写入 ${OUT_DIR}/${file}（${catalog.size} 个码）`);
  }

  if (check && drift > 0) {
    console.error(
      '\n处置：跑 `node scripts/gen-error-i18n.mjs` 重新生成并提交产物' +
        '（码表是唯一真值源，不要手改生成物）。',
    );
    return 1;
  }
  if (check) console.log(`✔ LANG-ERR-01 生成物无漂移（${catalog.size} 个码）`);
  return 0;
}

process.exit(main());
