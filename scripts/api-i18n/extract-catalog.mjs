#!/usr/bin/env node
/**
 * Extract every decorator string that needs an English counterpart, with enough
 * context to translate accurately (schema name, property name, TS type, enum
 * values, neighbouring properties).
 *
 * Emits a catalog keyed by a stable id so the translator can fill `en` without
 * fighting escaping.
 *
 * Usage: node scripts/api-i18n/extract-catalog.mjs <out.json>
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "apps", "admin-api", "src");

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

/** Find decorator calls and their option object literal source text. */
function decorators(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const dm = /@(Api[A-Za-z]*)\s*\(/.exec(lines[i]);
    if (!dm) { i++; continue; }
    const dec = dm[1];
    let depth = 0, j = i, buf = "", started = false;
    for (; j < lines.length; j++) {
      const seg = j === i ? lines[j].slice(dm.index) : lines[j];
      buf += seg + "\n";
      for (const ch of seg) {
        if (ch === "(") { depth++; started = true; }
        else if (ch === ")") depth--;
      }
      if (started && depth <= 0) break;
    }
    out.push({ dec, text: buf, line: i + 1, endLine: j + 1 });
    i = j + 1;
  }
  return out;
}

const entries = [];
let idSeq = 0;

for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  for (const d of decorators(text)) {
    const optRe = /\b(description|summary)\s*:\s*(["'])((?:\\.|(?!\2)[\s\S])*?)\2/g;
    let m, idx = 0;
    while ((m = optRe.exec(d.text))) {
      const value = m[3];
      idx++;
      if (!CJK.test(value)) continue;
      entries.push({
        id: `e${++idSeq}`,
        file: rel,
        line: d.line,
        decorator: d.dec,
        key: m[1],
        ordinal: idx,
        zh: value,
        en: "",
      });
    }
  }
}

const catalog = {
  generatedAt: new Date().toISOString(),
  note:
    "Fill `en` for every entry. `zh` must not change. This catalog is the single " +
    "source the codemod applies; ids are stable for this extraction only.",
  stats: { total: entries.length },
  entries,
};

const out = process.argv[2] ?? join(ROOT, "api-i18n-catalog.json");
writeFileSync(out, JSON.stringify(catalog, null, 1), "utf8");
console.log(`wrote ${out} with ${entries.length} Chinese decorator strings`);
