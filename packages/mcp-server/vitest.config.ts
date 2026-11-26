import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // N27：仓库新约定允许 *.spec.ts（本包 tool-search.spec.ts）；
    // 原有 *.test.ts 全部保持 Discoverable，零删除、零行为改动。
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    environment: 'node',
  },
});
