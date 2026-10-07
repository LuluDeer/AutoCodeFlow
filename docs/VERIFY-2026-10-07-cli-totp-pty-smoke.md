# VERIFY：CLI TOTP 交互路径真机 smoke（战役遗留 #5 收口）

- **日期**：2026-10-07（Linux 侧会话）
- **对象**：`packages/acf-cli` login 交互全路径（URL prompt → Username → 隐藏
  Password → TOTP 6 位码 prompt），真实 PTY 驱动（非管道、非 mock stdin）
- **结论**：**PASS（正例 exit 0 / 负例 exit 3）**，且**抓出并修复一个 P1**：
  CLI 默认 URL（`http://localhost:3105`，无 `/api`）对标准部署 100% 404
  （admin-api `setGlobalPrefix("api")`）；mcp-server 同源同病同修。

## ★ P1：默认 URL 缺 `/api` 前缀

- **实测**：PTY smoke 首轮 `POST http://127.0.0.1:3105/auth/login` → 404
  （服务端路由在 `/api/auth/login`；curl 双路径对照 404 vs 400 实证）。
- **生态对照**：autoapp-skill 文档约定传 `:3105/api`；node-sdk 有
  `stripTrailingApiSuffix` 双形态归一先例；acf-cli 默认 prompt 与
  mcp-server 默认 env（`AUTOCODEFLOW_API_URL=http://localhost:3105`）都不带
  `/api` 且路径裸拼——开箱即用形态从未真正可用过（单测 mock 了 client，
  因此 vitest 全绿也测不到，正是「真机 smoke」存在的意义）。
- **修法（严格改进，不破坏 `/api` 用户）**：请求期归一——baseUrl 缺 `/api`
  尾段时补上，已带则逐字节原样。acf-cli `client.ts normalizeApiBase`（挂在
  axios baseURL）+ mcp-server `api.ts normalizeApiBase`（挂在 fetch URL）。
- **已知边界（已注明）**：经「剥 `/api` 前缀」反代且喂根地址的部署会产生
  双前缀 404——此类部署应传剥前缀后的源站地址。

## smoke 环境搭建（一次性，可复现）

1. 一次性容器：postgres:16-alpine（15434）/ redis:7-alpine（16381）。
2. admin-api：`npm run build` → 迁移（`npx --no-install
   typeorm-ts-node-commonjs migration:run -d src/data-source.ts`，env 覆盖
   DB_*/REDIS_* 指向容器）→ `node dist/main.js`（默认端口 3105，dev 态）。
3. TOTP 账号：admin 登录 → `POST /auth/totp/setup` 取 Base32 secret（**必须
   一次落盘**——enable 后 secret 不再返回，本轮曾因变量丢失整库重来）→
   本地 TOTP 生成器（stdlib crypto HMAC-SHA1/6 位，无新依赖）→
   `POST /auth/totp/enable`。
4. PTY 驱动：`script -qec "ACF_CONFIG_DIR=<tmp> npx tsx src/index.ts login"`
   （util-linux `script` 分配真实 pty，子进程 `process.stdin.isTTY === true`
   成立，readline 交互路径真实激活）；输入按行预喂（pty 缓冲保序：URL →
   username → password → code）。

## 断言与证据

| 步骤 | 断言 | 结果 |
|---|---|---|
| 正例 | `✔ Logged in successfully` + `Token: [set]` + `Refresh: [set]` + exit 0 | ✅ |
| 隐藏密码 | 输出中无密码回显（maskEcho 在真 TTY 下生效） | ✅ |
| TOTP 交互 prompt | `TOTP code (6 digits):` 出现并接受输入 | ✅（遗留 #5 验收点） |
| 负例 | 错码 → `401 Unauthorized: Invalid TOTP code` → **exit 3**（ui.ts EXIT_CODES 契约） | ✅ |
| 修复生效 | 默认 URL（prompt 直接回车）登录成功 | ✅（修复前 404） |

## 单测护栏（新增）

- acf-cli `client.test.ts`：`normalizeApiBase` 7 断言（裸域/多斜杠/已带
  /api/公网域四形态）；全套件 9 文件 250 用例绿。
- mcp-server `api.test.ts`：两处旧断言按新契约更新（原断言钉的是 404 行为）
  + normalizeApiBase 随 apiRequest 路径断言覆盖；全套件 3 文件 152 用例绿。
- 双包 tsc 零错误。

## 复现者必读

- `script -qec` 的 `-e` 才回传子进程退出码；本验证用外层 `echo $?` 读
  script 自身（bash 场景下等价，`-e` 更严谨）。
- 预喂输入依赖 pty 缓冲保序，各行间 `sleep` 只为对齐 prompt 节奏；TOTP 码
  在喂入前一刻生成（30s 窗口余量）。
- 现场已清理（容器/临时目录/secret 文件）；admin 为一次性容器内用户。
