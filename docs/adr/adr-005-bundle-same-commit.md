# ADR-005: bundle 与源码同 commit

状态：Accepted（W-18 闭环，round-12）

## 背景

executor-desktop 内置 `resources/executor-node/index.js`（ncc 产物）。源码改了不重打 → 桌面包携带旧执行器行为，且 desktop-bundle-drift 守卫返程红（round-15 实际发生两次）。

## 决策

`apps/executor-node/src` 的任何改动与 ncc 重打必须**同一 commit**；CI `desktop-bundle-drift` job 离线重打 + git diff 把关（ncc 0.44 字节确定性已预验证，禁网可跑）。

## 后果

- 源码→产物一致性由 CI 强制，不依赖人的记忆。
- 代价：executor-node 改动的 commit 必须能跑 bundle 脚本（本地或 CI 修复窗口）。
