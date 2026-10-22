#!/usr/bin/env node
/**
 * Center Agent ops demo: real model + real read-only tools.
 *
 * Creates an `ops_watch` session scoped to one task, asks the model to inspect
 * that task's execution stats, and waits for the tool-calling loop to finish.
 *
 * Requires a running admin-api with an AI provider configured; credentials are
 * read from .env.demo (gitignored) unless env vars are set.
 *
 * Usage:
 *   ./scripts/demo-ops-agent.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

const env = readEnvFile(path.join(root, '.env.demo'));
const base = (process.env.ACF_BASE_URL || 'http://127.0.0.1:3105').replace(/\/+$/, '');
const password = process.env.ACF_ADMIN_PASSWORD || env.INITIAL_ADMIN_PASSWORD;
if (!password) {
  console.error('✗ missing ACF_ADMIN_PASSWORD (or .env.demo)');
  process.exit(1);
}

async function api(pathname, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let raw;
  try { raw = JSON.parse(text); } catch { raw = text; }
  if (!res.ok) {
    throw new Error(`${method} ${pathname} -> ${res.status}: ${String(text).slice(0, 500)}`);
  }
  return raw && typeof raw === 'object' && 'data' in raw ? raw.data : raw;
}

const log = (msg) => console.log(`→ ${msg}`);

(async () => {
  log('admin login');
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password },
  });
  const token = login.accessToken;
  if (!token) throw new Error('login returned no accessToken');

  const tasks = await api('/api/tasks?page=1&pageSize=100', { token });
  const rows = tasks.list ?? tasks.items ?? [];
  const task = rows.find((t) => t.name === 'demo-fragile') ?? rows[0];
  if (!task) throw new Error('no task to inspect');

  const question = [
    `Use the get_execution_stats tool for task ${task.name} (${task.id}).`,
    'Then use list_executions for that task to identify the most recent failure reason.',
    'Summarize: success rate, total runs, most recent failure reason, and one concrete next step.',
    'Do not ask for clarification; you have all the tools and scope you need.',
  ].join(' ');

  log(`create ops_watch session (task=${task.name})`);
  const created = await api('/api/agent/sessions', {
    method: 'POST',
    token,
    body: {
      kind: 'ops_watch',
      title: `ops demo: ${task.name}`,
      context: { question },
      scope: { tasks: [task.id], executors: [], applications: [], projects: [] },
    },
  });
  const sessionId = created.id;
  if (!sessionId) throw new Error('session create returned no id');

  let lastStatus = '';
  for (let i = 0; i < 100; i += 1) {
    const detail = await api(`/api/agent/sessions/${sessionId}`, { token });
    const session = detail.session;
    const status = session.status;
    if (status !== lastStatus) {
      lastStatus = status;
      console.log(`  session status: ${status} (steps=${detail.steps?.length ?? 0})`);
    }
    if (['succeeded', 'failed', 'aborted', 'budget_exceeded'].includes(status)) {
      const tools = (detail.toolCalls ?? []).map((t) => t.toolName);
      console.log(`  tool calls: ${JSON.stringify(tools)}`);
      const answer = [...(detail.steps ?? [])]
        .reverse()
        .find((s) => s.role === 'assistant' && typeof s.content === 'string' && s.content.trim());
      console.log(`  answer: ${String(answer?.content || '').slice(0, 1000)}`);
      if (status !== 'succeeded') {
        console.log(`  error: ${String(session.errorMessage || '').slice(0, 500)}`);
        process.exit(1);
      }
      if (tools.length === 0) {
        throw new Error('model answered without calling any tool');
      }
      if (!tools.includes('get_execution_stats')) {
        throw new Error('model did not call get_execution_stats');
      }
      if (!answer || answer.content.trim().length < 50) {
        throw new Error('model did not produce a substantive final answer');
      }
      console.log('✓ center Agent ops demo passed (real model + real read-only tools)');
      return;
    }
    await sleep(3000);
  }
  throw new Error('timeout waiting for agent session');
})().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
