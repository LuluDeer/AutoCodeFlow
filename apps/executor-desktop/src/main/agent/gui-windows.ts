/**
 * Windows desktop GUI driver. All input is sent through one fixed PowerShell
 * program; model supplied values travel only as JSON on stdin. The native side
 * checks the foreground process before every operation (and every typed char).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

export const WINDOWS_GUI_KEYS = [
  'ENTER', 'TAB', 'ESCAPE', 'BACKSPACE', 'DELETE',
  'UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME', 'END', 'PAGEUP', 'PAGEDOWN',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
] as const;

export interface WindowsGuiInput {
  action: 'focus' | 'click' | 'type' | 'press' | 'screenshot';
  /** Lowercase process name without .exe, not a path or window title. */
  app: string;
  /** Coordinates relative to the target window's outer bounds. */
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  /** Already resolved against the agent workspace by the caller. */
  screenshotPath?: string;
}

export interface WindowsGuiResult {
  ok: boolean;
  error?: string;
  detail?: string;
}

type NativeRequest = WindowsGuiInput | { action: 'probe' };
type NativeInvoke = (request: NativeRequest) => Promise<WindowsGuiResult>;

export interface WindowsGuiDriverOptions {
  /** Test seam; production always uses process.platform. */
  platform?: NodeJS.Platform;
  /** Test seam; production always invokes the fixed PowerShell program. */
  invoke?: NativeInvoke;
}

// Keep this identical to permission-profile.normalizeAllowedApp's output.
const APP_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_TYPE_LENGTH = 1024;
const MAX_POWERSHELL_OUTPUT = 16 * 1024;
const POWERSHELL_TIMEOUT_MS = 15_000;
// Resolve the OS copy directly so a same-named executable in workDir/PATH
// cannot replace the fixed helper.
const POWERSHELL_EXE = path.win32.join(
  process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
);

// No request field is interpolated into this script. PowerShell receives only
// JSON via stdin, then invokes the closed native methods below.
const WINDOWS_GUI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Reply([bool]$ok, [string]$error = '', [string]$detail = '') {
  $result = @{ ok = $ok }
  if ($error) { $result.error = $error }
  if ($detail) { $result.detail = $detail }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 3))
}

try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($null -eq $request) { throw 'invalid_request' }
  Add-Type -AssemblyName System.Drawing -ErrorAction Stop
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AcfGuiNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx, dy;
    public uint mouseData, dwFlags, time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk, wScan;
    public uint dwFlags, time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public INPUTUNION U;
  }

  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);

  private static bool Inject(INPUT[] inputs) {
    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == inputs.Length;
  }
  private static INPUT Mouse(uint flags) {
    INPUT input = new INPUT(); input.type = 0;
    input.U.mi = new MOUSEINPUT(); input.U.mi.dwFlags = flags;
    return input;
  }
  private static INPUT Key(ushort virtualKey, ushort scan, uint flags) {
    INPUT input = new INPUT(); input.type = 1;
    input.U.ki = new KEYBDINPUT();
    input.U.ki.wVk = virtualKey; input.U.ki.wScan = scan; input.U.ki.dwFlags = flags;
    return input;
  }
  public static bool Click() { return Inject(new INPUT[] { Mouse(0x0002), Mouse(0x0004) }); }
  public static bool Press(ushort virtualKey) {
    return Inject(new INPUT[] { Key(virtualKey, 0, 0), Key(virtualKey, 0, 0x0002) });
  }
  public static bool TypeChar(ushort character) {
    return Inject(new INPUT[] { Key(0, character, 0x0004), Key(0, character, 0x0006) });
  }
  public static bool PointHitsWindow(IntPtr target, int x, int y) {
    POINT point = new POINT(); point.X = x; point.Y = y;
    IntPtr hit = WindowFromPoint(point);
    if (hit == IntPtr.Zero || GetAncestor(hit, 2) != target) return false;
    uint targetPid, hitPid;
    if (GetWindowThreadProcessId(target, out targetPid) == 0 ||
        GetWindowThreadProcessId(hit, out hitPid) == 0) return false;
    return targetPid == hitPid;
  }
}
'@ -ErrorAction Stop

  if ($request.action -eq 'probe') {
    if (-not [Environment]::UserInteractive) { throw 'interactive_desktop_unavailable' }
    if ([AcfGuiNative]::GetForegroundWindow() -eq [IntPtr]::Zero) { throw 'foreground_window_unavailable' }
    Reply $true '' 'windows_gui_available'
    return
  }

  $appName = [string]$request.app
  if ($appName.Length -lt 1 -or $appName.Length -gt 64 -or
      $appName -cne $appName.ToLowerInvariant() -or
      $appName.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -or
      $appName -notmatch '^[a-z0-9][a-z0-9._-]{0,63}$') {
    throw 'invalid_app_name'
  }

  function Foreground([string]$expectedApp, [IntPtr]$expectedHandle = [IntPtr]::Zero) {
    $handle = [AcfGuiNative]::GetForegroundWindow()
    if ($handle -eq [IntPtr]::Zero) { throw 'foreground_window_unavailable' }
    if ($expectedHandle -ne [IntPtr]::Zero -and $handle -ne $expectedHandle) {
      throw 'foreground_window_changed'
    }
    [uint32]$processId = 0
    if ([AcfGuiNative]::GetWindowThreadProcessId($handle, [ref]$processId) -eq 0) {
      throw 'foreground_process_unavailable'
    }
    $actualApp = [System.Diagnostics.Process]::GetProcessById([int]$processId).ProcessName
    if (-not [string]::Equals($actualApp, $expectedApp, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'foreground_app_mismatch'
    }
    return $handle
  }

  if ($request.action -eq 'focus') {
    $candidates = @([System.Diagnostics.Process]::GetProcessesByName($appName) |
      Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and
                     [AcfGuiNative]::IsWindowVisible($_.MainWindowHandle) })
    if ($candidates.Count -eq 0) { throw 'app_main_window_not_found' }
    if ($candidates.Count -ne 1) { throw 'ambiguous_app_main_window' }
    $handle = $candidates[0].MainWindowHandle
    if ([AcfGuiNative]::IsIconic($handle)) { [void][AcfGuiNative]::ShowWindow($handle, 9) }
    [void][AcfGuiNative]::SetForegroundWindow($handle)
    [void](Foreground $appName $handle)
    Reply $true '' 'focused'
    return
  }

  $handle = Foreground $appName
  if ($request.action -eq 'click' -or $request.action -eq 'screenshot') {
    $rect = New-Object AcfGuiNative+RECT
    if (-not [AcfGuiNative]::GetWindowRect($handle, [ref]$rect)) { throw 'window_bounds_unavailable' }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) { throw 'invalid_window_bounds' }
  }

  switch ([string]$request.action) {
    'click' {
      $x = [int]$request.x; $y = [int]$request.y
      if ($x -lt 0 -or $y -lt 0 -or $x -ge $width -or $y -ge $height) {
        throw 'click_outside_window'
      }
      $screenX = $rect.Left + $x; $screenY = $rect.Top + $y
      [void](Foreground $appName $handle)
      if (-not [AcfGuiNative]::PointHitsWindow($handle, $screenX, $screenY)) {
        throw 'click_target_window_mismatch'
      }
      if (-not [AcfGuiNative]::SetCursorPos($screenX, $screenY)) {
        throw 'cursor_move_failed'
      }
      [void](Foreground $appName $handle)
      if (-not [AcfGuiNative]::PointHitsWindow($handle, $screenX, $screenY)) {
        throw 'click_target_window_mismatch'
      }
      if (-not [AcfGuiNative]::Click()) { throw 'mouse_input_failed' }
      Reply $true '' 'clicked'
    }
    'type' {
      $text = [string]$request.text
      if ($text.Length -lt 1 -or $text.Length -gt 1024 -or $text -match '[\x00-\x1F\x7F]') {
        throw 'invalid_text'
      }
      foreach ($letter in $text.ToCharArray()) {
        [void](Foreground $appName $handle)
        if (-not [AcfGuiNative]::TypeChar([ushort][int][char]$letter)) {
          throw 'keyboard_input_failed'
        }
      }
      Reply $true '' 'typed'
    }
    'press' {
      $keys = @{
        ENTER=0x0D; TAB=0x09; ESCAPE=0x1B; BACKSPACE=0x08; DELETE=0x2E;
        UP=0x26; DOWN=0x28; LEFT=0x25; RIGHT=0x27; HOME=0x24; END=0x23;
        PAGEUP=0x21; PAGEDOWN=0x22; F1=0x70; F2=0x71; F3=0x72;
        F4=0x73; F5=0x74; F6=0x75; F7=0x76; F8=0x77;
        F9=0x78; F10=0x79; F11=0x7A; F12=0x7B
      }
      $key = [string]$request.key
      if (-not $keys.ContainsKey($key)) { throw 'unsupported_key' }
      [void](Foreground $appName $handle)
      if (-not [AcfGuiNative]::Press([ushort]$keys[$key])) { throw 'keyboard_input_failed' }
      Reply $true '' 'pressed'
    }
    'screenshot' {
      $file = [string]$request.screenshotPath
      if (-not [System.IO.Path]::IsPathRooted($file) -or
          [System.IO.Path]::GetExtension($file) -ine '.png' -or
          [System.IO.File]::Exists($file) -or
          -not [System.IO.Directory]::Exists([System.IO.Path]::GetDirectoryName($file))) {
        throw 'invalid_screenshot_path'
      }
      if ([long]$width * [long]$height -gt 16777216) { throw 'screenshot_too_large' }
      [void](Foreground $appName $handle)
      $bitmap = New-Object System.Drawing.Bitmap($width, $height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $hdc = $graphics.GetHdc()
        try {
          # PrintWindow draws this HWND only, unlike screen scraping APIs.
          $captured = [AcfGuiNative]::PrintWindow($handle, $hdc, 2)
          if (-not $captured) { $captured = [AcfGuiNative]::PrintWindow($handle, $hdc, 0) }
        } finally { $graphics.ReleaseHdc($hdc) }
        if (-not $captured) { throw 'window_capture_failed' }
        # CreateNew makes the no-overwrite check atomic even if another process
        # races to create the randomized destination after our Exists check.
        $stream = New-Object System.IO.FileStream($file,
          [System.IO.FileMode]::CreateNew,
          [System.IO.FileAccess]::Write,
          [System.IO.FileShare]::None)
        try { $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png) }
        finally { $stream.Dispose() }
      } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
      }
      Reply $true '' 'window_screenshot_saved'
    }
    default { throw 'unsupported_action' }
  }
} catch {
  Reply $false ([string]$_.Exception.Message)
}
`;

const ENCODED_SCRIPT = Buffer.from(WINDOWS_GUI_SCRIPT, 'utf16le').toString('base64');

async function invokePowerShell(request: NativeRequest): Promise<WindowsGuiResult> {
  return new Promise((resolve) => {
    const child = spawn(POWERSHELL_EXE, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_SCRIPT,
    ], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let expired = false;
    let overflow = false;
    let spawnError: string | null = null;
    const timer = setTimeout(() => { expired = true; child.kill(); }, POWERSHELL_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_POWERSHELL_OUTPUT) { overflow = true; child.kill(); }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > MAX_POWERSHELL_OUTPUT) { overflow = true; child.kill(); }
    });
    child.on('error', (error) => { spawnError = error.message; });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(request));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (expired) { resolve({ ok: false, error: 'windows_gui_timeout' }); return; }
      if (overflow) { resolve({ ok: false, error: 'windows_gui_output_too_large' }); return; }
      if (spawnError) { resolve({ ok: false, error: `powershell_unavailable: ${spawnError}` }); return; }
      if (code !== 0) { resolve({ ok: false, error: `powershell_failed: ${stderr.trim().slice(0, 400)}` }); return; }
      try {
        const result = JSON.parse(stdout.trim()) as WindowsGuiResult;
        if (typeof result.ok !== 'boolean') throw new Error('invalid result');
        resolve({ ok: result.ok, error: result.error, detail: result.detail });
      } catch {
        resolve({ ok: false, error: 'invalid_powershell_response' });
      }
    });
  });
}

function validAppName(app: unknown): app is string {
  return typeof app === 'string' && APP_NAME.test(app) && app === app.toLowerCase() &&
    !app.endsWith('.exe') && app.trim() === app;
}

/** A small, closed API. Permission profile / allowlist checks stay above it. */
export class WindowsGuiDriver {
  private readonly platform: NodeJS.Platform;
  private readonly invoke: NativeInvoke;

  constructor(options: WindowsGuiDriverOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.invoke = options.invoke ?? invokePowerShell;
  }

  async probe(): Promise<boolean> {
    if (this.platform !== 'win32') return false;
    try { return (await this.invoke({ action: 'probe' })).ok === true; }
    catch { return false; }
  }

  async run(input: WindowsGuiInput): Promise<WindowsGuiResult> {
    if (this.platform !== 'win32') return { ok: false, error: 'windows_gui_unavailable' };
    if (!input || !validAppName(input.app)) return { ok: false, error: 'invalid_app_name' };
    if (!['focus', 'click', 'type', 'press', 'screenshot'].includes(input.action)) {
      return { ok: false, error: 'unsupported_action' };
    }
    if (input.action === 'click' && (!Number.isSafeInteger(input.x) || !Number.isSafeInteger(input.y) ||
      (input.x as number) < 0 || (input.y as number) < 0)) {
      return { ok: false, error: 'invalid_click_coordinates' };
    }
    if (input.action === 'type' && (typeof input.text !== 'string' ||
      input.text.length < 1 || input.text.length > MAX_TYPE_LENGTH || /[\x00-\x1F\x7F]/.test(input.text))) {
      return { ok: false, error: 'invalid_text' };
    }
    if (input.action === 'press' && !WINDOWS_GUI_KEYS.includes(input.key as typeof WINDOWS_GUI_KEYS[number])) {
      return { ok: false, error: 'unsupported_key' };
    }
    if (input.action === 'screenshot' && (typeof input.screenshotPath !== 'string' ||
      !path.win32.isAbsolute(input.screenshotPath) || path.win32.extname(input.screenshotPath).toLowerCase() !== '.png')) {
      return { ok: false, error: 'invalid_screenshot_path' };
    }
    if (!(await this.probe())) return { ok: false, error: 'windows_gui_unavailable' };
    try { return await this.invoke(input); }
    catch (error) { return { ok: false, error: `windows_gui_failed: ${error instanceof Error ? error.message : String(error)}` }; }
  }
}
