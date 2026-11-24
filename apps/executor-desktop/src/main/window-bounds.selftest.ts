/**
 * ②④ 窗口状态记忆 / 多显示器钳位纯决策层 selftest（node:assert，无 Electron）。
 *
 * 钉死的行为：
 *  · 旧形状（仅 width/height/maximized）兼容解析；缺宽高 → null；
 *  · 保存时所在显示器已断开 → 回落主屏（列表首项）工作区；
 *  · 坐标跑出任何可见工作区（拔屏 / 漂移）→ 目标工作区居中；
 *  · 尺寸钳进目标工作区；无保存尺寸 → null；
 *  · 可见性判定：矩形与任一显示器工作区达到最小可操作重叠才算在屏。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import {
  centerInArea,
  intersectsAnyDisplay,
  parseSavedState,
  resolveRestoreBounds,
  type DisplayLike,
} from './window-bounds';

const primary: DisplayLike = { id: '1', workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const secondary: DisplayLike = { id: '2', workArea: { x: 1920, y: 0, width: 1600, height: 1000 } };

function main(): void {
  // ── parseSavedState：兼容旧形状 / 非法输入 ──────────────────
  const legacy = parseSavedState({ width: 1000, height: 800, maximized: true });
  assert.ok(legacy, '旧形状（无 x/y/displayId）可解析');
  assert.equal(legacy!.bounds?.width, 1000, '旧形状保留宽度');
  assert.equal(legacy!.maximized, true, '旧形状保留最大化标志');
  assert.equal(legacy!.displayId, null, '旧形状无显示器 id');

  const full = parseSavedState({ x: 2000, y: 120, width: 900, height: 700, displayId: '2', maximized: false });
  assert.ok(full && full.displayId === '2', '新形状解析显示器 id');

  assert.equal(parseSavedState(null), null, 'null → null');
  assert.equal(parseSavedState('str'), null, '字符串 → null');
  assert.equal(parseSavedState({ height: 800 }), null, '缺宽度 → null');
  assert.equal(parseSavedState({ width: NaN, height: 800 }), null, '非有限宽度 → null');

  // ── 显示器断开回落主屏 ──────────────────────────────────────
  const savedOnSecondary = parseSavedState({ x: 2000, y: 120, width: 900, height: 700, displayId: '2' })!;
  // 副屏已拔掉：列表只剩主屏
  const fellBack = resolveRestoreBounds(savedOnSecondary, [primary]);
  assert.ok(fellBack, '断屏后仍可恢复到主屏');
  assert.ok(fellBack!.x >= 0 && fellBack!.x + fellBack!.width <= primary.workArea.width, '回落矩形落在主屏内');
  assert.ok(fellBack!.y >= 0 && fellBack!.y + fellBack!.height <= primary.workArea.height, '纵向落在主屏内');

  // 副屏还在：恢复到副屏工作区
  const restored = resolveRestoreBounds(savedOnSecondary, [primary, secondary]);
  assert.ok(restored && restored.x >= secondary.workArea.x, '同屏恢复时定位到副屏');

  // ── 坐标跑出可见区 → 目标工作区居中 ─────────────────────────
  const offscreen = parseSavedState({ x: 5000, y: 5000, width: 900, height: 700, displayId: '2' })!;
  const centered = resolveRestoreBounds(offscreen, [primary, secondary]);
  assert.ok(centered, '离屏坐标可恢复');
  assert.ok(centered!.x >= secondary.workArea.x && centered!.x + centered!.width <= secondary.workArea.x + secondary.workArea.width, '离屏矩形被钳回副屏');

  // ── 尺寸钳进工作区 ───────────────────────────────────────────
  const huge = parseSavedState({ x: 2000, y: 120, width: 4000, height: 3000, displayId: '2' })!;
  const clamped = resolveRestoreBounds(huge, [primary, secondary]);
  assert.ok(clamped && clamped.width <= secondary.workArea.width, '超大宽度钳到副屏宽');
  assert.ok(clamped.height <= secondary.workArea.height, '超大高度钳到副屏高');

  // ── 无保存尺寸 → null（调用方回落默认尺寸）─────────────────
  assert.equal(resolveRestoreBounds({ bounds: null, displayId: null, maximized: false }, [primary]), null, '无 bounds → null');
  assert.equal(resolveRestoreBounds(savedOnSecondary, []), null, '无显示器列表 → null');

  // 缺 x/y 的旧形状：在目标工作区居中
  const legacyBounds = resolveRestoreBounds(legacy, [primary]);
  assert.ok(legacyBounds, '旧形状可居中恢复');
  const center = centerInArea(primary.workArea, 1000, 800);
  assert.equal(legacyBounds!.x, center.x, '无位置记录时按主屏居中');

  // ── intersectsAnyDisplay 可见性判定 ────────────────────────
  assert.equal(
    intersectsAnyDisplay({ x: 2000, y: 120, width: 900, height: 700 }, [primary, secondary]),
    true,
    '落在副屏 → 可见',
  );
  assert.equal(
    intersectsAnyDisplay({ x: 5000, y: 5000, width: 400, height: 300 }, [primary, secondary]),
    false,
    '全部显示器之外 → 不可见',
  );
  assert.equal(
    intersectsAnyDisplay({ x: 1880, y: 120, width: 200, height: 700 }, [primary, secondary]),
    true,
    '跨屏边缘重叠仍算可见',
  );

  console.log('window-bounds selftest: all assertions passed');
}

main();
