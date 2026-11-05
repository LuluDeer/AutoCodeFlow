# 发版公告：执行器中台出站 SSRF 闸收紧（develop，未发布）

> **受众**：执行器运维 / 中台运维 · **影响版本**：`develop`（未发布）· **最后核对**：2026-11-06
>
> 依据：本文所有行为结论均对得上 `docs/UPGRADING.md` §10（Lead 已写）、`docs/adr/adr-032-python-switch-posture-parity.md`、`docs/adr/adr-033-admin-webhook-posture-parity.md` 与 `docs/adr/adr-034-network-category-table-in-contract.md`。行为引用处均标注「依据」。

## 1. 一句话影响面

**开关开启时不再「放行一切」**：出站闸只放行 `privateIPv4`（RFC1918 三段），其余地址类别（`loopback`、`linkLocal`、`cgnat`、`unspecified`、`multicast`、`reserved`，含 `ipv4Mapped` 包裹的受限地址）**在任何开关状态下恒拒**。（依据：UPGRADING §10.1）

## 2. 谁会被打断

**判据只有一条**：你**开了**对应面的 `allowPrivateNetwork` 开关，**且**目标地址落在下面四类里。（依据：UPGRADING §10.2、ADR-033 §3.2）

> 内网自建 GitLab / Gitea（`10.x` / `172.16-31.x` / `192.168.x`）**不受影响**——`privateIPv4` 仍然放行。（依据：UPGRADING §10.2）

### 2.1 现场一：Tailscale / CGNAT 地址（`100.64.0.0/10`）

用 Tailscale（或任何 `100.64/10` 组网）把执行器/中台连到内网服务的部署。此前开关一开，`100.64.x.x` 可通；升级后属 `cgnat` 类，**恒拒**。（依据：UPGRADING §10.1 表格 `cgnat` 行）

### 2.2 现场二：同机回环接收器（`127.0.0.1` / `[::1]` / `localhost`）

通知渠道、事件订阅 webhook、OIDC issuer、AI 供应商端点指向**本机**监听端口的部署（单机部署里很常见）。此前开关一开即放行；升级后属 `loopback` 类，**任何开关状态都拒**。（依据：UPGRADING §10.1、ADR-033 §3.2「最典型的受影响形态」）

### 2.3 现场三：`0.0.0.0` 形态目标

目标地址写成 `http://0.0.0.0:<port>`（本意是「本机任意网卡」）的配置。属 `unspecified` 类，**恒拒**——这类写法本就没有可审计的目标语义，建议改成具体地址。（依据：UPGRADING §10.1 表格 `unspecified` 行）

### 2.4 现场四：benchmark 保留段（`198.18.0.0/15`）

把 `198.18/15` 当内部实验网段使用的部署（常见于网络设备厂商的基准测试环境）。属 `reserved` 类，**恒拒**。（依据：UPGRADING §10.1 表格「`reserved`（benchmark 段）」行）

> 补充：`198.18/15` 在 node / python 归 `reserved`，在 admin 归 `restricted`——**类别名不同、放行结论一致**，不构成两种承诺。（依据：ADR-033 §3.3 附注）

## 3. 升级步骤

按顺序执行；每步都可独立验证。

```text
① 盘点：找出当前开着 allowPrivateNetwork 的面
② 分类：把这些面的目标地址按「四类现场」过一遍
③ 改造：能换地址的先换地址（内网自建服务改走 RFC1918 主机名/IP）
④ 升级：按 docs/UPGRADING.md §3 的执行器升级流程发版
⑤ 验证：跑 §5 自检清单
```

### 3.1 盘点开关

中台侧（admin）四个开关，任意一个为 `true` 都意味着该面在旧版本下「放行一切」：

```bash
grep -nE '^(EXECUTOR_ALLOW_PRIVATE_NETWORK|EVENT_WEBHOOK_ALLOW_PRIVATE_NETWORK|NOTIF_ALLOW_PRIVATE_NETWORK|OIDC_ALLOW_PRIVATE_NETWORK|AI_ALLOW_PRIVATE_NETWORK)=' .env 2>/dev/null
```

（键名依据：`apps/admin-api/src/config/configuration.ts` 的 `executor` / `eventWebhook` / `notification` / `oidc` / `ai` 配置段）

执行器侧（node）：

```bash
grep -n 'EXECUTOR_ALLOW_PRIVATE_NETWORK' .env apps/executor-node/.env 2>/dev/null
```

（依据：UPGRADING §10.3 命令 ①）

### 3.2 改造无法放行的目标

- **同机接收器**（现场二）：把接收器从 `127.0.0.1` 挪到执行器/中台所在主机的 RFC1918 地址（`192.168.x.x` 等），或改用同宿主机的容器网络地址但不落在 loopback；
- **Tailscale 现场**（现场一）：改用 RFC1918 直连路径；若拓扑上只能走 Tailscale，**保持旧版本不升级**（见 §4）；
- **`0.0.0.0` 写法**（现场三）：改为具体可达地址；
- **`198.18/15`**（现场四）：改为 RFC1918 地址。

> 注意：**不要**为了让出站通过而关闭 `allowPrivateNetwork`——那会连 RFC1918 一起拒掉，把「内网自建 GitLab」这类正常拓扑一并打断。

### 3.3 发版

按 `docs/UPGRADING.md` §3「执行器升级」与 §9「v2.0.0 → develop 增量」执行。python 执行器**无需**再配灰度阀：`PY_EXECUTOR_SWITCH_POSTURE_STRICT` 已删除，默认即新姿态。（依据：ADR-032 Step 5）

## 4. 回滚

### 4.1 可回滚

| 动作 | 命令 | 效果 |
|---|---|---|
| 执行器出站闸（A7） | `git revert <A7-commit>` | 开关语义恢复为「开启 ⇒ 放行一切」（依据：UPGRADING §10.4） |
| admin webhook 面（R66） | `git revert <R66-commit>` | 四个 `*.allowPrivateNetwork` 回到旧放行范围（依据：ADR-033 §4 第 1 条） |
| 降级姿态（**不是等价回滚**） | 把 `NOTIF_/EVENT_WEBHOOK_/OIDC_/AI_ALLOW_PRIVATE_NETWORK` 置 `false` | 立即回到「除 public 全拒」，比旧姿态**更严**（依据：ADR-033 §4 第 2 条） |

### 4.2 不可回滚（或不该回滚）

1. **python 灰度阀已退役**：`PY_EXECUTOR_SWITCH_POSTURE_STRICT` 已从代码删除，**没有运行期开关**可切回宽松姿态；要回到旧行为只能 `git revert` 并发版重启。（依据：ADR-032 Step 5）
2. **node gitRepo 的 fail-closed 修复**：R70 起「scp-like 裸主机」与「异常 userinfo」不再绕过校验。**这是修安全漏洞，回滚它等于重新打开 fail-open 通道**——不建议回滚。（依据：`apps/executor-node/src/git-repo-network-policy.ts` 的 R70 注释）
3. **已拒绝的既有任务数据未变**：本变更**无 schema 变更、无数据迁移、无写库动作**，故也**没有补偿动作**可做；历史执行记录保持原样。（依据：ADR-033 §4 第 1 条）

## 5. 自检清单

按顺序复制执行；每条都给出**预期**结果。

### 5.1 列出「当前开着豁免」的面

```bash
grep -nE '^[A-Z_]+ALLOW_PRIVATE_NETWORK=true' .env 2>/dev/null
```

预期：输出为空 + 退出码 1（全部关闭，处于最严格姿态）；有输出则逐条按 §2 核对目标地址，并重点看 §2 的四类现场。

> 注意用 `^[A-Z_]+` 锚定行首：`# 私网地址…还需设 EXECUTOR_ALLOW_PRIVATE_NETWORK=true` 这类**注释**会被无锚定的 grep 误命中。

### 5.2 确认 python 灰度阀已退役

```bash
grep -rn 'PY_EXECUTOR_SWITCH_POSTURE_STRICT' apps/executor-python --include=*.py | grep -v tests/ | wc -l
```

预期：`0`（只剩测试文件里的退役断言，故排除 `tests/`）。

### 5.3 确认执行器开关值

```bash
grep -n 'EXECUTOR_ALLOW_PRIVATE_NETWORK' .env apps/executor-node/.env 2>/dev/null || echo 'not configured (default: off)'
```

预期：要么无输出后打印 `not configured (default: off)`，要么显示明确取值。

### 5.4 分类当前任务里会从「放行」变「拒绝」的 gitRepo

```bash
psql "$DATABASE_URL" -At -c "
  SELECT id, name, config->>'gitRepo'
  FROM tasks
  WHERE config->>'gitRepo' ~ '(169\.254\.|fd00:ec2::|^https?://100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|^https?://0\.0\.0\.0|^https?://2(2[4-9]|3[0-9]|4[0-9]|5[0-5])\.|\[::1\])'
  ORDER BY name;"
```

预期：空结果 = 无任务受影响；有输出 = 逐条按 §3.2 改造。

> 本机无 `DATABASE_URL`，此命令**需生产环境**执行（此处实跑 exit 2 = 连不上库，属预期）。

（依据：UPGRADING §10.3 命令 ②；需生产环境——本机无 `DATABASE_URL`）

### 5.5 升级后看拒绝日志

```bash
journalctl -u autocodeflow-executor --since '1 hour ago' | grep -c '指向受限网络地址'
```

预期：`0`。大于 0 说明仍有出站被拒——按日志里的地址回 §2 定位属哪类现场（需执行器主机环境；本机无该 unit，命令输出 `-- No entries --`，`grep -c` 计数为 `0`）。

### 5.6 确认中台侧四个开关与目标

```bash
grep -nE '^(EVENT_WEBHOOK|NOTIF|OIDC|AI)_ALLOW_PRIVATE_NETWORK=' .env 2>/dev/null || echo 'all off'
```

预期：四条都是 `false`（默认严格姿态），或列出开启项——开启项的目标地址必须落在 RFC1918 内。

## 6. 一句话记住

> **开关只放行 `privateIPv4`。** `127.0.0.1`、`100.64/10`、`0.0.0.0`、`198.18/15`、云元数据地址，一律恒拒——无论开关怎么设。
