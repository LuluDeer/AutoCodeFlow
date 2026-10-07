# 参与贡献

## 许可证结构（分域）

AutoCodeFlow 采用分组件许可，完整说明见根 README「开源协议」一节：

| 许可域 | 覆盖范围 |
|---|---|
| **AGPL-3.0-only**（根 [`LICENSE`](LICENSE)） | `apps/` 平台核心全部组件、`packages/docs-site` |
| **MIT**（各包目录内 `LICENSE`） | `acf-cli`、`autocodeflow-node-sdk`、`autoflow-sdk`、`mcp-server`、`autocodeflow-http/-ai/-notify/-db`、协议契约 `executor-protocol` 与 `contract-fixtures` |

向某目录提交改动，即表示你同意将该改动按其所属许可域授权发布。请勿跨许可域拷贝代码：确需复用时，抽到对应许可域的公共包，或先开 issue 与维护者讨论归属。

## DCO（Developer Certificate of Origin）

所有提交必须携带签署声明（`Signed-off-by`），表明你本人有权按上述许可证提交这些代码：

```bash
git commit -s            # 单提交签署
git rebase --exec 'git commit --amend --no-edit -s' <base>   # 历史补签
```

缺少签署的提交会在 PR 审核中被要求修正后才能合入。
