# AUTONOMY-STATE — 状态卡（R237 收尾交接版 · ≤50 行）

**基线**：`510320d1`（R236，`git log -1`）· 本轮落地 **1 个提交**（R236 修 web 末处失败）+ R237 调查轮（0 提交，如实留档）· **守卫链 113 段，本机实测 113/113 = exit 0**（R231 装齐依赖后**首次完整跑通**；此前「106 段」是缺 node_modules 造成的假缺口）
**会话**：第 237 轮 · 并行第 163 批 · **单靶**

## 本轮落地（R236–R237 · 1 提交 + 1 调查轮）

**★ R236：修掉 `test:web` 唯一失败 —— antd Modal portal 残留。**
- 症状：全量跑 1 失败、**单文件跑却全绿** —— `Found multiple elements with the text: 先查看未结束的指派`。
- 根因：antd `Modal.confirm` 的 content 渲染进**独立 portal**，`Modal.destroyAll()` 是**异步**的
  ⇒ 同一用例内此前开过的 portal 可能仍在 DOM ⇒ `findByText`（要求唯一）报 multiple。
  **测试隔离缺陷，不是产品缺陷**。
- 修法：`findAllByText(...)` 取**最后一个**（portal 按打开顺序追加）——**不是放宽断言**：
  下面仍断言 `assignments` 被调用、`cancelAssignments` 未被调用。
- 验证：`test:web` **exit 0**，329 文件 **2579 例**通过。

**★ R237（调查，0 提交）：`test:node` 28 个失败 —— 查清两层成因，但两次修法**都比基线差**，已回退。**
- **已证实的第一层**：全集中在 `execute.spec.ts`（其余 63 套件绿）。实证
  `jest.clearAllMocks()` **不清 `mockImplementationOnce` 队列**（一次性用例验证：注册 Once →
  clearAllMocks → 调用，**仍返回 `once-1`**）。该文件 **31 处**用 Once ⇒ 没消费掉的那条被
  **下一个用例**吃掉 ⇒ 「一堆无关用例同时红、单跑全绿」。
- **尝试与回退**：`mockReset()` ⇒ 28→**20** 但 `buildNpmRcContent` 8 例转红（它连 automock 默认实现一起清）；
  改 `mockImplementation(()=>undefined)` ⇒ 反而 **28→38**。**两个方向都更差 ⇒ 回退**，停在基线 28。
- **剩下成因（未查完）**：DNS 劫持（P2-2/B-01/R70）+ `killRunningTaskProcesses` 的 **5001ms 超时** + `buildNpmRcContent` 的 mock 交互 —— **不是同一根因**，需逐类处理。

## 验证（R236–R237 · 真实 exit）
- `test:web` **0**（329 文件 2579 例，此前 1 failed）
- `execute.spec.ts` 回到基线 **28 failed**；两次尝试 **20 / 38 均比基线差 → 已回退**；工作区干净

## 教训（444–445，接 443）
- **444「`jest.clearAllMocks()` 不清 `mockImplementationOnce` 队列」** —— 这是顺序污染的常见源头，症状极像「一堆无关用例同时坏」。判据：某 spec 大量用 Once 而 `beforeEach` 只有 `clearAllMocks()` 就有风险。验证法：注册一条 Once → `clearAllMocks()` → 调用，仍返回 Once 的值即证实。
- **445「`mockReset()` 与 `mockImplementation(()=>undefined)` 不是等价替换」** —— 前者连 automock 的**默认实现**一起清掉 ⇒ 依赖「默认 no-op」的用例集体变红（实测：`mockReset` 28→20 却**新增** 8 红；换 `mockImplementation` 又涨到 38）。⇒ **改善的与恶化的是两组用例，必须分别度量**；任一方向比基线差就先回退，别在「部分变好」上叠加。

## 剩余 backlog（`§7.0` 主表 **3** 条 · 全部外部阻塞）
`ci-pg-race-unverified` · `web-flake-not-reproduced`（不声称根除）· `release-notice-ops`。

## 候选池（已排序）
1. 判据⑨盲区（M，R168 只登记不立项 —— 需先定「跟随变量」的判据形态，不是纯执行项）。

> **已裁定不做（R226）**：「五个徽标低频自动刷新」**早已存在** —— 页面 15s 轮询
> （`AgentSessionsPage.tsx:410-417`）+ 递增在 `load()` 成功路径（`:353`）⇒ 徽标随列表每 15s 刷。

**里程碑**：前端 P3 九条 · `no-explicit-any` 73→0 · 「读失败渲染成没有」清零 · **接管台五徽标全部接线完成** · 五判据严格互补。

## 方法学（累积 399–445，全文见 `AUTONOMY-STATE-ARCHIVE.md` / `PLAN-CLAIMS`）
**445** `mockReset` ≠ `mockImplementation`（改善与恶化是两组用例） · **444** `clearAllMocks` 不清 Once 队列 · **443** 换解释器前先问「依赖在哪」 · **442** CI 更宽松时缺陷只在用户那边 · **441** `134`(abort) 与 `137`(SIGKILL) 是两个世界 · **440** 用户描述的症状比第一层归因更值钱 · **439** 补上环境后要重跑「被它挡住的所有门禁」 · **438** 「本机跑不了」要分清仓库问题还是环境问题· **437** 负例要用「只在宽实现下才红」的形态 · **436** 判据文档与实现不一致时实现往往更宽（会误报） · **435** 不能进自动门禁的验证资产要有「它还在」的静态守卫 · **434** 「未登记 N 个」要拆成真欠账/做不到/文案误报三类 · **433** 登记要能说出「被谁读、读来干什么」，说不出就是装饰 · **432** 候选池「待定」项先用证据判定是不是缺口（它可能早被做掉）· **431** 判据输入要覆盖「内联」与「引用」两种写法 · **430** 修完一处门禁缺口要推广扫全部同类 ·
**429** 「两个门禁像同一件事」时要证明它们不是 · **428** 纪律能机械化就别只写在文档里 ·
**427** 给 @Injectable 加依赖默认 `@Optional()`+末尾 · **426** 套件编译失败不计入 `Tests:`（要另看 Suites 数与 spec tsc）·
**425** 探针断言不能跨两行日志 `&&` · **424** 降级日志要三态（「想干但干不动」最容易被静默）·
**426–399 见 `AUTONOMY-STATE-ARCHIVE.md` / `PLAN-CLAIMS`（此处只留最近 16 条，避免状态卡被方法学吃掉）。**
