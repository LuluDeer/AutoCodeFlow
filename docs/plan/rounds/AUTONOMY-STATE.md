# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 97 段全绿（Lead 独立复验）** · 工作区仅 W2 在途
**会话**：第 95 轮 · 并行第 31 批

## 本轮落地（HEAD）
1. **单源守卫扩面**（`cc564a91`，**段数 97 不变**）：
   - 判据① 从「类别→**布尔**」扩到「类别→**标签字符串**」（如 `'multicast': 'reserved'`）；键只认契约 `categories.order` 成员、支持有/无引号；**红演示 exit 1 并点名 `[node] …:532 硬编码类别→标签映射 multicast: reserved`**；
   - **新增判据②：兜底常量 ≡ 生成物**（2 条断言：node `DEFAULT_UNLOCKED_UNDER_SWITCH` ≡ 契约 `allowedUnderPrivateNetwork`；admin `ADMIN_LABEL_FALLBACK` ≡ 生成物 `END_LABELS_ADMIN`，逐对排序比对）——**解析修好前真的红过一次**并点名两侧值，证明有牙；
   - **豁免 3 处已进基线**（`meta.exemptBlocks`，运行时打印）：`ADMIN_LABEL_FALLBACK` / `DEFAULT_UNLOCKED_UNDER_SWITCH` / `ALLOWED_UNDER_PRIVATE_FALLBACK`；
   - **反向验证**：标签判据改恒假 ⇒ 同一注入 exit 0（红消失）；还原 ⇒ exit 1；不注入 ⇒ 0。
   - **未纳入（有理由）**：`ADMIN_ADDRESS_CATEGORIES` 与 `AddressRisk` 联合类型**故意不同源**（改成派生＝同义反复，永远绿＝拆掉一道检查）；`CATEGORY_ALIASES` 是归一化表（非第二份「类别→放行」，R91 后仍需存在，建议独立判据）。
2. **第二份真理清扫**（`919289cb`，W3）：清 1 处（`address-category.util.spec.ts` 手抄标签映射 → 改为**读契约 `endLabels.admin`**，保证预言独立于被测实现）；其余 5 条经论证保留（架构性兜底 / 故意不同源 / 归一化表）。
   - **W3 挖出的缺口已被 W1 补上**：「改回手抄副本并把 `multicast` 写回 `reserved`」当时**守卫不咬、只有 spec 红** ⇒ 现在由扩展后的判据① + 判据② 覆盖。
3. **链 97/97 exit 0**（`grep -c` = 97）。

## ⚠ 待定性与机器状态
**R93 全量体检仍在后台跑**（`artifacts/autonomy/R93-guard/full.log`），**admin-api 两态均已 `exit 1`**（151s / 144s），但 **web/node/python/chain 未跑完** ⇒ 尚无基线可比。
**这两个 exit 1 尚未定性**：必须看新 `signal` 字段区分「测试真红」与「被 SIGTERM 杀」。
**机器状态**：本机 swap 已 **98.7%**（W2/W1 均实测），是 SIGTERM 的高概率来源 ⇒ 若判定为 killed，**属环境问题而非代码回归**，要在台账写明，不能记成退步。

## 在途
- **W1**：完成体检后报 `killed` vs `failed` + 真实 delta。
- **W2**：浮空 rejection 纪律（正在改 `settings-page-b0-branches.test.tsx` + `settings/index.tsx`）。

## 待办
1. 收体检定性（**先看 signal，再谈退步**）。
2. 未收口：真机脚本接链（需 CI postgres）；R18-B blocked；ADR-031 步骤 4/5（`execute` 余下审批状态机，**事务边界不跨函数**）；`CATEGORY_ALIASES` 独立判据。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**先看 `signal` 再判退步**（被杀 ≠ 回归）；**静态特征判据要写明它挡不住什么**；**「形似重复、实为独立校验」的点不要合并**（同义反复＝拆检查）；**豁免必须进基线**；**注入源缺失必须报错**；**测量工具会撒谎**；**链必须在无在途改动时跑**；作者中断≠改动作废；一次只改一个文件 + `node --check`/`tsc` + 失败即回滚；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。
