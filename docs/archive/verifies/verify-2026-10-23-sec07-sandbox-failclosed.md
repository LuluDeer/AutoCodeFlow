# VERIFY：SEC-07 沙箱默认 / opt-in 真机验收（2026-10-23）

> 范围：`docker-compose.yml` 的 Python 任务沙箱默认（直跑）与 `docker-compose.secure.yml`
> 的 bwrap opt-in —— 对应 [ROADMAP.md](../../ROADMAP.md) P0「bwrap 默认策略收口」。
> 环境：Linux 开发机，Docker 26.1.4 + Compose v2；宿主 `/proc/sys/kernel/unprivileged_userns_clone=1`，
> 但容器内 bwrap 仍无法建立命名空间（见 §3 横向探针）。
> 结论：**默认分支通过**（Python glue 实测 `success`）；**opt-in 分支在本机只能验证
> fail-closed 一侧**——任务失败而非降级，且失败原因现在可诊断（`sandbox_unavailable` +
> 「沙箱不可用…已 fail-closed」）。「满足前置的宿主上 bwrap 真正可用」仍待一台宿主复验。

## 1. 静态闸

| 命令 | 结果 |
|---|---|
| `npm run test:compose-sandbox` | ✅ 全部通过（基础 compose 默认关闭；secure overlay 为 `TASK_SANDBOX: 'bwrap'`；`deployment.md` 保留说明） |
| `docker compose -f docker-compose.yml -f docker-compose.secure.yml config` | ✅ executor-python 渲染为 `TASK_SANDBOX: bwrap` + `seccomp:unconfined` |

## 2. 默认分支（基础 compose，`TASK_SANDBOX=''`）

- 栈：本机 demo 栈（`scripts/demo.sh`，容器 `acf-demo-executor-python-1`）。
- `docker inspect` 实测 `TASK_SANDBOX=`（空 = 容器内直跑，容器自身已非 root +
  cap_drop + no-new-privileges + rlimit）。
- 触发 `demo-cron-report`（python glue，cron `*/5 * * * *`）→ 执行记录 **`success`**。
  即：默认部署的 Python 任务可用，不需要任何额外宿主前置。

## 3. opt-in 分支（secure overlay，隔离工程 `acf-secure`）

隔离工程只起 `postgres / redis / admin-api / executor-python`，端口全部 loopback，
验证后 `docker compose ... -p acf-secure down -v` 清理，不影响既有 demo 栈。

| 探针 | 实测 |
|---|---|
| 容器 env | `TASK_SANDBOX=bwrap` |
| 容器 SecurityOpt | `[no-new-privileges:true seccomp:unconfined]` |
| 容器内 `bwrap --unshare-all --share-net … echo bwrap-ok` | ❌ `bwrap: Failed to make / slave: Permission denied` |

宿主侧横向探针（同一镜像，`docker run --rm …`）：

| 配置 | 结果 |
|---|---|
| 默认 | `bwrap: No permissions to create a new namespace` |
| `--security-opt seccomp=unconfined` | `bwrap: Failed to make / slave: Permission denied` |
| `+ --security-opt apparmor=unconfined` | `bwrap: setting up uid map: Permission denied` |
| `--privileged` | `bwrap: setting up uid map: Permission denied` |

即：**本机 Docker 内 bwrap 起不来不是 seccomp 单点问题**。`docker-compose.secure.yml`
的文档前置（「宿主需允许非特权 userns」）在本机不充分，需要在 `deployment.md` 收窄口径
（或在 overlay 里补 apparmor/capability，但那会牺牲容器隔离，需单独决策）。

## 4. fail-closed + 可诊断（本次修复点）

触发 python glue 任务 `sec07-sandbox-probe`（manual）后的执行记录：

```
status:          failed
exitCode:        1
durationMs:      3
failureReason:   sandbox_unavailable      ← 修复前：script_error
errorMessage:    沙箱不可用：bwrap 无法创建命名空间（宿主需允许非特权用户命名空间，
                 Docker 默认 seccomp / apparmor 也会拦 mount；见 docs/deployment.md SEC-07）。
                 已 fail-closed，未降级为无沙箱运行。
```

修复前同一路径只报 `script_error` + 「进程以退出码 1 结束」——**用户会去查自己的脚本，
而不是查宿主前置条件**。修复：

- `apps/executor-python/routers/execute.py`：新增 `_sandbox_startup_failure_reason()`，
  仅在 `TASK_SANDBOX=bwrap` 时把子进程输出里的 bwrap 启动失败证据翻成可诊断文案
  （任务输出不可信，沙箱关闭时绝不据此改判）。
- `apps/executor-python/tests/test_executor_protocol_contract.py`：3 例回归——
  证据→文案→`sandbox_unavailable`、沙箱关闭时不改判、良性日志（只是提到 bwrap）不误伤。
- UI 侧既有能力直接生效：`sandbox_unavailable` 的中文标签、hint 与 runbook 早已存在
  （`apps/admin-web/src/locales/zh.ts`），本次只是让运行期失败真正走进这条分类。

## 5. 残差（如实）

1. 「满足前置的宿主上 bwrap 真正可用」未验证——需要一台允许容器内 userns/mount 的宿主
   跑 `bwrap-ok` 探针 + 一条 Python 任务成功。
2. macOS / Windows 无 bwrap，opt-in 只对 Linux 有意义。
3. 若要在 Docker 默认策略下既保留 `no-new-privileges` 又用 bwrap，需要新的隔离方案
   （例如每任务独立 sandbox 容器或宿主直跑），不在本次范围。
