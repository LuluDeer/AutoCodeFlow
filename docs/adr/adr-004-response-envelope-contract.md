# ADR-004: 响应信封是隐形契约

状态：Accepted

## 背景

admin-api 全局 ResponseInterceptor 把成功响应包成 `{code, message, data}`。这个包装在 acf-cli（round-4 P0：CLI 全命令 401 误判）、executor-node（round-8：fetchToken 读 response.data.token 恒 undefined → 旋转风暴）、mcp-server 三处独立造成过 P0/P1。状态码侧还有第二坑：Nest POST 默认 201，`=== 200` 判定静默丢弃成功响应。

## 决策

1. 信封保留（前端 axios client 已依赖拆包语义，改契约的迁移成本大于收益）；
2. **任何新客户端的第一件事是拆包 util**（unwrapAdminResponseData / unwrap / unwrap_envelope），状态码一律 2xx 区间判定（`>= 200 && < 300`）；
3. 拆包 util 对"非信封形态"passthrough（webhook/registry 等非包装端点共用）。

## 后果

- 客户端包（CLI/MCP/双 SDK）现各有对称拆包；契约测试 fixture 统一化是 QA-07 的后续方向（防四端再漂移）。
