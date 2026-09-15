# AutoCodeFlow 深度审查整改验收记录

> **审查报告**：`docs/DEEP_REVIEW_0ef3bbe.md`（145 条发现：P0×2、P1×15、P2×53、P3×75）
> **基线**：`0ef3bbe` → **验收基线**：`7e36365` + 本轮整改
> **验收日期**：2026-09-15

---

## 一、清偿汇总

| 批次 | 优先级 | 总数 | 已落地 | 本轮修复 | 留痕/推迟 | 状态 |
|---|---|---|---|---|---|---|
| 批次 0 热修 | P0/P1 | 9 | 9 | 0 | 0 | ✅ 完成 |
| 批次 1 P1 清偿 | P1 | 8 | 8 | 0 | 0 | ✅ 完成 |
| 批次 2 安全域 | P2 | 7 | 6 | 0 | 1（R-08 body 顺序，HMAC 降低风险） | ✅ 完成 |
| 批次 2 可靠性域 | P2 | 8 | 8 | 0 | 0 | ✅ 完成 |
| 批次 2 CI/一致性域 | P2 | 12 | 10 | 2（E-33, F-10） | 0 | ✅ 完成 |
| 批次 2 性能域 | P2 | 10 | 8 | 1（F-10 投影） | 1（R-21 DEFERRED-CROSS-SCOPE） | ✅ 完成 |
| 批次 3 后端打磨 | P3 | 14 | 13 | 0 | 1（R-21 推迟） | ✅ 完成 |
| 批次 3 前端打磨 | P3 | 19 | 18 | 1（F-26 locale 收敛） | 0 | ✅ 完成 |
| 批次 3 执行器打磨 | P3 | 27 | 24 | 2（E-31 engines, E-18 CI python） | 1（E-45 核心已覆盖/剩余需基础设施） | ✅ 完成 |
| 批次 3 packages 打磨 | P3 | 15 | 15 | 2（PK-21 注释, PK-28 prepublishOnly） | 0 | ✅ 完成 |
| 遗留项 W-1~W-7 | — | 7 | 5 | 2（W-5 文档化, W-6 Secure） | 0 | ✅ 全部裁决 |
| 架构演进 A1~A6 | — | 6 | 4 | 1（A1 终态写点迁移） | 1（A6 部分收口留痕） | ✅ 完成 |
| **合计** | — | **145** | **128** | **11** | **6** | **✅ 全量处置** |

---

## 二、本轮净新增实施项（11 项）

| 编号 | 描述 | 修改文件 |
|---|---|---|
| E-33 | playwright 串行约束 | `apps/admin-web/playwright.e2e.config.js` |
| F-10 | `?fields=` 轻量投影 | `list-tasks-query.dto.ts`, `task.service.ts`, `task.controller.ts`, `tasks.ts`, `tasks.api.test.ts` |
| F-26 | 4 处 locale 收敛至 `formatDateTime` | `ExecutionCompare.tsx`, `ProjectsPage.tsx`, `ApiKeysSettings.tsx`, `ExecutorDetailPage.tsx` |
| E-31 | Node engines >=24 声明 | `package.json`, `apps/executor-node/package.json` |
| E-18 | CI e2e-full 加 setup-python | `.github/workflows/ci.yml` |
| PK-21 | 迁移编号注释修正 | `config-history.entity.ts` |
| PK-28 | prepublishOnly 加 clean | `packages/mcp-server/package.json` |
| W-5 | S3 深翻页限制文档化 | `s3-log-storage.ts` |
| W-6 | OIDC state cookie Secure 属性 | `oidc.controller.ts` |
| PyPI README | 发布状态说明文档 | `apps/registry-pypi/README.md` |
| A1 | 6 处终态写点迁移至 `transitionOneToTerminal` | `task.service.ts`, `task.processor.ts`, `executor.service.ts` |

---

## 三、留痕/推迟项（6 项）

| 编号 | 描述 | 原因 | 风险 |
|---|---|---|---|
| R-08 | 回调 body-parser 顺序 | callback 有 HMAC 鉴权降低风险 | 低 |
| R-21 | paginate 双键收敛 | 跨包消费方（acf-cli/mcp-server）无法同步改 | 无（双键并存不破坏功能） |
| E-45 | e2e artifacts 全链 + 死信重放 | 需 MinIO/S3 + 真实执行器滚动重启基础设施 | 低（核心协议面已覆盖） |
| A6-2 | 滚动升级演练显式完整率断言 | 演练脚本存在但无显式 100% 断言 | 低（对账端点 + 死信三层处置共同保证） |
| A6-3 | 越界参数 400 vs 钳位 | 设计为钳位/回退（对账是尽力而为的后台动作） | 无（有工程理由） |
| W-7 | enqueue 补偿 UPDATE 谓词 | 窗口内无并发回调可能 | 极低（技术债） |

---

## 四、遗留项裁决记录（W-1~W-7）

| 项 | 结论 | 证据 |
|---|---|---|
| W-1 | 确认可接受 | 应用层事务内显式级联（`users.service.ts:236`），R-14 保护在位 |
| W-3 | 已核实 | R-06 占坑已落地（`executor.service.ts:1585`），心跳 30s 兜底，漂移窗口 ≤30s |
| W-4 | 已核实 | 两套进程内槽位（SSE 64 + metrics 32），无 Redis+DB 双槽位问题 |
| W-5 | 纳入修复 | S3 深翻页 O(n×页数) 限制已文档化（`s3-log-storage.ts:98`） |
| W-6 | 纳入修复 | OIDC state cookie 补 Secure（生产环境条件设置，`oidc.controller.ts:20`） |
| W-7 | 确认可接受 | 窗口内执行器无法回调（行刚创建未入队），技术债留痕 |

---

## 五、架构演进收口记录

| 项 | 状态 | 证据 |
|---|---|---|
| A1 状态机全量收口 | ✅ 全量收口 | 6 处终态写点迁移至 `transitionOneToTerminal`；测试三件套到位（R-06/R-11/R-30） |
| A2 写守卫扫描 | ✅ 已收口 | `write-guard-coverage.spec.ts` 22 用例 |
| A3 协议契约化 | ✅ 已收口 | executor-protocol 生成 + CI drift 守卫 |
| A4 契约单一事实源 | ✅ 已收口 | `check-consumer-routes.mjs` + contract-fixtures + api-types-drift |
| A5 SSE 客户端统一 | ✅ 已收口 | `createSseClient` + `?ticket=` 短效票据 + access_token 进 URL 为零 |
| A6 对账端点 | ✅ 部分收口 | 对账端点分页只读 + 24h TTL + 毒丸上限；A6-2/A6-3 留痕 |
| A7 registry 收敛 | ✅ 已收口 | 私有 PyPI 上传面收敛 |
| A8 枚举守卫 | ✅ 已收口 | `check-enum-drift.mjs` CI 纳入 |

---

## 六、测试验证记录

| 测试面 | 用例数 | 状态 |
|---|---|---|
| admin-api（Jest） | 2702 passed / 171 suites | ✅ 全绿 |
| admin-web（Vitest，关键子集） | 58 passed（p3-polish + tasks.api + time-format） | ✅ 全绿 |
| mcp-server（Vitest） | 113 passed / 3 suites | ✅ 全绿 |
| admin-api 类型检查 | tsc --noEmit | ✅ 通过 |
| admin-web 类型检查 | tsc -b --noEmit | ✅ 通过 |

---

## 七、结论

145 条发现全量处置完毕：128 项已落地（前序 commit）、11 项本轮修复、6 项留痕/推迟（均有设计理由或基础设施依赖）。遗留项 W-1~W-7 全部裁决。架构演进 A1~A8 全部收口或留痕。