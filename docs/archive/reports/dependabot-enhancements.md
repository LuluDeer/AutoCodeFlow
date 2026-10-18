# Dependabot 配置增强建议

当前项目已有 `.github/dependabot.yml` 配置，以下是可选的增强建议。

## 当前配置状态 ✅

已配置：
- ✅ GitHub Actions 自动更新（weekly）
- ✅ 8 个 npm 包目录的依赖更新
- ✅ 分组策略（minor + patch 合并）

## 可选增强

### 1. 添加自动合并（低风险更新）

在 `.github/workflows/` 创建 `dependabot-auto-merge.yml`：

```yaml
name: Dependabot Auto-Merge

on: pull_request

permissions:
  contents: write
  pull-requests: write

jobs:
  auto-merge:
    runs-on: ubuntu-latest
    if: github.actor == 'dependabot[bot]'
    steps:
      - name: Dependabot metadata
        id: metadata
        uses: dependabot/fetch-metadata@v2
        with:
          github-token: "${{ secrets.GITHUB_TOKEN }}"
      
      - name: Auto-merge for development dependencies
        if: |
          steps.metadata.outputs.dependency-type == 'direct:development' &&
          steps.metadata.outputs.update-type == 'version-update:semver-patch'
        run: gh pr merge --auto --squash "$PR_URL"
        env:
          PR_URL: ${{ github.event.pull_request.html_url }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**适用范围**：
- 仅开发依赖（development dependencies）
- 仅 patch 版本更新（如 1.0.0 → 1.0.1）
- 必须通过 CI 测试

### 2. 为 Dependabot PR 添加标签

当前已有 `auto-label.yml`，Dependabot PR 会自动获得 `dependencies` 标签。

### 3. 配置 PR 大小限制

创建 `.github/workflows/pr-size-check.yml`：

```yaml
name: PR Size Check

on: pull_request

permissions:
  pull-requests: write

jobs:
  size-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      
      - name: Check PR size
        uses: actions/github-script@v7
        with:
          script: |
            const pr = context.payload.pull_request;
            const additions = pr.additions;
            const deletions = pr.deletions;
            const total = additions + deletions;
            
            // Dependabot PR 豁免检查
            if (pr.user.login === 'dependabot[bot]') {
              console.log('Dependabot PR - skipping size check');
              return;
            }
            
            let label = null;
            let message = null;
            
            if (total > 1000) {
              label = 'size/XL';
              message = '⚠️ This PR is very large (>1000 lines). Consider splitting it.';
            } else if (total > 500) {
              label = 'size/L';
              message = 'This PR is large (>500 lines). Please ensure thorough review.';
            } else if (total > 200) {
              label = 'size/M';
            } else {
              label = 'size/S';
            }
            
            // 添加大小标签
            await github.rest.issues.addLabels({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: pr.number,
              labels: [label]
            });
            
            // 大型 PR 添加评论
            if (message) {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: pr.number,
                body: message
              });
            }
```

## 实施优先级

| 功能 | 优先级 | 风险 | 建议 |
|-----|--------|------|------|
| 自动合并（development + patch） | 🟢 低 | 低 | 可选，减少手动合并工作 |
| PR 大小检查 | 🟡 中 | 无 | 推荐，改善代码审查体验 |
| 更频繁的扫描（daily） | 🔴 高 | 中 | 不推荐，PR 噪音过大 |

## 验证清单

实施后验证：

- [ ] Dependabot 创建的 PR 自动添加标签
- [ ] 开发依赖的 patch 更新自动合并（需 CI 通过）
- [ ] 成本监控 workflow 正确统计 Dependabot PR
- [ ] 大型 PR 正确添加 size 标签

## 配置维护

定期审查（每季度）：
- 检查自动合并规则是否过于激进
- 评估依赖更新频率（weekly vs monthly）
- 清理不再使用的依赖

---

**注意**：当前 dependabot.yml 已是生产配置，建议先观察一周效果再决定是否添加自动合并。
