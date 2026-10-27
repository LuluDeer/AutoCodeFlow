#!/usr/bin/env bash
#
# Desktop Agent end-to-end demo (Linux X11/Xvfb; mock plan by default).
#
# What it proves, without any API key:
#   SOP (goal + acceptance)
#     → agent plan (deterministic mock LLM, strict JSON protocol)
#     → real GUI actions through X11GuiDriver (focus/type/screenshot/Enter)
#     → real trial run in the process sandbox
#     → real acceptance check
#     → outcome = delivered
#
# It is a *mock-plan* demo by default: the control flow, gates, GUI driver,
# workspace sandbox and acceptance path are the production ones; only the LLM
# is replaced with a scripted response. Set ACF_LLM_API_KEY / ACF_LLM_BASE_URL /
# ACF_LLM_MODEL to use a real OpenAI-compatible provider instead.
#
# Requirements: Xvfb, xfwm4, xdotool, xprop, ffmpeg, python3-tk, node, plus
# executor-desktop's dev deps (this demo compiles the gitignored
# apps/executor-desktop/dist-selftest/ with the local tsc):
#   npm --prefix apps/executor-desktop install
#
# Usage:
#   ./scripts/demo-desktop-agent.sh
#   ACF_GUI_DISPLAY=:104 ./scripts/demo-desktop-agent.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DISPLAY_NUM="${ACF_GUI_DISPLAY:-:99}"
SHOT="${ACF_AGENT_SHOT:-$ROOT/docs/assets/screenshots/zh/desktop-agent-sop.png}"
DIST="$ROOT/apps/executor-desktop/dist-selftest/agent"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/acf-agent-demo.XXXXXX")"
WORKSPACE="$TMP/workspace"
APP_PID=""
XVFB_PID=""
WM_PID=""

cleanup() {
  [[ -n "$APP_PID" ]] && kill "$APP_PID" 2>/dev/null || true
  [[ -n "$WM_PID" ]] && kill "$WM_PID" 2>/dev/null || true
  [[ -n "$XVFB_PID" ]] && kill "$XVFB_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "✗ $1" >&2
  echo "--- app log ---" >&2
  cat "$TMP/app.log" 2>/dev/null >&2 || true
  echo "--- xvfb log ---" >&2
  cat "$TMP/xvfb.log" 2>/dev/null >&2 || true
  echo "--- wm log ---" >&2
  cat "$TMP/xfwm4.log" 2>/dev/null >&2 || true
  exit 1
}

# dist-selftest/ 被 .gitignore 忽略（构建产物）：干净克隆里必然没有，下面要用
# tsconfig.selftest.json 现场编译。缺 apps/executor-desktop/node_modules/typescript
# 时 npx 会去网上拉一份 tsc（离线/受限网络直接失败），而失败信息只有
# "failed to build" + 一屏 xvfb/wm 日志——根本看不出缺的是依赖。所以先判依赖，
# 缺了就停在这一步，不往下跑 Xvfb/xterm 那些无关步骤。
if [[ ! -f "$ROOT/apps/executor-desktop/node_modules/typescript/package.json" ]]; then
  echo "✗ apps/executor-desktop/node_modules/typescript is missing — this demo needs it." >&2
  echo "  Why: it compiles apps/executor-desktop/dist-selftest/ (gitignored) with the local tsc." >&2
  echo "  Fix: npm --prefix apps/executor-desktop install" >&2
  exit 1
fi
for tool in Xvfb xfwm4 xdotool xprop ffmpeg python3 node; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: $tool"
done
python3 -c "import tkinter" >/dev/null 2>&1 || fail "python3-tk is not installed (apt install python3-tk)"

if [[ ! -f "$DIST/runtime.js" || ! -f "$DIST/loop.js" || ! -f "$DIST/gui-x11.js" ]]; then
  echo "→ building executor-desktop selftest modules"
  # 本地 .bin/tsc（预检已保证存在），不走 npx 的隐式下载路径。
  (cd "$ROOT/apps/executor-desktop" && ./node_modules/.bin/tsc -p tsconfig.selftest.json) \
    || fail "tsc -p tsconfig.selftest.json failed (see the compiler errors above)"
fi

DISPLAY_NUM_ONLY="${DISPLAY_NUM#:}"
if [[ -e "/tmp/.X${DISPLAY_NUM_ONLY}-lock" ]]; then
  fail "X display $DISPLAY_NUM looks busy; set ACF_GUI_DISPLAY=:104"
fi

mkdir -p "$WORKSPACE" "$(dirname "$SHOT")"
rm -f "$SHOT"

echo "→ starting Xvfb $DISPLAY_NUM + xfwm4"
Xvfb "$DISPLAY_NUM" -screen 0 1280x800x24 >"$TMP/xvfb.log" 2>&1 &
XVFB_PID=$!
sleep 1
DISPLAY="$DISPLAY_NUM" xfwm4 --replace >"$TMP/xfwm4.log" 2>&1 &
WM_PID=$!
sleep 1

cat >"$TMP/app.py" <<'PY'
import pathlib
import sys
import tkinter as tk

out = pathlib.Path(sys.argv[1])
root = tk.Tk(className="python3")
root.title("AutoCodeFlow Agent Target")
root.geometry("720x320")
tk.Label(root, text="AutoCodeFlow · Agent target window", font=("Sans", 16, "bold")).pack(pady=(24, 6))
tk.Label(root, text="The agent will focus, type a token, capture evidence, then press Enter.", font=("Sans", 10)).pack()
entry = tk.Entry(root, font=("Sans", 18), name="entry")
entry.pack(padx=24, pady=28)
entry.focus_set()

def save(_event=None):
    out.write_text(entry.get(), encoding="utf-8")
    root.destroy()

entry.bind("<Return>", save)
tk.Button(root, text="Save", command=save).pack()
root.mainloop()
PY

echo "→ launching target app"
DISPLAY="$DISPLAY_NUM" python3 "$TMP/app.py" "$WORKSPACE/gui.txt" >"$TMP/app.log" 2>&1 &
APP_PID=$!

WID=""
for _ in $(seq 1 50); do
  WID="$(DISPLAY="$DISPLAY_NUM" xdotool search --name 'AutoCodeFlow Agent Target' 2>/dev/null | head -1 || true)"
  [[ -n "$WID" ]] && break
  sleep 0.2
done
[[ -n "$WID" ]] || fail "target window did not appear"
DISPLAY="$DISPLAY_NUM" xprop -id "$WID" -f _NET_WM_PID 32c -set _NET_WM_PID "$APP_PID"
DISPLAY="$DISPLAY_NUM" xdotool windowactivate "$WID" 2>/dev/null || true
sleep 0.5

echo "→ running SOP → plan → GUI actions → trial run → acceptance"
DISPLAY="$DISPLAY_NUM" \
ACF_AGENT_DIST="$DIST" \
ACF_AGENT_WORKSPACE="$WORKSPACE" \
ACF_AGENT_SHOT="$SHOT" \
node --input-type=commonjs <<'NODE'
const fs = require('fs');
const path = require('path');
const { runAgentLoop } = require(path.join(process.env.ACF_AGENT_DIST, 'loop.js'));
const { buildLoopHandlers } = require(path.join(process.env.ACF_AGENT_DIST, 'runtime.js'));
const { X11GuiDriver } = require(path.join(process.env.ACF_AGENT_DIST, 'gui-x11.js'));

const workspaceRoot = process.env.ACF_AGENT_WORKSPACE;
const shotOut = process.env.ACF_AGENT_SHOT;

const plan = {
  files: [
    {
      path: 'verify.js',
      content: [
        "const fs = require('fs');",
        "const value = fs.readFileSync('gui.txt', 'utf8').trim();",
        "if (value !== 'gui-demo-ok') {",
        "  console.error('unexpected marker: ' + JSON.stringify(value));",
        "  process.exit(1);",
        "}",
        "console.log('marker verified: ' + value);",
      ].join('\n'),
    },
  ],
  entry: { interpreter: 'node', path: 'verify.js' },
  notes: 'Focus the target window, type the token, capture evidence, press Enter; then verify the marker file.',
  gui: [
    { action: 'focus', app: 'python3' },
    { action: 'type', app: 'python3', text: 'gui-demo-ok' },
    { action: 'screenshot', app: 'python3' },
    { action: 'press', app: 'python3', key: 'ENTER' },
  ],
};

let chatCalls = 0;
const mockLlm = {
  async chat() {
    chatCalls += 1;
    if (chatCalls === 1) {
      return { ok: true, content: JSON.stringify(plan) };
    }
    // The happy path never diagnoses. If something fails, escalate instead of
    // pretending to deliver.
    return { ok: true, content: JSON.stringify({ action: 'escalate' }) };
  },
};

// Optional real provider. Kept opt-in so the demo stays offline/API-key-free by
// default. Use an OpenAI-compatible endpoint:
//   ACF_LLM_API_KEY=... ACF_LLM_BASE_URL=https://api.example.com/v1 \
//   ACF_LLM_MODEL=... ./scripts/demo-desktop-agent.sh
const realKey = process.env.ACF_LLM_API_KEY || '';
const realBase = (process.env.ACF_LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const realModel = process.env.ACF_LLM_MODEL || 'gpt-4o-mini';
const realLlm = {
  async chat({ messages }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const res = await fetch(`${realBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${realKey}`,
        },
        body: JSON.stringify({
          model: realModel,
          messages,
          max_tokens: 8192,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}: ${String(text).slice(0, 300)}`, content: '' };
      }
      const content = data?.choices?.[0]?.message?.content;
      return {
        ok: true,
        content: typeof content === 'string' ? content : '',
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), content: '' };
    } finally {
      clearTimeout(timer);
    }
  },
};

const llm = realKey ? realLlm : mockLlm;
console.log(`  llm: ${realKey ? `real (${realModel} @ ${realBase})` : 'mock (deterministic)'}`);

const client = {
  async uploadMedia() {
    return { ok: true, mediaPath: 'demo/media.png' };
  },
};

const sop = {
  slug: 'demo-gui-agent',
  title: 'GUI Agent demo',
  version: '1.0.0',
  contentHash: 'demo',
  frontMatter: {
    capabilities: ['gui'],
    acceptance: [{ kind: 'command', run: 'node verify.js' }],
    constraints: {},
    clarification: { maxRounds: 1 },
  },
  bodyMarkdown: [
    '# Demo: type a token into the target window',
    '',
    'Focus the "AutoCodeFlow Agent Target" window, type `gui-demo-ok`, capture a',
    'screenshot as evidence, then press Enter. The app writes the token to',
    '`gui.txt`; acceptance runs `node verify.js` and must exit 0.',
  ].join('\n'),
};

const environment = {
  probedAt: new Date().toISOString(),
  platform: 'linux',
  platformRelease: 'demo',
  arch: process.arch,
  hostname: 'demo',
  cpuCount: 1,
  totalMemoryMB: 1024,
  freeMemoryMB: 512,
  runtimes: [{ name: 'node', available: true, version: process.version }],
  capabilities: ['filesystem', 'gui'],
};

const permissions = {
  preset: 'custom',
  codeExecution: 'sandbox',
  sandboxBackend: 'process',
  hostAccess: 'app-scoped',
  taskExecution: 'deploy-only',
  allowedApps: ['python3'],
  allowedDomains: [],
  source: {
    preset: 'local',
    codeExecution: 'local',
    sandboxBackend: 'local',
    hostAccess: 'local',
    taskExecution: 'local',
  },
};

(async () => {
  let guiActions = 0;
  const handlers = buildLoopHandlers(
    {
      address: 'demo-executor:8001',
      assignmentId: 'demo-assignment',
      client,
      permissions,
      sop,
      workspaceRoot,
      environment,
      guiAvailable: true,
      guiDriver: new X11GuiDriver({ env: { DISPLAY: process.env.DISPLAY } }),
      onGuiActions: (n) => { guiActions = n; },
    },
    llm,
  );

  const result = await runAgentLoop({ environment, permissions, handlers });
  console.log(`  outcome: ${result.outcome}`);
  console.log(`  iterations: ${result.iterations}, trialRuns: ${result.trialRuns}`);
  console.log(`  gui actions: ${guiActions}`);
  console.log(`  candidate: ${String(result.candidate || '').slice(0, 120)}`);
  if (result.outcome !== 'delivered') {
    console.error(`  stopReason: ${result.stopReason || '-'} ${result.stopMessage || ''}`);
    process.exit(1);
  }

  const marker = path.join(workspaceRoot, 'gui.txt');
  const value = fs.readFileSync(marker, 'utf8').trim();
  if (value !== 'gui-demo-ok') {
    throw new Error(`marker mismatch: ${JSON.stringify(value)}`);
  }
  const shots = fs.readdirSync(path.join(workspaceRoot, 'screenshots'))
    .filter((name) => name.endsWith('.png'))
    .sort();
  if (shots.length === 0) throw new Error('no GUI screenshot was captured');
  fs.copyFileSync(path.join(workspaceRoot, 'screenshots', shots[shots.length - 1]), shotOut);
  console.log(`  marker: ${value}`);
  console.log(`  evidence: ${shotOut}`);
})().catch((err) => {
  console.error(`  ✗ ${err.message}`);
  process.exit(1);
});
NODE

[[ -f "$SHOT" ]] || fail "evidence screenshot missing"
echo "✓ desktop Agent demo passed"
echo "  SOP -> plan -> GUI -> trial -> acceptance -> delivered"
echo "  evidence: $SHOT"
