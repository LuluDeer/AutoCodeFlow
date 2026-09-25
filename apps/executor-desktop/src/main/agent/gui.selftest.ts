import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentGuiSession, GUI_ACTIONS_MAX } from './gui';
import type { GuiDriver, GuiDriverInput } from './gui';
import { normalizeAllowedApp } from './permission-profile';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',
  'base64',
);

class FakeDriver implements GuiDriver {
  available = true;
  calls: GuiDriverInput[] = [];
  async probe(): Promise<boolean> { return this.available; }
  async run(input: GuiDriverInput): Promise<{ ok: boolean; detail?: string }> {
    this.calls.push(input);
    if (input.screenshotPath) fs.writeFileSync(input.screenshotPath, PNG_1PX);
    return { ok: true, detail: `app=${input.app}` };
  }
}

async function main(): Promise<void> {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-gui-'));
  try {
    const driver = new FakeDriver();
    const session = (overrides: Partial<ConstructorParameters<typeof AgentGuiSession>[0]> = {}) =>
      new AgentGuiSession({
        workspaceRoot, driver,
        allowedApps: ['Notepad.exe'], sopCapabilities: ['gui'], hostAccess: 'app-scoped',
        ...overrides,
      });

    // 即使直接调用 run 也不能跳过 start 的后端和权限探测。
    const bypass = session();
    assert.equal((await bypass.run({ action: 'click', app: 'notepad', x: 1, y: 1 })).ok, false);
    assert.equal(driver.calls.length, 0);

    assert.equal((await session({ hostAccess: 'none' }).start()).ok, false);
    assert.equal((await session({ sopCapabilities: [] }).start()).ok, false);
    assert.equal((await session({ allowedApps: [] }).start()).ok, false);
    driver.available = false;
    assert.equal((await session().start()).ok, false);
    driver.available = true;
    assert.equal(driver.calls.length, 0, '任一道启动闸拒绝后都不调用 native driver');

    assert.equal(normalizeAllowedApp(' C:\\Windows\\notepad.exe '), null, '路径不得作为应用名');
    assert.equal(normalizeAllowedApp('notepad*'), null, '通配符不得作为应用名');
    assert.equal(normalizeAllowedApp('NOTEPAD.EXE'), 'notepad');

    const gui = session();
    assert.equal((await gui.start()).ok, true);
    for (const bad of [
      { action: 'focus', app: 'cmd' },
      { action: 'shell', app: 'notepad' },
      { action: 'click', app: 'notepad', x: -1, y: 5 },
      { action: 'click', app: 'notepad', x: 1.5, y: 5 },
      { action: 'type', app: 'notepad', text: 'x'.repeat(1025) },
      { action: 'press', app: 'notepad', key: 'ctrl+v' },
      { action: 'wait', app: 'notepad', ms: 5001 },
    ]) {
      assert.equal((await gui.run(bad)).ok, false, `应拒绝 ${JSON.stringify(bad).slice(0, 80)}`);
    }
    assert.equal(driver.calls.length, 0, '畸形/越权动作不得触发 native driver');

    assert.equal((await gui.run({ action: 'focus', app: 'Notepad.EXE' })).ok, true);
    assert.equal((await gui.run({ action: 'click', app: 'notepad', x: 10, y: 20 })).ok, true);
    assert.equal((await gui.run({ action: 'type', app: 'notepad', text: '你好' })).ok, true);
    assert.equal((await gui.run({ action: 'press', app: 'notepad', key: 'ENTER' })).ok, true);
    assert.equal((await gui.run({ action: 'press', app: 'notepad', key: 'escape' })).ok, true);
    const shot = await gui.run({ action: 'screenshot', app: 'notepad' });
    assert.equal(shot.ok, true);
    assert.match(shot.screenshotPath ?? '', /^screenshots\/gui-[0-9a-f-]+\.png$/);
    assert.equal(fs.existsSync(path.join(workspaceRoot, shot.screenshotPath ?? '')), true);
    assert.deepEqual(driver.calls.map((call) => call.app), Array(6).fill('notepad'));
    assert.equal(driver.calls[4].key, 'ESCAPE', 'escape 应映射到 Win32 ESCAPE 虚拟键');
    assert.equal(GUI_ACTIONS_MAX, 40);

    let currentAuthorization = true;
    const hot = session({ isAppStillAllowed: () => currentAuthorization });
    assert.equal((await hot.start()).ok, true);
    assert.equal((await hot.run({ action: 'focus', app: 'notepad' })).ok, true);
    const beforeRevoke = driver.calls.length;
    currentAuthorization = false;
    const revoked = await hot.run({ action: 'click', app: 'notepad', x: 1, y: 1 });
    assert.equal(revoked.ok, false, '保存配置撤销授权后下一动作必须立即停止');
    assert.equal(driver.calls.length, beforeRevoke, '热撤销后不得再触发 native driver');

    console.log('agent/gui selftest: authorization, shape, window-scoped screenshot passed');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

void main();
