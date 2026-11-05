# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 95 段全绿** · 工作区干净
**会话**：第 79 轮 · 并行第 17 批收尾

## 本轮落地（HEAD）
1. **装配收敛 + 分类模块零 import**（`fc05ef71`）：删掉 `address-category.util.ts` 唯一那条**无扩展名导入**（`../../generated/protocol-metadata-addresses`），恒拒表与 `isIP` 改**入参**（`buildAddressCategoryTables(isIP, metadataAddresses)`），装配点回到 `safe-http.util.ts`（承担装配、不承担判定）⇒ `grep -c '^import'` = **0**（Lead 独立复核）；**仓外 `require` 实测 exit 0**；`safe-http.util.ts` 462 → **445**；`protocol-sync` 0、三生成物零 diff。
2. **webhook 判据升级为「地址→分类→决定」端到端真跑**（`6afd1264`）：契约 IP 字面量 **24 条 × 开关两态 = 48 判例**，两模块都零 import、走子进程真跑、**不再读源码文本**、也不再需要任何 skip 开关。**红演示**：放宽实现副本 ⇒ exit 1 并点名 `127.0.0.1（契约 loopback）× off ⇒ 契约期望拒绝 / admin 实得放行`；**反向验证三次 exit 齐全**（改恒假 ⇒ 红消失；还原 ⇒ 红；移除副本 ⇒ 绿）。期望值**全部来自契约**（`allowedUnderPrivateNetwork` + `switch.semantics`；`ipv4Mapped` 按契约「完全按内嵌 IPv4 判定」回查）。
   **显式跳过并打印**：2 条主机名形态（`localhost` / `foo.localhost`）属 `safe-http` 主机名同义层，**不静默跳过**。
3. **ADR-035 存量歧义行取证**（W4，零代码改动）：判定 SQL 已固化；本机 dev 库 tasks 99 行，`无 codeSource + 有 applicationId` = 3 行，**其中解析不到 packageUrl（=歧义行）= 0 行**（`psql -v ON_ERROR_STOP=1` ⇒ exit 0，全程 `BEGIN READ ONLY`，**未新建/停止任何容器**）。建议 **自然消化 + 上线前只读审计**，不做一次性脚本（本机存量为 0；新行为是 accept 期同步 400 且不留脏状态）。风险：**不卡队列**（pull 侧补发 failed 回调、预留槽 finally 归还），但定时任务会**反复 400**（可见噪音=自然消化的驱动）。

## 待办（按优先级）
1. **2 条主机名形态仍未覆盖** ⇒ 需 W3 提供零依赖 `isLocalhostSynonym(host)`，W1 再接进判据。
2. **B 路径（`packages/` 真·单源分类表）**：W5 已给方案（A/B/C），B 属 **ADR 级** ⇒ 待立 ADR-036。
3. ADR-034 契约类别表实施（与 2 相关，可能合并为一件事）。
4. 跨端对照判据（ADR-035 步骤 1）：node 侧已有零依赖出口（`b3aac035`），admin 侧已就绪 ⇒ 可接。
5. 未收口：真机脚本接链（需 CI postgres）；R18-B blocked；liveness 覆盖面仅 2 个脚本；flaky 待复发取证。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**判据必须能红**；**对照断言只证「重构未改行为」，须另配独立锚定**（本轮 `fc05ef71` 的教训再证：`::ffff:10.0.0.1` 的段 id 是 `ipv4-rfc1918-10` 而 `isIP`=6 ⇒ 与地址族相关的期望值必须按 `normalizeIpLiteral` 之后推导）；**降级必须显式打印，不许静默跳过**；作者中断≠改动作废；**链必须在无在途改动时跑**；**一次只改一个文件 + `node --check` + 失败即回滚**；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**（用精确 PID）。
