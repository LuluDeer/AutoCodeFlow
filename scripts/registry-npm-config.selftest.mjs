#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const configPath = path.join(root, 'apps/registry-npm/config.yaml');
const composePath = path.join(root, 'docker-compose.yml');
const readmePath = path.join(root, 'apps/registry-npm/README.md');

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function findBlock(lines, header, indent) {
  const start = lines.findIndex((line) => line === `${' '.repeat(indent)}${header}:`);
  if (start < 0) fail(`Missing YAML block: ${header}`);
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      block.push(line);
      continue;
    }
    const leading = line.match(/^ */)?.[0].length ?? 0;
    if (leading <= indent) break;
    block.push(line);
  }
  return block.join('\n');
}

function requireInBlock(block, expected) {
  assert(
    block.split('\n').some((line) => line.trim() === expected),
    `Expected block to contain: ${expected}`,
  );
}

const config = read(configPath);
const compose = read(composePath);
const readme = read(readmePath);
const lines = config.split(/\r?\n/);

const scoped = findBlock(lines, "'@autoflow/*'", 2);
for (const rule of ['access: $authenticated', 'publish: $authenticated', 'unpublish: $authenticated']) {
  requireInBlock(scoped, rule);
}
assert(!/^\s*proxy:/m.test(scoped), '@autoflow/* must not proxy to npmjs');

const allPackages = findBlock(lines, "'**'", 2);
for (const rule of ['access: $authenticated', 'publish: $authenticated', 'unpublish: $authenticated', 'proxy: npmjs']) {
  requireInBlock(allPackages, rule);
}

assert(!/^\s*(access|publish|unpublish):\s*\$all\b/m.test(config), 'Package rules must not grant $all access');
assert(!/^\s*(access|publish|unpublish):\s*\$anonymous\b/m.test(config), 'Package rules must not grant $anonymous access');
assert(config.includes('file: /verdaccio/storage/htpasswd'), 'htpasswd must live in persistent storage');
assert(config.includes('expiresIn: 60d'), 'API token lifetime must be explicit');
assert(config.includes('expiresIn: 7d'), 'Web token lifetime must be explicit');

assert(compose.includes("- '127.0.0.1:4873:4873'"), 'registry-npm host port must bind to 127.0.0.1 by default');
assert(compose.includes('./apps/registry-npm/config.yaml:/verdaccio/conf/config.yaml:ro'), 'config.yaml must be mounted read-only');
assert(compose.includes('npm_data:/verdaccio/storage'), 'registry-npm storage must use the persistent npm_data volume');

for (const needle of [
  '| Anonymous | ping / healthcheck | ✅ Allowed |',
  '| Anonymous | package metadata / tarball download | ❌ Denied |',
  '| Authenticated user | package metadata / tarball download | ✅ Allowed |',
  '| Authenticated user | publish / unpublish | ✅ Allowed |',
]) {
  assert(readme.includes(needle), `README permission matrix missing: ${needle}`);
}

console.log('registry-npm config selftest passed');
