# executor-package 模块 — 执行器安装包分发

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/executor-package

## 职责

执行器安装包（升级包）的上传、存储、分发与推送：管理员上传 tar.gz/zip/whl 包 → 落盘 + SHA-256 记账 → 可由执行器凭据拉取下载，或由管理台主动「推送」通知在线执行器拉取升级并回执结果。

## 目录结构与关键文件

```
modules/executor-package/
├── executor-package.module.ts    装配：TypeOrmModule.forFeature(ExecutorPackage)
├── executor-package.controller.ts @Controller("executor-packages")，类级 @Roles(ADMIN)
├── executor-shared-token.guard.ts push-result 专用共享令牌守卫（WIKI-PKG-GUARD）
├── executor-package.service.ts    上传校验/落盘/推送（约 600 行）
├── executor-package.entity.ts     executor_packages 表（name+version+type 唯一索引）
├── dto/executor-package.dto.ts    Create/Update/Query DTO
└── __tests__/                     controller / service 单测
```

包文件落盘于 `<process.cwd()/uploads/executor-packages>`（multer diskStorage，临时目录 `upload-tmp` 在同卷内，落盘为原子 rename，R9）。

## 路由（controller 前缀 `executor-packages`，实际路径 `/api/executor-packages`）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/` | ADMIN | 上传包（multipart `file`，multer 上限 500MB） |
| GET | `/` `/latest` `/:id` | ADMIN | 列表（name/type/status/platform 过滤）/ 指定类型最新 ACTIVE 包 / 详情 |
| PATCH | `/:id`、`/:id/deprecate`、`/:id/activate` | ADMIN | 元信息更新 / 状态流转（`active`↔`deprecated`） |
| DELETE | `/:id` | ADMIN | 删 DB 行并 unlink 磁盘文件（best-effort） |
| GET | `/:id/download` | `@Public()` + 空 `@Roles()`（Bearer 执行器 token 或 `?token=`） | 流式下载（`stream.pipeline`，500MB 不进堆） |
| POST | `/push-result` | `@Public()` + 空 `@Roles()` + 方法级 `ExecutorSharedTokenGuard` | 执行器推送结果回执（追加进 `pushHistory` jsonb） |
| POST | `/:id/push` | ADMIN | 推送到在线执行器（`executorIds` 空则全体 ONLINE） |

## 关键机制

### 上传校验链（P1 / SEC-05）

```
multipart file（diskStorage → upload-tmp）
  ① 扩展名白名单：.zip / .whl / .tar.gz / .tgz（.tar.gz 特判优先于 path.extname）
  ② 魔数 sniff（只读前 2 字节）：0x50 0x4B（PK，zip 族）或 0x1F 0x8B（gzip）
  ③ PK 族 zip 炸弹守卫 assertZipFileSafe（zipGuard 限额可配，fail-closed）
  ④ 可选 clamd 杀毒扫描（CLAMD_ENABLED=true 时启用；unavailable 也拒收，fail-closed）
  ⑤ 流式 SHA-256（磁盘读取，不驻留堆）
  → 落盘 uploads/executor-packages/<name>-<version>-<checksum前8位><ext>
  → DB 行（status=active）；DB 写失败回滚 unlink 防孤儿（QA9）
```

启动时 `onModuleInit` 清扫 `upload-tmp` 内超过 1 小时的遗留临时文件（QA9：崩溃/中断上传的孤儿）。

### push-result 共享令牌守卫（WIKI-PKG-GUARD）

`POST /push-result` 是 executor-node 的机器回调入口，无用户登录态。鉴权由方法级 `ExecutorSharedTokenGuard` 承担：路由保持 `@Public()` + 空 `@Roles()`（JwtAuthGuard/RolesGuard 行为不变），守卫在 Nest 守卫管线内读取 `authorization` 头后**原样委托** `common/utils/verify-executor-token.util.ts` 的 `verifyExecutorToken`（DB 令牌优先、env 回退、timingSafeEqual、fail-closed），自身不复刻第二套校验——放行/401 语义与旧内联调用逐字节等价。download 端点的双凭据逻辑（共享令牌 OR 管理员 JWT）不在守卫范围，仍内联于 handler。

### 推送（pushToExecutors）

- 前置条件：`ADMIN_API_URL` 必须配置（执行器需可达 admin-api 拉包地址），未配置抛 503。
- 对每个目标执行器发通知（携带包元信息与校验和），执行器自行 GET 下载端点拉包并自升级，完成后 POST `/push-result` 回执（`downloaded`/`failed` + version + error），结果追加到包行的 `pushHistory`。
- `GET /latest`（按 type/platform 取最新 ACTIVE）供执行器自升级轮询。

## 实体要点（executor_packages 表）

| 列 | 说明 |
|---|---|
| `name` + `version` + `type` | 联合唯一索引（同三元组重复上传 409） |
| `type` | 枚举 `node / python / universal`（默认 universal） |
| `platform` | 可选平台标记（列表过滤维度） |
| `filename` / `filePath` | 落盘文件名（含 checksum 前 8 位，天然去重）/ 绝对路径 |
| `fileSize` / `checksum` | 字节数（bigint）/ SHA-256 hex（执行器侧校验依据） |
| `status` | 枚举 `active / deprecated / uploading`（默认 active；deprecate/activate 流转） |
| `pushHistory` | jsonb 数组：`{executorId, status: "downloaded"\|"failed", version, error?, timestamp}` |
| `projectId` | 可空，AUTH-01 多租户归属 |

## 与其他模块的关系

- 独立于 [executor](executor.md) 模块（不 import ExecutorService）；推送目标由 controller 层传入执行器列表与共享 token。
- `artifacts.controller.ts` 复用本模块导出的 `buildContentDisposition`（下载头构造）。
- 与 [executor](executor.md) 的 `GET /api/executors/artifact/executor-node.tar.gz` 互补：后者是**内置** node 执行器分发（安装脚本首次拉取），本模块是**管理员上传的升级包**通道。
- 包类型 `node/python/universal` 与执行器 `ExecutorType` 同构（见 [executor](executor.md) 实体）。

## 常见改动场景

- 调整包大小上限：controller 的 multer `limits`（500MB）与 zipGuard 限额同步评估。
- 新增包格式：扩展名白名单 + 魔数 sniff 两处一起改（仅加格式不做内容校验会被守卫拒绝）。
- 推送协议升级：`pushToExecutors` 与执行器侧 pull/回执逻辑是配对契约（`push-result` 的字段即回执协议）。

## 相关文档

- [executor](executor.md)（内置分发与执行器身份）
- [artifacts](artifacts.md)（复用 buildContentDisposition；同卷 uploads 布局）
- 执行器侧消费：[executor-node](../../../01-apps/executor-node/README.md)（规划路径）
