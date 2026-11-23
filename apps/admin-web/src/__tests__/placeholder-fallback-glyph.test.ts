/**
 * P3 占位符残留（2026-11-23 交接 2.6）：空值回落字形收敛。
 *
 * ## 口径
 * 中台读面的「空值占位」统一用全角破折号 `—`（与 `utils/timeFormat.ts` 的
 * FALLBACK 同源；2cabf9b6 一轮已在 30+ 文件完成收敛）。本守卫钉住上一轮
 * 漏网的 6 个文件：空值回落不得再出现半角连字符 `-`。
 *
 * ## 刻意保留的例外（不在本守卫范围）
 *  - `utils/artifactSize.ts`：非法字节数回落 `-`，其契约由 artifacts-list
 *    单测钉死（`formatArtifactSize(-1)` / `NaN` === `'-'`），属工具函数
 *    边界契约，不是读面空值占位。
 *  - `locales/{zh,en}.ts` 的 `taskList.nextRun.none`：`-` 是 i18n 词条
 *    文案本身，由任务列表既有测试钉住。
 *  - 文件名清洗（slug sanitize）、负号解析等非占位用途的 `-` 字面量。
 *
 * ## 反证（有牙）
 * 把任一目标文件里的 `'—'` 回落改回 `'-'`，本守卫对应断言立即变红；
 * 逐字节还原后转绿。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 本轮收敛过的读面文件：空值回落一律 `—`，不得残留半角 `-` 占位。 */
const TARGET_FILES = [
  'components/ExecutionCompare.tsx',
  'components/ExecutionRetryChain.tsx',
  'pages/ApplicationDetailPage.tsx',
  'pages/settings/EventSubscriptionsSettings.tsx',
  'pages/settings/index.tsx',
  'pages/task-detail/version-view-models.tsx',
] as const;

describe('P3 占位符残留：目标读面文件无半角 `-` 空值回落', () => {
  for (const rel of TARGET_FILES) {
    it(`${rel} 不含半角 '-' 空值回落字面量`, () => {
      const src = stripComments(read(rel));
      const hits = src.match(/['"]-['"]/g) ?? [];
      expect(hits).toEqual([]);
    });
  }
});
