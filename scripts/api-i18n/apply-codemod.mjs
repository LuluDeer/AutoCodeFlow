#!/usr/bin/env node
/**
 * Apply the bilingual `x-i18n-en` carrier to every Chinese decorator string.
 *
 * Transformation, per decorator string slot that currently holds Chinese:
 *
 *   DTO property (`@ApiProperty` / `@ApiPropertyOptional` / `@ApiSchema`):
 *     `@ApiProperty({ description: "中文" })`
 *       -> `@ApiProperty(i18nProperty({ zh: "中文", en: "<English>" }))`
 *     `@ApiProperty({ example: X, description: "中文" })`
 *       -> `@ApiProperty({ example: X, ...i18nProperty({ zh: "中文", en: "<English>" }) })`
 *
 *   Operation (`@ApiOperation`):
 *     `@ApiOperation({ summary: "中文" })`
 *       -> `@ApiOperation(i18nOperation({ summaryZh: "中文", summaryEn: "<English>" }))`
 *     mixed summary+description -> one `i18nOperation` call carrying both.
 *
 *   Nested inline schema fragments inside a decorator's `properties: {...}`
 *   (raw JSON-schema, not decorator options — the helper cannot reach them):
 *       -> append `, "x-i18n-en": "<English>"` right after the `description`.
 *
 * Import injection:
 *   `i18nProperty` / `i18nOperation` are imported from
 *   `../../../common/i18n/api-i18n` (path computed per file depth), NOT from
 *   `@nestjs/swagger`.
 *
 * Design notes:
 *  - Pure text transformation; untouched code is byte-identical.
 *  - Idempotent: slots already carrying the carrier are skipped.
 *  - Deterministic: edits applied in reverse source order.
 *  - Never touches `description:` literals that are runtime data (config-store
 *    rows) — those have no en-map entry, so they are skipped by lookup.
 *
 * Usage: node scripts/api-i18n/apply-codemod.mjs <en-map.json> [--dry]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SRC = join(ROOT, "apps", "admin-api", "src");
const DRY = process.argv.includes("--dry");

const enMap = JSON.parse(readFileSync(process.argv[2], "utf8"));
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === "__tests__" || e === "node_modules") continue;
      walk(p, acc);
    } else if (/\.(dto|controller)\.ts$/.test(e)) acc.push(p);
  }
  return acc;
}

/**
 * Locate every decorator call with its balanced-paren span.
 * Also records the span of the FIRST argument, which is the options object.
 */
function findDecorators(text) {
  const out = [];
  const re = /@(Api[A-Za-z]*)\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1;
    let depth = 0, i = open;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) break; }
    }
    out.push({
      dec: m[1],
      start: m.index,
      open,
      close: i,
      inner: text.slice(open + 1, i),
    });
    re.lastIndex = i + 1;
  }
  return out;
}

/** Find `key: "value"` string slots in [from,to) with absolute offsets. */
function findStringSlots(text, from, to) {
  const out = [];
  const re = /\b(description|summary)\s*:\s*(["'])((?:\\.|(?!\2)[\s\S])*?)\2/g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(text)) && m.index < to) {
    out.push({
      key: m[1], value: m[3], start: m.index, end: m.index + m[0].length,
    });
  }
  return out;
}

const tsString = (s) =>
  '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n") + '"';

const PROP_DECS = new Set(["ApiProperty", "ApiPropertyOptional", "ApiResponseProperty", "ApiSchema"]);

/** Remove a now-empty `{ }` options object left after deleting all its keys. */
function collapseEmptyBraces(s) {
  return s.replace(/\(\s*\{\s*\}\s*\)/g, "()");
}

/** True when the options object (possibly after a spread) is effectively empty. */
function optionsAreEmpty(inner) {
  const stripped = inner
    .replace(/\.\.\.[A-Za-z_$][\w$]*\([^()]*\)/g, "")
    .replace(/\s/g, "");
  return stripped === "" || stripped === "{}";
}

const stats = {
  files: 0, changedFiles: 0, propSlots: 0, opSlots: 0,
  inlineSlots: 0, alreadyDone: 0, importsAdded: 0,
  missingTranslations: [],
};

for (const file of walk(SRC)) {
  const original = readFileSync(file, "utf8");
  let text = original;
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  stats.files++;

  const decorators = findDecorators(text);
  const edits = [];

  for (const d of decorators) {
    const slots = findStringSlots(text, d.open, d.close).filter((s) => CJK.test(s.value));
    if (!slots.length) continue;

    if (d.inner.includes("i18nProperty(") || d.inner.includes("i18nOperation(")) {
      stats.alreadyDone += slots.length;
      continue;
    }

    const isProp = PROP_DECS.has(d.dec);
    const isOp = d.dec === "ApiOperation";

    // Which of this decorator's Chinese slots are translatable?
    const usable = slots.filter((s) => enMap[s.value]);
    for (const s of slots) {
      if (!enMap[s.value]) stats.missingTranslations.push({ file: rel, zh: s.value });
    }
    if (!usable.length) continue;

    // Decide spread-vs-sole-argument NOW, from the decorator's current options:
    // if the ONLY top-level keys are the Chinese slots we are about to remove,
    // the helper call replaces the object entirely (no spread); otherwise the
    // helper is spread into the surviving options object.
    const topKeys = topLevelOptionKeys(text, d);

    // `properties: {...}` inside the options carries raw JSON-schema fragments
    // that the helper cannot reach — handled by the inline pass below.
    const propFragBounds = isProp ? rawSchemaFragmentSpans(text, d) : [];

    const translatable = slots.filter(
      (s) =>
        enMap[s.value] &&
        !propFragBounds.some((b) => s.start > b.start && s.start < b.end),
    );

    // A top-level key survives if it is NOT one of the slots we are rewriting.
    // Match by containment: the slot span covers `description: "..."`, so the
    // key's offset lies inside [slot.start, slot.end).
    const removedKeyStarts = new Set();
    for (const s of translatable) {
      for (const k of topKeys) {
        if (k.start >= s.start && k.start < s.end) removedKeyStarts.add(k.start);
      }
    }
    const remainingKeys = topKeys.filter((k) => !removedKeyStarts.has(k.start));

    // The helper is the sole argument only when no other top-level key survives
    // AND the decorator has no other positional arguments after the object.
    const afterObject = text.slice(d.open + 1, d.close);
    const hasOtherArgs = /^\s*\{[\s\S]*\}\s*,\s*\S/.test(afterObject);
    const soleArgument = remainingKeys.length === 0 && translatable.length > 0 && !hasOtherArgs;
    const spread = soleArgument ? "" : "...";

    for (const s of slots) {
      if (!enMap[s.value]) continue;
      const inFragment = propFragBounds.some((b) => s.start > b.start && s.start < b.end);
      if (inFragment) continue; // handled by inline pass

      if (isOp) {
        const en = enMap[s.value];
        const part =
          s.key === "summary"
            ? `summaryZh: ${tsString(s.value)}, summaryEn: ${tsString(en)}`
            : `descriptionZh: ${tsString(s.value)}, descriptionEn: ${tsString(en)}`;
        // delete the slot + one trailing comma
        let end = s.end;
        const cm = /^\s*,\s*/.exec(text.slice(end));
        if (cm) end += cm[0].length;
        edits.push({ kind: "delete", start: s.start, end });
        edits.push({ kind: "insert", at: d.close, text: `${spread}i18nOperation({ ${part} }), ` });
        stats.opSlots++;
      } else if (isProp) {
        const en = enMap[s.value];
        let end = s.end;
        const cm = /^\s*,\s*/.exec(text.slice(end));
        if (cm) end += cm[0].length;
        edits.push({ kind: "delete", start: s.start, end });
        edits.push({
          kind: "insert",
          at: d.close,
          text: `${spread}i18nProperty({ zh: ${tsString(s.value)}, en: ${tsString(en)} }), `,
        });
        stats.propSlots++;
      } else {
        edits.push({
          kind: "insert",
          at: s.end,
          text: `, "x-i18n-en": ${tsString(enMap[s.value])}`,
        });
        stats.inlineSlots++;
      }
    }
  }

  // Global inline pass: nested raw-schema descriptions and any non-property,
  // non-operation decorator strings (ApiResponse descriptions etc.).
  const handledByPropPass = new Set();
  for (const d of decorators) {
    if (!PROP_DECS.has(d.dec) && d.dec !== "ApiOperation") continue;
    if (d.inner.includes("i18nProperty(") || d.inner.includes("i18nOperation(")) continue;
    const frags = PROP_DECS.has(d.dec) ? rawSchemaFragmentSpans(text, d) : [];
    for (const s of findStringSlots(text, d.open, d.close)) {
      if (!CJK.test(s.value)) continue;
      const inFrag = frags.some((b) => s.start > b.start && s.start < b.end);
      if (!inFrag && d.dec !== "ApiOperation" && PROP_DECS.has(d.dec)) handledByPropPass.add(s.start);
      if (!inFrag && d.dec === "ApiOperation") handledByPropPass.add(s.start);
      // For ApiSchema we DO use the helper, so only fragments fall through.
      if (!inFrag && d.dec === "ApiSchema") handledByPropPass.add(s.start);
    }
  }

  for (const s of findStringSlots(text, 0, text.length)) {
    if (!CJK.test(s.value)) continue;
    if (handledByPropPass.has(s.start)) continue;
    const en = enMap[s.value];
    if (!en) { stats.missingTranslations.push({ file: rel, zh: s.value }); continue; }
    if (/^\s*,\s*"x-i18n-en"/.test(text.slice(s.end))) continue;
    edits.push({ kind: "insert", at: s.end, text: `, "x-i18n-en": ${tsString(en)}` });
    stats.inlineSlots++;
  }

  if (!edits.length) continue;

  edits.sort((a, b) => (b.at ?? b.end) - (a.at ?? a.end));
  for (const e of edits) {
    if (e.kind === "delete") text = text.slice(0, e.start) + text.slice(e.end);
    else text = text.slice(0, e.at) + e.text + text.slice(e.at);
  }

  // Tidy: when EVERY option key of a decorator was moved into the helper, the
  // original options object is left empty (`@ApiProperty({ } ...helper)`).
  // Drop that now-redundant `{ }` and normalise the resulting separators —
  // done structurally per decorator so no unrelated code is touched.
  text = tidyDecoratorOptions(text);

  // Import injection.
  const needsProp = text.includes("i18nProperty(") && !text.includes("i18nProperty({})");
  const needsOp = text.includes("i18nOperation(");
  if (needsProp || needsOp) {
    const names = [needsProp ? "i18nProperty" : null, needsOp ? "i18nOperation" : null].filter(Boolean);
    // relative path from this file to src/common/i18n/api-i18n
    const absTarget = join(SRC, "common", "i18n", "api-i18n");
    let relPath = relative(dirname(file), absTarget).replace(/\\/g, "/");
    if (!relPath.startsWith(".")) relPath = "./" + relPath;
    const importLine = `import { ${names.join(", ")} } from "${relPath}";`;

    if (text.includes(importLine)) {
      // already present
    } else {
      // Insert after the last existing import statement.
      const importRe = /^import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm;
      let last = null, mm;
      while ((mm = importRe.exec(text))) last = mm;
      if (last) {
        const at = last.index + last[0].length;
        text = text.slice(0, at) + "\n" + importLine + text.slice(at);
      } else {
        text = importLine + "\n" + text;
      }
      stats.importsAdded++;
    }
  }

  if (text !== original) {
    stats.changedFiles++;
    if (!DRY) writeFileSync(file, text, "utf8");
  }
}

/**
 * Spans of raw JSON-schema fragments inside a decorator's options object:
 * the value of `properties:` / `items:` (which the helper cannot reach).
 */
function rawSchemaFragmentSpans(text, d) {
  const spans = [];
  const re = /\b(properties|items)\s*:\s*\{/g;
  re.lastIndex = d.open;
  let m;
  while ((m = re.exec(text)) && m.index < d.close) {
    const braceOpen = m.index + m[0].length - 1;
    let depth = 0, i = braceOpen;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) break; }
    }
    spans.push({ start: braceOpen, end: i });
    re.lastIndex = i + 1;
  }
  return spans;
}

/**
 * Normalise decorator option lists after the codemod:
 *   `@ApiProperty({ } ...i18nProperty({...}))`  -> `@ApiProperty(i18nProperty({...}))`
 *   `@ApiProperty({ ..., } ...i18nProperty(...))` -> `@ApiProperty({ ... })`
 *   `@ApiOperation(i18nOperation({...}), )`      -> `@ApiOperation(i18nOperation({...}))`
 *
 * Structural (walks decorator spans), so unrelated code is never rewritten.
 */
/**
 * Top-level option keys of a decorator's first (options-object) argument,
 * with the absolute offset of each key. Used to decide whether the helper call
 * can replace the object wholesale or must be spread into it.
 */
function topLevelOptionKeys(text, d) {
  const inner = d.inner;
  const braceIdx = inner.indexOf("{");
  if (braceIdx < 0) return [];
  const base = d.open + 1 + braceIdx + 1;
  const keys = [];
  let depth = 0, i = braceIdx + 1;
  const limit = inner.length;
  // Walk the top level of the object literal, tracking string literals so that
  // commas/parens inside strings never confuse the scan.
  let inStr = null;
  for (; i < limit; i++) {
    const ch = inner[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{" || ch === "[" || ch === "(") { depth++; continue; }
    if (ch === "}" || ch === "]" || ch === ")") {
      if (depth === 0) break; // end of object literal
      depth--;
      continue;
    }
    if (depth !== 0) continue;
    // At top level: try to match `key:` here.
    const rest = inner.slice(i);
    const km = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(rest);
    if (km) {
      keys.push({ key: km[1], start: base + i + km[0].indexOf(km[1]) });
      i += km[0].length - 1;
    }
  }
  return keys;
}

/**
 * If a decorator's argument list is exactly one `i18nProperty(...)` /
 * `i18nOperation(...)` call plus optional separators, return the call text
 * (without trailing comma). Otherwise null.
 *
 * Balanced-paren scan, so nested object literals inside the helper call are fine.
 */
function matchSoleHelperCall(inner) {
  const m = /^\s*(\.{3})?(i18n(?:Property|Operation))\s*\(/.exec(inner);
  if (!m) return null;
  const callStart = m[1] ? m[1].length : 0;
  const open = m[0].length - 1;
  let depth = 0, i = open;
  for (; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) break; }
  }
  if (i >= inner.length) return null; // unbalanced
  const call = inner.slice(callStart, i + 1);
  const tail = inner.slice(i + 1);
  if (!/^\s*,?\s*$/.test(tail)) return null; // something else follows
  return call;
}

/**
 * Remove the now-redundant leading `{ }` when the helper call became the sole
 * argument, and drop a trailing comma before the decorator's closing paren.
 * Structural and idempotent.
 */
function tidyDecoratorOptions(text) {
  const decs = findDecorators(text);
  const edits = [];
  for (const d of decs) {
    if (!d.inner.includes("i18nProperty(") && !d.inner.includes("i18nOperation(")) continue;

    // Sole argument: `@ApiProperty(i18nProperty({...}), )` -> `@ApiProperty(i18nProperty({...}))`
    // The helper call may itself contain nested braces/parens (zh/en strings can
    // hold anything except unescaped quotes), and may or may not be preceded by
    // a spread. Match it by balanced-paren scan rather than one regex.
    const soleInner = matchSoleHelperCall(d.inner);
    if (soleInner !== null) {
      edits.push({ start: d.open + 1, end: d.close, text: soleInner });
      continue;
    }
    // Otherwise drop an empty leading object literal `{ }` / `{},` if present.
    const lead = /^\s*\{\s*\}\s*,?\s*/.exec(d.inner);
    if (lead) {
      edits.push({ start: d.open + 1, end: d.open + 1 + lead[0].length, text: "" });
      continue;
    }
    // Dangling trailing comma before the closing paren.
    const trail = /,\s*$/.exec(d.inner);
    if (trail) {
      edits.push({ start: d.open + 1 + trail.index, end: d.close, text: "" });
    }
  }
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  return text;
}

const uniqMissing = [...new Map(stats.missingTranslations.map((x) => [x.zh, x])).values()];
console.log(JSON.stringify({
  files: stats.files,
  changedFiles: stats.changedFiles,
  propSlots: stats.propSlots,
  opSlots: stats.opSlots,
  inlineSlots: stats.inlineSlots,
  alreadyDone: stats.alreadyDone,
  importsAdded: stats.importsAdded,
  missingTranslations: uniqMissing.length,
  dryRun: DRY,
}, null, 2));
if (uniqMissing.length) {
  console.log("MISSING (runtime data, not OpenAPI doc strings):");
  for (const x of uniqMissing) console.log(`  ${x.file}: ${JSON.stringify(x.zh)}`);
}
