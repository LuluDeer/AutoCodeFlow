# ExecutorPackage 实体（executor_packages 表）— 执行器分发包

> 所属: docs/atlas/03-data · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/executor-package/executor-package.entity.ts

## 所属模块与源文件

- 模块：[executor-package 模块](../../01-apps/admin-api/modules/executor-package.md)（`apps/admin-api/src/modules/executor-package/`）
- 源文件：`apps/admin-api/src/modules/executor-package/executor-package.entity.ts`（**实体在模块根目录**，不在 `entities/` 子目录——data-source 的实体 glob `modules/**/*.entity{.ts,.js}` 专门覆盖了这种形态）

## 表名

`executor_packages`（`@Entity("executor_packages")`）

## 字段表

主键 `id: uuid`。关键字段：

| 列名 | 类型 | 说明 |
|---|---|---|
| `name` | varchar(255) NOT NULL | 包名 |
| `version` | varchar(64) NOT NULL | 包版本 |
| `type` | PG enum `ExecutorPackageType`，default `universal` | `node` / `python` / `universal` |
| `platform` | varchar(128) nullable | 目标平台 |
| `filename` | varchar(256) nullable | 磁盘文件名（**含校验和前缀，唯一**） |
| `filePath` | varchar(1024) NOT NULL | 服务器上的绝对路径 |
| `originalFilename` | varchar(256) nullable | 上传时的原始文件名 |
| `mimeType` | varchar(128) nullable | 上传文件 MIME 类型 |
| `fileSize` | bigint，default 0 | 文件字节数（bigint——包文件可达 GB 级） |
| `checksum` | varchar(64) nullable | 校验和 |
| `description` | text nullable | 描述 |
| `status` | PG enum `ExecutorPackageStatus`，default `active` | `active` / `deprecated` / `uploading` |
| `uploadedBy` | varchar(255) nullable | 上传人 |
| `pushHistory` | jsonb，default `[]` | 推送历史（每次执行器 push-result 回调追加）：`[{executorId, status: "downloaded"\|"failed", version, error?, timestamp}]` |
| `projectId` | uuid nullable | AUTH-01：归属项目；迁移 `1790000000009` 加列 + FK ON DELETE SET NULL + 索引；存量不回填 |
| `createdAt` / `updatedAt` | timestamptz | 自动维护 |

## 索引与约束

| 索引/约束 | 定义处 | 说明 |
|---|---|---|
| `UNIQUE (name, version, type)` | 实体 `@Index(["name", "version", "type"], { unique: true })` | 同名同版本同类型只允许一个包 |
| `projectId` FK `ON DELETE SET NULL` + 索引 | 迁移 `1790000000009` | AUTH-01 |
| 表创建 | 迁移 `1717473142694-CreateExecutorPackagesTable.ts` | |

## 关系

- **引用**：`projects`（FK SET NULL）。
- **被引用**：无 FK——执行器下载/推送行为通过回调更新 `pushHistory`（jsonb 内嵌 `executorId`，弱关联 [executors](executor.md)）。

## 生命周期与写入方

- **创建**：`ExecutorPackageService` 上传接口（写文件到磁盘 + 落库，status 从 `uploading` 到 `active`）。
- **更新**：包信息编辑、`deprecated` 标记；执行器推送结果回调追加 `pushHistory`。
- **读取**：包列表/下载接口（执行器升级链路消费，[registry 相关](../../01-apps/admin-api/modules/registry.md)）。

## 常见改动场景

1. **加列**：实体 + 幂等迁移（参考 [migrations.md](../migrations.md)）+ 上传/列表 DTO。
2. **换存储后端**（本地磁盘 → S3/MinIO）：`filePath` 语义变化需兼容存量行（建议加 `storageBackend` 列区分而非改语义）。
3. **pushHistory 结构演进**：jsonb 无 DB 约束，新增键需对旧条目缺键做读取侧兜底。
