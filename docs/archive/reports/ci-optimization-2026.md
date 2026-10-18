# GitHub Actions 流水线优化方案

## 优化目标

**问题**：每次从 develop 开发到 main 发版完成需要等待 1 小时以上，因为多个 workflow 重复触发相同的测试。

**优化后**：减少约 50% 的等待时间，消除重复执行。

---

## 优化前的触发链路

```
┌─────────────────────────────────────────────────────────────────┐
│ 开发流程                                                         │
└─────────────────────────────────────────────────────────────────┘

1. develop 分支 push
   └─→ ci.yml 触发（完整测试套件 ~30-40 分钟）
   
2. 创建 PR: develop → main
   └─→ ci.yml 再次触发（重复测试 ~30-40 分钟）
   
3. 合并 PR 到 main
   ├─→ ci.yml 第三次触发（又是 ~30-40 分钟）❌
   └─→ release-please.yml 触发（创建 Release PR）
   
4. 合并 Release PR (bump 版本)
   ├─→ ci.yml 第四次触发 ❌
   └─→ release-please.yml 再次触发（创建 tag）
   
5. tag v* push
   ├─→ ci.yml 第五次触发 ❌
   └─→ release.yml 触发（npm/PyPI 发布）

总耗时：30-40 分钟 × 5 次 = 2.5-3+ 小时
```

---

## 优化后的触发链路

```
┌─────────────────────────────────────────────────────────────────┐
│ 开发流程                                                         │
└─────────────────────────────────────────────────────────────────┘

1. develop 分支 push
   └─→ ci.yml 触发（完整测试套件 ~30-40 分钟）✅
   
2. 创建 PR: develop → main
   └─→ ci.yml 触发（验证合并安全性 ~30-40 分钟）✅
   
3. 合并 PR 到 main
   ├─→ ci.yml 不触发（已由 PR 验证）❌ 跳过
   └─→ release-please.yml 触发（创建 Release PR）
   
4. 合并 Release PR (bump 版本)
   ├─→ ci.yml 不触发 ❌ 跳过
   └─→ release-please.yml 创建 tag
   
5. tag v* push
   ├─→ ci.yml 不触发 ❌ 跳过
   └─→ release.yml 触发（npm/PyPI 发布，有独立 version-guard）✅

总耗时：30-40 分钟 × 2 次 = 1-1.5 小时

节省：1.5-2 小时（约 60%）
```

---

## 具体修改

### 1. `.github/workflows/ci.yml`

**修改前：**
```yaml
on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main, develop ]
```

**修改后：**
```yaml
on:
  push:
    branches: [ develop ]
    # main 分支的 push 不触发 CI（已由 PR 验证过）
    # tags 的 push 也不触发 CI（release.yml 有独立验证）
  pull_request:
    branches: [ main, develop ]
```

**理由：**
- `develop` push：开发分支需要持续验证
- `main` push：已经通过 PR 验证，无需重复
- PR 到 `main`/`develop`：必须验证合并安全性
- tag push：`release.yml` 有独立的 `version-guard` job

---

### 2. `.github/workflows/release-please.yml`

**修改前：**
```yaml
on:
  push:
    branches:
      - main
```

**修改后：**
```yaml
on:
  push:
    branches:
      - main
    # 只在非 tag push 时触发（避免与 release.yml 重复）
    tags-ignore:
      - '**'
```

**理由：**
- `release-please` 创建 tag 后会触发 `release.yml`
- 不需要在 tag push 时重复运行 `release-please`
- 使用 `tags-ignore: ['**']` 明确排除所有 tag

---

## 安全性保障

### ✅ 测试覆盖不降低

1. **develop 分支**：每次 push 仍触发完整 CI
2. **PR 验证**：所有到 main 的 PR 必须通过 CI
3. **发版验证**：`release.yml` 有独立的 `version-guard` 检查

### ✅ 发布流程不受影响

- `release-please.yml` 仍在 main 分支 push 时触发
- `release.yml` 仍在 tag push 时触发
- 两者互不干扰（tag 时不触发 release-please）

### ✅ 现有 workflow 特性保留

- `concurrency` 配置保留（同一分支的旧 run 自动取消）
- `schedule` 定时任务不受影响
- `workflow_dispatch` 手动触发不受影响
- 所有 job 的依赖关系不变

---

## 验证清单

在合并此优化后，验证以下场景：

### ✅ Develop 分支正常工作
```bash
# 1. 在 develop 分支提交
git checkout develop
git commit -m "feat: test ci trigger"
git push origin develop

# 预期：ci.yml 触发
```

### ✅ PR 验证正常
```bash
# 2. 创建 PR: develop → main
gh pr create --base main --head develop

# 预期：ci.yml 触发
```

### ✅ Main 分支不重复
```bash
# 3. 合并 PR
gh pr merge <pr-number> --squash

# 预期：
# - ci.yml 不触发 ✓
# - release-please.yml 触发 ✓
```

### ✅ 发版流程正常
```bash
# 4. release-please 创建 tag 后
# 预期：
# - ci.yml 不触发 ✓
# - release-please.yml 不触发 ✓
# - release.yml 触发 ✓
```

---

## 进一步优化建议

### 1. 缓存优化（已实施）

当前已使用：
- `actions/setup-node@v7` 的 `cache: 'npm'`
- `cache-dependency-path` 指定 lockfile

### 2. 矩阵并行化（已实施）

当前已优化：
- `admin-api-test`：4 片并行（`--shard=1/4..4/4`）
- `docker-multiarch-build`：amd64/arm64 并行
- 多个独立 job 并行执行

### 3. 可选：按路径触发

如果希望进一步减少不必要的 CI run：

```yaml
on:
  push:
    branches: [ develop ]
    paths-ignore:
      - 'docs/**'
      - '**.md'
      - '.github/workflows/docs-*.yml'
```

**权衡**：
- ✅ 减少文档修改触发的 CI
- ❌ 可能遗漏跨模块影响（不推荐用于核心 CI）

### 4. 可选：依赖更新自动合并

配置 Dependabot 自动合并低风险更新：

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 10
```

---

## 监控指标

优化后，关注以下指标：

| 指标 | 优化前 | 优化后 | 改善 |
|-----|--------|--------|------|
| develop → main PR 总耗时 | ~1.5 小时 | ~40 分钟 | -60% |
| 发版总耗时（含 CI） | ~2.5 小时 | ~1 小时 | -60% |
| CI run 次数/发版 | 5 次 | 2 次 | -60% |
| CI 分钟消耗/月 | 估算 | 减少 60% | - |

---

## 回滚方案

如果发现问题，可以快速回滚：

```bash
# 1. 恢复 ci.yml
git checkout HEAD~1 -- .github/workflows/ci.yml

# 2. 恢复 release-please.yml
git checkout HEAD~1 -- .github/workflows/release-please.yml

# 3. 提交并推送
git commit -m "revert: rollback ci optimization"
git push origin main
```

---

## 相关文档

- [GitHub Actions 触发条件文档](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows)
- [release-please 文档](https://github.com/googleapis/release-please)
- [项目 CI 架构](../../development.md)

---

**优化实施日期**：2026-XX-XX  
**文档维护者**：LuluDeer  
**下次审查**：发版后 2 周
