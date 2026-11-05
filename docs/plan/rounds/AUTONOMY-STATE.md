# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `254cd996` · 工作区干净 · 守卫链 **91 段** · `.env` 读入面**四端扫完**
**会话**：第 26 轮已收 · 24 轮产出（R01–R24，67 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；本会话多次自纠假绿/假证据）

## R24 结论（完成，两端分流不同 —— 没有为对称而对称）
- **admin-web：无运行期入口**。`apps/admin-web/src` 无 `dotenv`；`vite.config.ts` 只在**构建期**通过 `process.env.VITE_*` 注入 `import.meta.env`（构建期读 ≠ 运行时读文件）⇒ **钉事实**：守卫断言「web 侧不得出现运行期 `dotenv`/`parseEnv`」。
- **executor-python：有真运行期入口** —— `apps/executor-python/config.py:142-144` 的 `SettingsConfigDict(env_file='.env', …)`：pydantic-settings 在实例化 `Settings()` 时读工作目录 `.env`；该文件未入库但**存在于开发机**（实测含 `ADMIN_API_URL=http://localhost:3105` 指向真 admin-api）；`conftest` 的 `os.environ.setdefault` **拦不住**（框架读文件后已写入 `os.environ`）⇒ 加开关 `config_env_file.py`（三态，键名统一 `SELFTEST_SKIP_ENV_FILE`）+ `config.py` 受约束 + `tests/conftest.py` **默认 `=1`**。
- **判据红→绿**：python —— `env_file_for_settings` 临时恒 `.env` ⇒ **exit 1**（`test_poison_env_is_invisible_when_switch_on` 失败）→ 还原 **4/4 exit 0**，另有【对照】证明关掉开关时**确实**读到污染值；web —— 注入运行期 `dotenv.config()` 探针 ⇒ 守卫 **exit 1 点名该文件** → 删除 ⇒ 0。
- **接链**：**90 → 91 段**，`[91/91]` 可见；删接线 ⇒ `guards-wired` **exit 1 点名**；`guards-wired` 0。
- 回归：`guards:repo` **0（91 段，末行「解析 91 / 执行 91 / diff 空」）** · `docs` 0 · `size-caps` 0 · admin-web **0（2357 passed / 1 skipped）** · python 全量 0。
- 提交：`044dbaa5`(python 开关+spec) · `49bc4aae`(四端守卫+接链+CI) · `34933473`(pytest 夹具默认干净) · `254cd996`(台账)。

## 未收口（按优先级）
1. **`SELFTEST_SKIP_ENV_FILE` 的「默认开不开」四端不一致**（§7.22 P1）：python 夹具**默认开**，admin/node 由自检脚本**显式传** ⇒ 需要一条**统一约定**（自检脚本必须显式传、测试夹具默认开）并让守卫断言，否则将来新自检漏传就静默读开发者 `.env`。
2. **bundle-digest 回填摩擦**：改 `executor-node/src/main.ts` 必触发 `check:desktop-bundle-drift`（第 4 次：R08/R09/R11/R23），每次手工重签；②字节哈希仍待 CI 回填。
3. R18-B 三条重启条件（§7.19，blocked）。
4. 并发轴仍缺：`rolloutBatchClaimId` CAS / `agent_approvals` consume。
5. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3 越界态提示。

## 下轮第一步（R25）
1. `git log -1 --oneline` 确认 `254cd996`（**自己跑**）；
2. 立项 **`env-switch-default-policy`**：写一条**统一约定**并让守卫断言（红→绿）：
   - 约定：**测试夹具默认开**（`=1`）；**生产/自检脚本必须显式传**，不许依赖隐式默认；
   - 判据：先写断言「所有读 `.env` 的端在测试夹具里都 `=1`」+「自检脚本里都显式出现该键」⇒ 旧状态**exit 1**（贴出不满足的位置）→ 补齐后 exit 0；
   - **反向验证**：故意删掉某端夹具的默认值 ⇒ 守卫红并点名；恢复 ⇒ 绿；
   - 接链段数 **91 → 91+k**，`guards-wired` 仍 0，删接线能红；
3. 若发现「显式传」在某些脚本里不现实（例如走 npm 脚本继承）⇒ 在回执里说清替代机制，并让守卫断言的正是那个机制。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、**「恰好碰不到」不是判据（R23）**、**不为对称而对称（R24：两端分流不同才对）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
