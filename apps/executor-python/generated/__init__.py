"""A3（DEEP_REVIEW 0ef3bbe §七）：由 protocol.json 生成的协议 schema（pydantic）。

本目录内容由 `node scripts/generate-executor-protocol.mjs` 生成，随源码同 commit；
CI 的 executor-protocol-drift job 会重跑生成器并 `git diff --exit-code` 兜底。
手改会被下次生成覆盖——要改请改 `packages/executor-protocol/protocol.json`。
"""
