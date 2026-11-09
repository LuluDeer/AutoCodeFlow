"""⚠️ 生成物，勿手改 —— 由 scripts/generate-executor-protocol.mjs 生成。

来源：packages/executor-protocol/protocol.json 的 networkPolicy.metadataAddresses（ADR-029）。
语义：任何 posture × 任何开关状态都 DENY；判定必须在风险分类之前。
"""

METADATA_ADDRESSES = ["100.100.100.200/32","192.0.0.192/32"]
