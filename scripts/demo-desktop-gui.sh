#!/usr/bin/env bash
#
# Desktop Agent GUI demo (Linux X11/Xvfb). No Docker, no LLM, no API key —
# but it does need one `npm --prefix apps/executor-desktop install` (see below).
#
# It runs the SAME X11GuiDriver used by executor-desktop's agent host:
#   probe -> focus -> type -> screenshot -> press Enter
# against a throwaway Tk window, then asserts the app received the text.
#
# This is deliberately a *driver* demo, not a full SOP/LLM run: it proves the
# physical GUI path (X11 focus/typing/screenshot) works on this machine and
# produces the evidence image used in the README.
#
# Requirements (Ubuntu/Debian): Xvfb, xfwm4, xdotool, xprop, ffmpeg,
# python3-tk, node, plus executor-desktop's dev deps:
#   npm --prefix apps/executor-desktop install
# (this demo compiles apps/executor-desktop/dist-selftest/ with the local tsc;
# that directory is gitignored, so a clean clone has no prebuilt driver).
# The production executor also needs xdotool + ffmpeg; see docs/operations.md.
#
# Usage:
#   ./scripts/demo-desktop-gui.sh
#   ACF_GUI_DISPLAY=:101 ACF_GUI_SHOT=/tmp/gui.png ./scripts/demo-desktop-gui.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DISPLAY_NUM="${ACF_GUI_DISPLAY:-:99}"
SHOT="${ACF_GUI_SHOT:-$ROOT/docs/assets/screenshots/zh/desktop-agent-demo.png}"
DRIVER="$ROOT/apps/executor-desktop/dist-selftest/agent/gui-x11.js"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/acf-gui-demo.XXXXXX")"
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

if [[ ! -f "$DRIVER" ]]; then
  echo "→ building executor-desktop selftest driver"
  # 本地 .bin/tsc 而不是 npx：npx 在依赖缺失时会联网取一份 tsc（预检已挡，
  # 这里再断掉隐式下载这条路径）。
  (cd "$ROOT/apps/executor-desktop" && ./node_modules/.bin/tsc -p tsconfig.selftest.json) \
    || fail "tsc -p tsconfig.selftest.json failed (see the compiler errors above)"
fi

DISPLAY_NUM_ONLY="${DISPLAY_NUM#:}"
if [[ -e "/tmp/.X${DISPLAY_NUM_ONLY}-lock" ]]; then
  fail "X display $DISPLAY_NUM looks busy; set ACF_GUI_DISPLAY=:101"
fi

mkdir -p "$(dirname "$SHOT")"
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
root.title("AutoCodeFlow GUI Demo")
root.geometry("720x320")
tk.Label(root, text="AutoCodeFlow · X11 GUI driver demo", font=("Sans", 16, "bold")).pack(pady=(24, 6))
tk.Label(root, text="The agent focused this window, typed the text, and captured this PNG.", font=("Sans", 10)).pack()
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

echo "→ launching throwaway Tk app"
DISPLAY="$DISPLAY_NUM" python3 "$TMP/app.py" "$TMP/out.txt" >"$TMP/app.log" 2>&1 &
APP_PID=$!

WID=""
for _ in $(seq 1 50); do
  WID="$(DISPLAY="$DISPLAY_NUM" xdotool search --name 'AutoCodeFlow GUI Demo' 2>/dev/null | head -1 || true)"
  [[ -n "$WID" ]] && break
  sleep 0.2
done
[[ -n "$WID" ]] || fail "Tk window did not appear"

# Tk does not set _NET_WM_PID by default; the driver derives the app identity
# from it (xdotool getwindowpid -> /proc/<pid>/comm).
DISPLAY="$DISPLAY_NUM" xprop -id "$WID" -f _NET_WM_PID 32c -set _NET_WM_PID "$APP_PID"
DISPLAY="$DISPLAY_NUM" xdotool windowactivate "$WID" 2>/dev/null || true
sleep 0.5

echo "→ running X11GuiDriver: focus → type → screenshot → Enter"
DISPLAY="$DISPLAY_NUM" ACF_GUI_DRIVER="$DRIVER" ACF_GUI_SHOT="$SHOT" node --input-type=commonjs <<'NODE'
const { X11GuiDriver } = require(process.env.ACF_GUI_DRIVER);
const shot = process.env.ACF_GUI_SHOT;
const app = 'python3';
const text = 'gui-demo-ok';

(async () => {
  const driver = new X11GuiDriver({ env: { DISPLAY: process.env.DISPLAY } });
  const steps = [];
  const run = async (label, input) => {
    const result = await driver.run(input);
    steps.push([label, result]);
    if (!result.ok) throw new Error(`${label} failed: ${result.error || 'unknown'}`);
    return result;
  };
  if (!(await driver.probe())) throw new Error('probe returned false (no X11/EWMH session)');
  await run('focus', { action: 'focus', app });
  await run('type', { action: 'type', app, text });
  await run('screenshot', { action: 'screenshot', app, screenshotPath: shot });
  await run('press', { action: 'press', app, key: 'ENTER' });
  for (const [label, result] of steps) {
    console.log(`  ✓ ${label}: ${result.detail || 'ok'}`);
  }
})().catch((err) => {
  console.error(`  ✗ ${err.message}`);
  process.exit(1);
});
NODE

for _ in $(seq 1 50); do
  [[ -f "$TMP/out.txt" ]] && break
  sleep 0.2
done
[[ -f "$TMP/out.txt" ]] || fail "the Tk app did not receive the Enter key"

GOT="$(cat "$TMP/out.txt")"
if [[ "$GOT" != "gui-demo-ok" ]]; then
  fail "typed text mismatch: expected 'gui-demo-ok', got '$GOT'"
fi
[[ -s "$SHOT" ]] || fail "screenshot was not written to $SHOT"

echo "✓ desktop GUI driver demo passed"
echo "  app received: $GOT"
echo "  screenshot:   $SHOT"
