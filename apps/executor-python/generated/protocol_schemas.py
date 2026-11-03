"""GENERATED — DO NOT EDIT.

来源：`packages/executor-protocol/protocol.json` 的 `schemas` 段（A3 完整形态，
DEEP_REVIEW 0ef3bbe §七）。由 `node scripts/generate-executor-protocol.mjs` 生成，
CI 的 executor-protocol-drift job 会重跑并 `git diff --exit-code` 兜底。

手改本文件会在下次生成时被覆盖，且不会让契约生效——要改请改 protocol.json。
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
import json

# ---------------------------------------------------------------------------
# R2-1/P1a 只读消费段常量 —— 由 protocol.json 生成，勿手改。
# 与 node 侧 `generated/protocol.schemas.ts` 的同名单量**逐字节一致**
# （同一份 JSON 序列化 ⇒ 可被守卫直接比对）。
# ---------------------------------------------------------------------------



class TaskConfig(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    id: str | None = Field(default=None)
    name: str | None = Field(default=None)
    runtime: str | None = Field(default=None)
    entrypoint: str | None = Field(default=None)
    timeout: int | None = Field(ge=0, le=86400, default=None)
    timeoutSeconds: int | None = Field(ge=0, le=86400, default=None)
    timeout_seconds: int | None = Field(ge=0, le=86400, default=None)
    requirements: list[str] | None = Field(default_factory=list)
    gitRepo: str | None = Field(default=None)
    gitBranch: str | None = Field(default=None)
    gitCommit: str | None = Field(default=None)
    runtimeVersion: str | None = Field(default=None)
    runtime_version: str | None = Field(default=None)
    codeSource: Literal["git", "glue", "application_zip"] | None = Field(default=None)
    code_source: Literal["git", "glue", "application_zip"] | None = Field(default=None)
    applicationId: str | None = Field(default=None)
    application_id: str | None = Field(default=None)
    packageUrl: str | None = Field(default=None)
    package_url: str | None = Field(default=None)
    glueSource: str | None = Field(default=None)
    glue_source: str | None = Field(default=None)
    glueLanguage: Literal["python", "javascript", "shell", "glue_python", "glue_node", "glue_shell"] | None = Field(default=None)
    glue_language: Literal["python", "javascript", "shell", "glue_python", "glue_node", "glue_shell"] | None = Field(default=None)


class ExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    executionId: str = Field(pattern="^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    task: TaskConfig
    params: dict[str, Any] | None = Field(default=None)
    secrets: dict[str, Any] | None = Field(default=None)


class HeartbeatPayload(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    registrationConflict: bool | None = Field(default=None)
    taskSandbox: Literal["", "bwrap"] | None = Field(default=None)


class ConfigReloadRequest(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    maxConcurrentTasks: int | None = Field(ge=1, default=None)
    taskTimeoutSeconds: int | None = Field(ge=1, default=None)
    heartbeatIntervalSeconds: int | None = Field(ge=5, default=None)
    adminApiUrl: str | None = Field(default=None)
    adminApiUrlInternal: str | None = Field(default=None)
    adminApiUrlExternal: str | None = Field(default=None)
    adminApiUrls: list[str] | None = Field(default=None)
    workDir: str | None = Field(default=None)
    WORK_DIR: str | None = Field(default=None)


class ConfigReloadResponse(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    success: bool
    message: str
    updated_fields: list[str]
    ignored_fields: list[str]


class HealthReadyResponse(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    status: Literal["ready", "not_ready"]
    reason: str | None = Field(default=None)


class KillResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    ok: bool


class LogsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    lines: list[str]
    totalLines: int = Field(ge=0)
    hasMore: bool


class ControlCommand(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    commandId: str = Field(pattern="^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    type: Literal["deploy", "app-stop", "app-uninstall", "config-reload", "kill-execution", "update-package"]
    payload: dict[str, Any] | None = Field(default=None)
    issuedAt: int | None = Field(default=None)
    schemaVersion: int | None = Field(default=None)


class CommandResult(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    commandId: str
    type: Literal["deploy", "app-stop", "app-uninstall", "config-reload", "kill-execution", "update-package"]
    ok: bool
    status: int | None = Field(default=None)
    error: str | None = Field(default=None)
    durationMs: int | None = Field(ge=0, default=None)
    address: str | None = Field(default=None)


class CallbackArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(pattern="^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$")
    size: int = Field(ge=0)
    sha256: str = Field(pattern="^[0-9a-fA-F]{64}$")


class CallbackPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    executionId: str = Field(pattern="^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    status: Literal["success", "failed"]
    executorAddress: str | None = Field(default=None)
    deviceFingerprint: str | None = Field(default=None)
    exitCode: int | None = Field(default=None)
    logs: str | None = Field(default=None)
    errorMessage: str | None = Field(default=None)
    failureReason: Literal["package_fetch_failed", "dependency_install_failed", "git_fetch_failed", "runtime_missing", "interpreter_unavailable", "sandbox_unavailable", "killed", "timeout", "executor_offline", "executor_restart", "script_error", "unknown"] | None = Field(default=None)
    durationMs: int | None = Field(ge=0, default=None)
    artifacts: list[CallbackArtifact] | None = Field(default=None)
    result: dict[str, Any] | None = Field(default=None)
    traceparent: str | None = Field(default=None)


PROTOCOL_NETWORK_POLICY = json.loads(r"""
{
  "addresses": {
    "loopback": {
      "description": "回环地址：IPv4 127.0.0.0/8、IPv6 ::1，以及主机名 localhost / *.localhost / localhost.localdomain。",
      "examples": [
        "127.0.0.1",
        "127.1.2.3",
        "::1",
        "localhost",
        "foo.localhost"
      ],
      "allowedUnderPrivateNetwork": false
    },
    "privateIPv4": {
      "description": "RFC1918 私网：10.0.0.0/8、172.16.0.0/12、192.168.0.0/16。",
      "examples": [
        "10.0.0.1",
        "172.16.0.1",
        "172.31.255.254",
        "192.168.1.1"
      ],
      "allowedUnderPrivateNetwork": true
    },
    "linkLocal": {
      "description": "链路本地与 ULA：IPv4 169.254.0.0/16（**含云元数据 169.254.169.254**）、IPv6 fe80::/10（链路本地）、fc00::/7（ULA，**含 AWS IPv6 元数据 fd00:ec2::254**）。",
      "examples": [
        "169.254.169.254",
        "fd00:ec2::254",
        "169.254.1.1",
        "fe80::1"
      ],
      "allowedUnderPrivateNetwork": false,
      "$comment": "169.254.169.254 是 **AWS/GCP/Azure 云元数据**端点 —— SSRF 的头号目标。link-local **不随** private-network 开关放行：开开关是为了「内网自建 GitLab」，不是为了打云元数据。 `fd00:ec2::254` = **AWS IPv6 元数据**端点（ULA 段 fc00::/7）；`fe80::1` = IPv6 链路本地。"
    },
    "cgnat": {
      "description": "CGNAT：100.64.0.0/10（RFC6598）。",
      "examples": [
        "100.64.0.1",
        "100.127.255.254"
      ],
      "allowedUnderPrivateNetwork": false,
      "$comment": "⚠️ 100.64/10 在 Python 3.12 的 `ipaddress` 里**既不是 private 也不是 reserved**（实测）——只判 `is_private` 会漏掉它。契约显式登记，node 侧补闸时必须显式列出（它现有的两条正则也没有它）。"
    },
    "unspecified": {
      "description": "未指定地址：0.0.0.0、::。",
      "examples": [
        "0.0.0.0",
        "::"
      ],
      "allowedUnderPrivateNetwork": false,
      "$comment": "0.0.0.0 在 Linux 上有「连本机」的语义；node 侧现有正则同样漏它。"
    },
    "multicast": {
      "description": "组播：224.0.0.0/4、ff00::/8。",
      "examples": [
        "224.0.0.1",
        "239.255.255.250"
      ],
      "allowedUnderPrivateNetwork": false
    },
    "reserved": {
      "description": "保留段（IANA special-purpose，含 0.0.0.0/8、240.0.0.0/4 等）。",
      "examples": [
        "240.0.0.1",
        "255.255.255.255"
      ],
      "allowedUnderPrivateNetwork": false
    }
  },
  "resolution": {
    "mode": "dns-resolve",
    "onResolutionFailure": "deny",
    "$comment": "**判定必须做真实 DNS 解析**（不是字符串匹配）：`http://internal.corp/` 这类解析到 10.x 的名字靠字符串判定会溜过去。解析失败 ⇒ **fail-closed**（deny），与 admin 侧 GIT_REPO_HOST_DNS_LOOKUP_FAILED 同姿态。node 侧现为字符串级 ⇒ 属**收紧缺口**（见上方 $comment）。"
  },
  "enforcement": {
    "stage": "accept",
    "httpStatus": 400,
    "mustNotLeaveLiveEntry": true,
    "mustNotCreateWorkDir": true,
    "$comment": "**accept 期同步拒**（400）。理由：SSRF 类非法载荷若留到后台 prepare 才拒，执行器会先「接单」（占容量槽、admin 侧记 RUNNING、再收到 failed 回调）——拒绝语义从「同步拒」退化成「异步败」。`mustNotLeaveLiveEntry` / `mustNotCreateWorkDir` 两条不变量与 R2-1/P0 的 E-19 纪律同款：闸门必须在**登记之前**、在**落盘之前**。"
  },
  "switch": {
    "envVar": "EXECUTOR_ALLOW_PRIVATE_NETWORK",
    "semantics": "开关开启 ⇒ 放行 privateIPv4；**其余五类（loopback / linkLocal / cgnat / unspecified / multicast / reserved）一律仍拒**。",
    "$comment": "开关的**唯一**效果是放行私网。内网自建 GitLab/Gitea 是文档化拓扑，所以放行私网；但 loopback（打自己回环）、link-local（含云元数据）、CGNAT、unspecified、multicast、reserved 在**任何**开关状态下都拒。"
  },
  "vectors": [
    {
      "name": "deny-cloud-metadata",
      "url": "http://169.254.169.254/latest/meta-data/",
      "expected": "deny",
      "reason": "link-local / 云元数据"
    },
    {
      "name": "deny-ipv6-loopback",
      "url": "http://[::1]/x.git",
      "expected": "deny",
      "reason": "IPv6 回环"
    },
    {
      "name": "deny-unspecified",
      "url": "http://0.0.0.0/x.git",
      "expected": "deny",
      "reason": "未指定地址"
    },
    {
      "name": "deny-cgnat",
      "url": "http://100.64.0.1/x.git",
      "expected": "deny",
      "reason": "CGNAT 100.64/10"
    },
    {
      "name": "deny-private-default",
      "url": "http://10.0.0.1/x.git",
      "expected": "deny",
      "reason": "私网，开关默认关闭"
    },
    {
      "name": "deny-loopback-hostname",
      "url": "http://localhost/x.git",
      "expected": "deny",
      "reason": "loopback 不随开关放行"
    },
    {
      "name": "allow-private-under-switch",
      "url": "http://10.0.0.1/x.git",
      "expected": "deny",
      "switch": "on",
      "reason": "开关开启时私网**本应**放行——但本向量的 expected 字段是「默认态」判据，故此处记 deny 并由 `switch` 字段标注需在开关开启态下重判",
      "$comment": "⚠️ **本向量自相矛盾，已于 $schemaVersion 4 拆分**（R2-1/P1b，Lead 批准 Q-A）：本条的 `expected: deny` 与 `switch: on` 互相打架 —— `expected` 记的是「默认态」判据，`switch` 字段却标注「需在开关开启态下重判」。向量是「已发布端按旧向量断言」的东西，**但错的是向量本身、不是语义** ⇒ 处置是**追加**两条自洽的向量（默认态 deny / 开关态 allow），**保留本条不改写**（append-only 纪律），仅用本注释显式声明它已被拆分取代。拆分后的两条见 `deny-private-under-switch-default` 与 `allow-private-under-switch-enabled`。"
    },
    {
      "name": "deny-private-under-switch-default",
      "url": "http://10.0.0.1/x.git",
      "expected": "deny",
      "switch": "off",
      "reason": "私网在开关**默认关闭**时一律拒绝",
      "$comment": "R2-1/P1b 拆分自原向量 `allow-private-under-switch`（该条自相矛盾，见其 $comment）。"
    },
    {
      "name": "allow-private-under-switch-enabled",
      "url": "http://10.0.0.1/x.git",
      "expected": "allow",
      "switch": "on",
      "reason": "私网在开关**开启**时放行（契约 networkPolicy.switch 的唯一效果）",
      "$comment": "R2-1/P1b 拆分自原向量 `allow-private-under-switch`（该条自相矛盾，见其 $comment）。"
    },
    {
      "name": "allow-public",
      "url": "http://8.8.8.8/x.git",
      "expected": "allow",
      "reason": "公网地址"
    }
  ]
}
""")


PROTOCOL_ERROR_STATUS_CODES = json.loads(r"""
{
  "rejectedRequest": {
    "httpStatus": 400,
    "reason": "载荷违反 ExecuteRequest schema（缺字段 / 类型错 / 取值非法）。",
    "$comment": "**不是 422**：422 是框架默认而非契约决定。本契约的判据是「载荷是否违反 schemas 段」，违反 ⇒ 400。"
  },
  "protocolViolation": {
    "httpStatus": 400,
    "reason": "载荷违反协议 schema（两侧同一份 protocol.json 生成物判定）。"
  },
  "policyRejection": {
    "httpStatus": 400,
    "reason": "载荷形状合法但**取值**违反执行器侧策略闸（timeout 越界、params 键名折叠冲突、gitRepo 地址/ref 不合规、requirements 非数组）。"
  },
  "capacityRejection": {
    "httpStatus": 429,
    "reason": "执行器并发已满。",
    "retryable": true
  },
  "shuttingDownRejection": {
    "httpStatus": 503,
    "reason": "执行器正在停机（drain 窗口）。",
    "retryable": true
  },
  "invariants": [
    "**拒绝必须在 accept 期可见**（同步 4xx），不得留到后台 prepare 阶段——否则执行器先「接单」再失败，拒绝语义从「同步拒」退化成「异步败」（R2-1/P0 的 D3 修复即此条）。",
    "被拒的执行**不得留下 live 注册条目**（否则该 executionId 在本执行器上永久被重复领取守卫拒绝，admin 每次重试都撞 400，心跳还会上报一个不存在的执行）。",
    "被拒的执行**不得落盘 work_dir**（校验必须早于 mkdir）。",
    "**同步拒绝路径不得占用容量计数**（容量槽在登记后才计数，拒绝路径不触碰它）。"
  ],
  "scope": {
    "appliesTo": "executor-node 与 executor-python 的 /execute 端点",
    "$comment": "**不是全局规则**：其它端点（如 `/config/reload`）的请求校验失败仍按各自框架默认（422）。本契约只管**跨端对等面**（两端都有的 `/execute`）。"
  },
  "vectors": [
    {
      "name": "missing-task",
      "request": {
        "executionId": "x"
      },
      "expectedStatus": 400,
      "expectedReason": "违反 ExecuteRequest schema"
    },
    {
      "name": "missing-execution-id",
      "request": {
        "task": {}
      },
      "expectedStatus": 400,
      "expectedReason": "违反 ExecuteRequest schema"
    },
    {
      "name": "execution-id-not-string",
      "request": {
        "executionId": 123,
        "task": {}
      },
      "expectedStatus": 400,
      "expectedReason": "违反 ExecuteRequest schema"
    },
    {
      "name": "timeout-out-of-range",
      "request": {
        "executionId": "x",
        "task": {
          "timeoutSeconds": 999999
        }
      },
      "expectedStatus": 400,
      "expectedReason": "策略闸（timeout 越界）"
    },
    {
      "name": "params-key-fold-collision",
      "request": {
        "executionId": "x",
        "task": {},
        "params": {
          "limit": 1,
          "LIMIT": 2
        }
      },
      "expectedStatus": 400,
      "expectedReason": "策略闸（params 折叠冲突）"
    },
    {
      "name": "pull-path-rejection-is-failed-callback",
      "entry": "pull",
      "request": {
        "executionId": "x",
        "task": {
          "gitRepo": "http://169.254.169.254/x.git"
        }
      },
      "expectedHttpStatus": null,
      "expectedCallback": {
        "status": "failed",
        "failureReason": "unknown"
      },
      "$comment": "**pull 路径的等价形态**：没有 HTTP 状态码，只有 failed 回调（failureReason=unknown）+ 预留槽归还 + 不留 live 条目 + 不落盘。"
    }
  ],
  "pullPathEquivalent": {
    "$comment": "**R2-1/P1b 补登（契约不完整，非实现问题）**：以上五类拒绝描述的是 **HTTP `/execute` 入口**（有同步 HTTP 响应可返 4xx）。但执行器还有**第二条领取入口** —— pull 循环（ADR-015/016）：执行器主动长轮询取任务，**没有同步调用方**可接收 4xx。该路径的等价形态是**补发 failed 回调**，而非 HTTP 状态码。",
    "stage": "pull",
    "equivalentForm": "failed-callback",
    "failureReason": "unknown",
    "errorMessagePrefix": "执行器拒绝了拉取到的派发任务：",
    "$comment_detail": "为什么 `failureReason` 是 `unknown` 而不是更具体的码：这条拒绝发生在 **accept 之前的校验阶段**（载荷非法 / 策略闸拒绝），既不是「拉取失败」也不是「运行失败」，分类器没有更贴切的既有枚举值。`ExecutionFailureReason` 是封闭枚举，**复用既有值而非新增**是本仓的既有纪律（见 failureReason 段）。",
    "mustNotLeaveLiveEntry": true,
    "mustNotCreateWorkDir": true,
    "mustReleaseReservedSlot": true,
    "$comment_slot": "pull 路径在发起长轮询**之前**已原子预留一个容量槽（E-01）。拒绝后该预留**必须**归还，否则执行器会永久少一个槽位（预留泄漏）。node 侧由 pull 循环的 `finally` 统一释放；python 侧由 `release_running_slot()` 释放。"
  }
}
""")


PROTOCOL_TASK_FIELD_ALIASES = json.loads(r"""
{
  "aliases": [
    {
      "canonical": "timeoutSeconds",
      "alias": "timeout_seconds",
      "wireAdded": false
    },
    {
      "canonical": "timeout",
      "alias": "timeout",
      "wireAdded": false,
      "$comment": "`timeout` 是**第三个**入口（legacy/fallback 字段），其优先级见 `timeoutPrecedence` 段。"
    },
    {
      "canonical": "codeSource",
      "alias": "code_source",
      "wireAdded": false
    },
    {
      "canonical": "glueSource",
      "alias": "glue_source",
      "wireAdded": false
    },
    {
      "canonical": "runtimeVersion",
      "alias": "runtime_version",
      "wireAdded": false
    },
    {
      "canonical": "gitRepo",
      "alias": "git_repo",
      "wireAdded": false,
      "$comment": "**本批新增**。两侧都必须读 —— node 侧需补读（当前零命中），python 侧已读。"
    },
    {
      "canonical": "gitCommit",
      "alias": "git_commit",
      "wireAdded": false,
      "$comment": "**本批新增**（node 侧当前只读 `gitCommit`；python 侧已读 `gitCommit` 或 `git_commit`）。"
    },
    {
      "canonical": "gitBranch",
      "alias": "git_branch",
      "wireAdded": false,
      "$comment": "**本批新增**（同上）。"
    }
  ],
  "rules": [
    "别名与正名**语义完全相同** —— 不是「透传字段」，是**同一语义的第二入口**。",
    "两侧**都必须**同时读正名与别名（缺一侧 = 漂移）。",
    "别名**不得**改变校验强度：正名是 enum ⇒ 别名必须同集 enum；正名是数值 ⇒ 别名必须同样拒字符串（protocol README 已记录一次此类真实漂移）。",
    "读取顺序：**正名优先**；正名缺席时读别名（见 `timeoutPrecedence` 段的通用规则）。"
  ]
}
""")


PROTOCOL_TIMEOUT_PRECEDENCE = json.loads(r"""
{
  "order": [
    "timeoutSeconds",
    "timeout_seconds",
    "timeout"
  ],
  "rule": "canonical-first",
  "ignoredAliasesAreNotValidated": true,
  "selectedValueBounds": {
    "min": 1,
    "max": 86400,
    "zeroMeans": "unlimited",
    "$comment": "0 = **显式不限时**（不是「缺省」）。越界/非数值 → 400（`errorStatusCodes.policyRejection`）。"
  },
  "vectors": [
    {
      "name": "canonical-only",
      "task": {
        "timeoutSeconds": 60
      },
      "selected": "timeoutSeconds",
      "effective": 60,
      "expectedStatus": 200
    },
    {
      "name": "canonical-wins-over-alias",
      "task": {
        "timeoutSeconds": 60,
        "timeout_seconds": 120
      },
      "selected": "timeoutSeconds",
      "effective": 60,
      "expectedStatus": 200
    },
    {
      "name": "alias-used-when-canonical-absent",
      "task": {
        "timeout_seconds": 120
      },
      "selected": "timeout_seconds",
      "effective": 120,
      "expectedStatus": 200
    },
    {
      "name": "legacy-used-as-last-resort",
      "task": {
        "timeout": 300
      },
      "selected": "timeout",
      "effective": 300,
      "expectedStatus": 200
    },
    {
      "name": "ignored-alias-out-of-range-does-not-reject",
      "task": {
        "timeoutSeconds": 60,
        "timeout": 999999
      },
      "selected": "timeoutSeconds",
      "effective": 60,
      "expectedStatus": 200,
      "$comment": "**本段的核心向量**：旁键越界**不得**导致拒绝 —— 这是 python 现状（逐键全检）与 node 现状（首现键）不一致处的裁定点。"
    },
    {
      "name": "selected-out-of-range-rejects",
      "task": {
        "timeoutSeconds": 999999
      },
      "selected": "timeoutSeconds",
      "expectedStatus": 400,
      "$comment": "选中键越界 ⇒ 400（两侧一致）。"
    },
    {
      "name": "zero-means-unlimited",
      "task": {
        "timeoutSeconds": 0
      },
      "selected": "timeoutSeconds",
      "effective": 0,
      "expectedStatus": 200,
      "$comment": "0 = 显式不限时；旁键 `timeout: 999999` **不得**导致拒绝。"
    }
  ]
}
""")


PROTOCOL_CALLBACK_LOG_RETENTION = json.loads(r"""
{
  "inMemory": {
    "mode": "head-tail",
    "headChars": 500000,
    "tailChars": 500000,
    "$comment": "头 + 尾**各** 500KB。中间部分丢弃。"
  },
  "marker": {
    "pattern": "\\[\\s*(?:logs\\s+)?truncated\\b",
    "$comment": "admin 的 `LOG_TRUNCATION_MARKER`（`task.service.ts`）用此正则识别「这是截断过的日志」⇒ 触发**回填**（从执行器落盘文件补全）。两侧 marker 文案**必须命中该正则**。",
    "requiredTokens": [
      "truncated"
    ],
    "note": "marker 文案**允许两侧不同**，但必须命中上面的正则 ⇒ admin 的回填机制对两侧等价生效。"
  },
  "finalCallbackChars": {
    "default": 10000,
    "adminCap": 512000,
    "envVar": "CALLBACK_LOGS_MAX_CHARS",
    "$comment": "**上报给 admin 的最终长度**（与 `inMemory` 是两件事）。默认 10000 两侧相同。admin 的 DTO 上限 512000 —— 配更大的值会让 admin 把**整批**（≤100 条）回调整体拒收（同批其它终态陪葬）⇒ python 侧已有钳位逻辑，node 侧当前硬编码 10000（无 env 覆盖）。"
  },
  "vectors": [
    {
      "name": "short-output",
      "inputChars": 1000,
      "expectedHeadChars": 1000,
      "expectedTailChars": 0,
      "expectedTruncated": false
    },
    {
      "name": "over-limit-keeps-both-ends",
      "inputChars": 2000000,
      "expectedHeadChars": 500000,
      "expectedTailChars": 500000,
      "expectedTruncated": true,
      "$comment": "中间 1MB 丢弃，头尾各留 500KB。"
    },
    {
      "name": "tail-is-retained",
      "inputChars": 2000000,
      "tailProbe": "FINAL-ERROR-LINE",
      "expectedTailContainsProbe": true,
      "$comment": "**本段的核心向量**：尾部必须被保留 —— python 现状（只留前 10MB）在此向量下丢失。"
    }
  ]
}
""")
