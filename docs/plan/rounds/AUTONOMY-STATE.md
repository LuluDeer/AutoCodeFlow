# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 96 段全绿** · 工作区干净
**会话**：第 91 轮 · 并行第 27 批

## 本轮落地（HEAD）
1. **ADR-034 步骤 1 完成**（`490e2c2d` 单元 A + `39b45cb2` 单元 B）：
   - 契约 `networkPolicy.categories`（+28 行：`order` / `allowedUnderPrivateNetwork` / `endLabels.admin`，**取值全部来自契约既有 `addresses.*.allowedUnderPrivateNetwork`** ⇒ 与三端现行为一致，零行为变化）；
   - 生成器产出**三份**生成物（`apps/{admin-api,executor-node}/src/generated/protocol-categories.ts` + `apps/executor-python/generated/protocol_categories.py`），含「校验先于落盘」；
   - **只让 admin 读**：`address-category.util.ts` 段表改存契约键、新增 `ContractCategory`/`withAdminLabels`/`ADMIN_LABEL_FALLBACK`（**纯模块仍 0 import**）；`safe-http.util.ts` 装配点 import 生成物做类型收窄，对外导出保持粗标签形态。
   - **验收信号命中**：`check:ssrf-three-way-matrix` 标签差异 **= 4**（正是步骤 1 期望值；0 条反而说明派生写错）；`cross-end` **exit 0（74 格）**；行为零变化 **2184 passed**（108 suites）、`tsc` 0；`protocol-sync` 0、drift 0、`size-caps` 0、`guards-wired` 0。
   - **回滚粒度**：`git revert 39b45cb2 490e2c2d`（生成物必须与契约同 commit，否则 `protocol-sync` 必红）；无迁移、node/python 未动 ⇒ 零风险。
2. **实测踩坑（值得记）**：`safe-http.util.ts` 顶层构造 `SSRF_DENY_HOST_PATTERNS` 会撞 `address-category.util.ts` 的**模块循环初始化**（`Cannot access 'address_category_util_1' before initialization`）⇒ 改 **getter 惰性求值**解决。
3. **另一处防御**：`cross-end` 的 admin 探针**自己拼 tables、不引生成物** ⇒ 纯模块需内置 `ADMIN_LABEL_FALLBACK` 兜底（与生成物**逐字同值**，用 2 条用例**双向钉住**）；且**不能**退化成「标签=契约键」——那会让 admin 的私网开关语义**静默失效**。
4. **digest 回填**（`9b19fa9d`）：新增 node 生成物导致 source-digest 漂移，已回填；链复验 **96/96 exit 0**。
5. **姿态结论入文档**（W1，`0e46ec4c`）：`docs/operations.md` 新增「出站姿态：四面对照 · 两层防御 · IP 钉扎」节（1544→1602 行），含 registry 三条依据与重新裁决条件、归一化坑、rebinding 与三端钉扎手段。

## 在途（步骤 2/3 并行）
- **W5**：node 读契约生成物（`address-category.ts` 保持 0 import ⇒ 生成物由调用方注入）；验收 = **标签差异 4 → 0**、`cross-end` 74 格 exit 0、行为零变化。
- **W4**：python 读契约生成物（`network_policy.py`；若不便 import 则内置常量但**必须与生成物逐字一致 + 双向钉住**）；同样看标签差异下降（单独完成可能只降到 2 ⇒ 需如实报剩余哪两端）。
- **W2**：flaky 狩猎（连跑 3 次 web 全量，**禁 retry/禁改断言**）。

## 待办
1. 收 W5/W4 ⇒ 确认**标签差异 4 → 0**（这是 ADR-034 完成的判定），然后复跑全链。
2. ADR-034 步骤 4/5（把 `CATEGORY_ALIASES` 退役 + 契约段成为唯一来源的守卫）。
3. operations.md 的机读判据（W1 建议：三张表 + 四个关键词存在性）。
4. 未收口：真机脚本接链（需 CI postgres）；R18-B blocked。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**中间信号（标签差异数）是验收核心**：4→0 才是正确顺序，提前变 0 说明派生写错；**契约变更必须一步一提交可回滚，且生成物与契约同 commit**；**模块循环初始化用惰性求值**；**兜底常量必须与生成物逐字一致 + 双向钉住**；**「标签=契约键」会让私网开关语义静默失效**；**判据必须能红且红在语义层**；**flaky 不许 retry 掩盖**；**降级/跳过必须显式打印**；**链必须在无在途改动时跑**；作者中断≠改动作废；一次只改一个文件 + `node --check`/`tsc` + 失败即回滚；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。
