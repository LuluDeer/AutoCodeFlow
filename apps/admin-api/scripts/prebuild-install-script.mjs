#!/usr/bin/env node
// admin-api 的 prebuild 包装：调用仓库根 scripts/gen-install-script-content.mjs
// 重新生成 install-script.content.ts（E-38：scripts/install.sh 是唯一事实源）。
//
// 为什么需要这层包装：prebuild 原先直接写 `node ../../scripts/gen-install-script-content.mjs`，
// 但 admin-api 的 Docker 构建上下文是 apps/admin-api（见 .github/workflows/ci.yml 的
// docker-multiarch-build matrix：context: apps/admin-api），镜像里 /app 即 apps/admin-api
// 的内容，`../../scripts` 解析为 /scripts —— 不存在，构建阶段直接
// `Error: Cannot find module '/scripts/gen-install-script-content.mjs'` 失败
// （E-38 引入 prebuild 后 admin-api 镜像双架构构建即红）。
//
// 生成物 install-script.content.ts 是**入库**文件，Docker 构建并不需要重新生成它；
// 仓库根不可达时跳过即可——两副本是否同步由 CI 的 E-38 守卫 job
// （重跑生成器 + `git diff --exit-code`）把关，不靠 Docker 构建。
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// apps/admin-api/scripts/ → 仓库根（上三级）
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const generator = resolve(repoRoot, 'scripts', 'gen-install-script-content.mjs');

if (!existsSync(generator)) {
  console.log(
    `[prebuild] 跳过 install-script.content.ts 重生成：未找到 ${generator}` +
      '（Docker 构建上下文仅含 apps/admin-api；该产物已入库，同步性由 CI 的 E-38 守卫把关）。',
  );
  process.exit(0);
}

execFileSync(process.execPath, [generator], { stdio: 'inherit' });
