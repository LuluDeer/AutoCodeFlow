// MCP stdio handshake probe: initialize + tools/list, count and sanity-check tools.
//
// Usage:
//   node scripts/mcp-tools-probe.cjs [--check] [path-to-mcp-dist-index.js]
//
//   (no flags)  print a full report (tool count, annotation/enum coverage, names)
//   --check     guard mode: assert the audited invariants and exit non-zero on
//               any drift (used by CI). See docs/MCP-AGENT-UX-AUDIT-2026-10-08.md.
//
// Flags are stripped from argv before resolving the optional server path, so
// `--check` is never mistaken for the entry file.
const { spawn } = require('node:child_process');
const path = require('node:path');

const args = process.argv.slice(2);
const CHECK_MODE = args.includes('--check');
const positional = args.filter((a) => !a.startsWith('--'));
const serverEntry =
  positional[0] || path.resolve(__dirname, '../packages/mcp-server/dist/index.js');

const child = spawn(process.execPath, [serverEntry], {
  env: {
    ...process.env,
    AUTOCODEFLOW_API_URL: 'http://127.0.0.1:9',
    AUTOCODEFLOW_API_TOKEN: 'probe-token',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
let stderr = '';
const replies = new Map();
let nextId = 1;

function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    replies.set(id, { resolve, reject });
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
  });
}

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && replies.has(msg.id)) {
      const { resolve, reject } = replies.get(msg.id);
      replies.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});
child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

(async () => {
  try {
    const init = await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'probe', version: '1.0.0' },
    });
    console.log('serverInfo:', JSON.stringify(init.serverInfo));

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const listed = await send('tools/list', {});
    const tools = listed.tools || [];
    console.log('TOOL COUNT:', tools.length);

    // sanity: every tool must have a name, description, and inputSchema
    const noDesc = tools.filter((t) => !t.description).map((t) => t.name);
    const noSchema = tools.filter((t) => !t.inputSchema).map((t) => t.name);
    const noOutputSchema = tools.filter((t) => !t.outputSchema).map((t) => t.name);
    const noAnnotations = tools.filter((t) => !t.annotations).map((t) => t.name);

    console.log('missing description:', noDesc.length ? noDesc.join(', ') : '(none)');
    console.log('missing inputSchema:', noSchema.length ? noSchema.join(', ') : '(none)');
    console.log('WITH outputSchema:', tools.length - noOutputSchema.length, '/', tools.length);
    console.log('WITH annotations :', tools.length - noAnnotations.length, '/', tools.length);

    // required-param count per tool (agent-facing strictness)
    let totalRequired = 0;
    const requiredByTool = {};
    for (const t of tools) {
      const req = (t.inputSchema && t.inputSchema.required) || [];
      requiredByTool[t.name] = req.length;
      totalRequired += req.length;
    }
    const zeroArg = tools.filter((t) => (requiredByTool[t.name] || 0) === 0).map((t) => t.name);
    console.log('required-param total:', totalRequired);
    console.log('tools with 0 required params:', zeroArg.length);

    // enum coverage across all schemas (property-level)
    let enumProps = 0, stringProps = 0;
    const enumSamples = [];
    const walk = (node, tool) => {
      if (!node || typeof node !== 'object') return;
      if (node.enum) { enumProps++; enumSamples.push(`${tool}`); }
      if (node.type === 'string' && !node.enum) stringProps++;
      for (const v of Object.values(node)) walk(v, tool);
    };
    for (const t of tools) walk(t.inputSchema, t.name);
    console.log('schema props with enum:', enumProps, '| plain string props:', stringProps);
    console.log('enum-bearing prop samples:', [...new Set(enumSamples)].join(', ') || '(none)');

    // ---------------------------------------------------------------------
    // --check: guard mode (CI). Asserts the invariants that
    // docs/MCP-AGENT-UX-AUDIT-2026-10-08.md established, so a future edit
    // cannot silently drop annotation coverage or re-prose the runMode enum.
    // ---------------------------------------------------------------------
    if (CHECK_MODE) {
      const failures = [];
      const byName = new Map(tools.map((t) => [t.name, t]));

      // (1) total is pinned to the audited count — bump deliberately.
      // 52 → 56（MUTEX-01 互斥组四工具：list/create/update/delete_mutex_group）。
      const EXPECTED_TOOLS = 56;
      if (tools.length !== EXPECTED_TOOLS) {
        failures.push(
          `tool count is ${tools.length}, expected ${EXPECTED_TOOLS} — if you added/removed a tool, ` +
            `update this constant AND its annotations/tests deliberately`,
        );
      }

      // (2) every tool must carry annotations (readOnly and/or destructive).
      const noAnn = tools.filter((t) => !t.annotations).map((t) => t.name);
      if (noAnn.length) failures.push(`tools without annotations: ${noAnn.join(', ')}`);

      // (3) the destructive set must stay explicitly flagged.
      for (const n of [
        'delete_application', 'kill_execution', 'stop_deployment',
        'reject_deployment', 'rollback_task_version',
        'deploy_application', 'deploy_app',
        'delete_mutex_group',
      ]) {
        const t = byName.get(n);
        if (!t) { failures.push(`expected tool missing: ${n}`); continue; }
        if (t.annotations?.destructiveHint !== true) {
          failures.push(`${n} must declare destructiveHint:true`);
        }
        if (t.annotations?.readOnlyHint === true) {
          failures.push(`${n} must not be readOnlyHint:true`);
        }
      }

      // (4) read-only list/get tools must be flagged readOnlyHint:true.
      for (const n of ['list_tasks', 'get_task', 'list_executors', 'list_projects', 'list_mutex_groups']) {
        if (byName.get(n)?.annotations?.readOnlyHint !== true) {
          failures.push(`${n} must declare readOnlyHint:true`);
        }
      }

      // (5) deploy runMode must remain a real enum (P0 regression lock).
      for (const n of ['deploy_application', 'deploy_app']) {
        const schema = byName.get(n)?.inputSchema ?? {};
        const props = schema.properties ?? {};
        const runMode = props.runMode ?? {};
        const vals = runMode.enum ?? [];
        if (vals.join(',') !== 'once,daemon,scheduled') {
          failures.push(
            `${n}.runMode must be an enum [once,daemon,scheduled] (got: ${JSON.stringify(runMode)})`,
          );
        }
      }

      if (failures.length) {
        console.error('\nMCP tool-surface guard FAILED:');
        for (const f of failures) console.error('  ✘ ' + f);
        child.kill();
        process.exit(1);
      }
      console.log('\nMCP tool-surface guard OK: 56 tools, annotations complete, runMode enums intact.');
    }

    // names list — report mode only (the guard's output should stay short/parsable)
    if (!CHECK_MODE) {
      console.log('\n--- TOOL NAMES ---');
      console.log(tools.map((t) => t.name).sort().join('\n'));
    }

    child.kill();
    process.exit(0);
  } catch (e) {
    console.error('PROBE FAILED:', e.message);
    if (stderr) console.error('server stderr:', stderr.slice(0, 2000));
    child.kill();
    process.exit(1);
  }
})();