#!/usr/bin/env node
/**
 * 版本号同步脚本
 * 用法：node scripts/bump-version.mjs <新版本号>
 * 示例：node scripts/bump-version.mjs 1.4.3
 *
 * 自动同步所有需要改版本号的地方：
 * 1. apps/executor-desktop/package.json
 * 2. packages/mcp-server/package.json
 * 3. packages/autocodeflow-node-sdk/package.json
 * 4. packages/autoflow-sdk/pyproject.toml
 * 5. packages/autoflow-sdk/autoflow_sdk/__init__.py
 *
 * 注意：mcp-server 的版本号已从 package.json 动态读取，无需手动修改 src/index.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// 版本号格式验证（semver: major.minor.patch）
const VERSION_REGEX = /^\d+\.\d+\.\d+(-[\w.-]+)?$/;

function main() {
  const newVersion = process.argv[2];

  if (!newVersion) {
    console.error('❌ 请提供新版本号');
    console.error('用法：node scripts/bump-version.mjs <新版本号>');
    console.error('示例：node scripts/bump-version.mjs 1.4.3');
    process.exit(1);
  }

  if (!VERSION_REGEX.test(newVersion)) {
    console.error(`❌ 版本号格式错误：${newVersion}`);
    console.error('正确格式：major.minor.patch（如 1.4.3）');
    process.exit(1);
  }

  console.log(`🚀 开始同步版本号 → ${newVersion}\n`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  // ── 1. package.json 文件（JSON，直接改 version 字段）──
  const packageJsonFiles = [
    'apps/executor-desktop/package.json',
    'packages/mcp-server/package.json',
    'packages/autocodeflow-node-sdk/package.json',
  ];

  for (const relPath of packageJsonFiles) {
    const absPath = path.join(rootDir, relPath);
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      const pkg = JSON.parse(content);
      const oldVersion = pkg.version;

      if (oldVersion === newVersion) {
        console.log(`⏭️  跳过 ${relPath}（已是 ${newVersion}）`);
        skipped++;
        continue;
      }

      pkg.version = newVersion;
      fs.writeFileSync(absPath, JSON.stringify(pkg, null, 2) + '\n');
      console.log(`✅ ${relPath}: ${oldVersion} → ${newVersion}`);
      updated++;
    } catch (err) {
      console.error(`❌ ${relPath}: ${err.message}`);
      failed++;
    }
  }

  // ── 2. pyproject.toml（正则替换 version = "x.x.x"）──
  const pyprojectPath = path.join(rootDir, 'packages/autoflow-sdk/pyproject.toml');
  try {
    let content = fs.readFileSync(pyprojectPath, 'utf-8');
    const match = content.match(/^version = "([^"]+)"/m);
    const oldVersion = match ? match[1] : 'unknown';

    if (oldVersion === newVersion) {
      console.log(`⏭️  跳过 pyproject.toml（已是 ${newVersion}）`);
      skipped++;
    } else {
      content = content.replace(/^version = "[^"]+"/m, `version = "${newVersion}"`);
      fs.writeFileSync(pyprojectPath, content);
      console.log(`✅ pyproject.toml: ${oldVersion} → ${newVersion}`);
      updated++;
    }
  } catch (err) {
    console.error(`❌ pyproject.toml: ${err.message}`);
    failed++;
  }

  // ── 3. python __init__.py（正则替换 __version__ = "x.x.x"）──
  const initPyPath = path.join(rootDir, 'packages/autoflow-sdk/autoflow_sdk/__init__.py');
  try {
    let content = fs.readFileSync(initPyPath, 'utf-8');
    const match = content.match(/^__version__ = "([^"]+)"/m);
    const oldVersion = match ? match[1] : 'unknown';

    if (oldVersion === newVersion) {
      console.log(`⏭️  跳过 __init__.py（已是 ${newVersion}）`);
      skipped++;
    } else {
      content = content.replace(
        /^__version__ = "[^"]+"/m,
        `__version__ = "${newVersion}"`
      );
      fs.writeFileSync(initPyPath, content);
      console.log(`✅ __init__.py: ${oldVersion} → ${newVersion}`);
      updated++;
    }
  } catch (err) {
    console.error(`❌ __init__.py: ${err.message}`);
    failed++;
  }

  // 注意：mcp-server/src/index.ts 已改为从 package.json 动态读取版本号，无需手动修改

  // ── 汇总 ──
  console.log(`\n📊 汇总：`);
  console.log(`   ✅ 更新：${updated} 处`);
  console.log(`   ⏭️  跳过：${skipped} 处`);
  console.log(`   ❌ 失败：${failed} 处`);

  if (failed > 0) {
    process.exit(1);
  }

  console.log(`\n🎉 版本号同步完成！`);
  console.log(`\n下一步：`);
  console.log(`  1. git add -A`);
  console.log(`  2. git commit -m "chore(release): bump version ${newVersion}"`);
  console.log(`  3. git push origin develop`);
  console.log(`  4. 合并到 main，打 tag v${newVersion} 触发发布`);
}

main();
