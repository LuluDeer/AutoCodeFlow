---
layout: home

hero:
  name: AutoCodeFlow SDK
  text: 双语言任务开发工具包
  tagline: Node.js 与 Python 双 SDK，同一回调契约、同一能力矩阵、同一发布节奏（lockstep 1.0.1）
  actions:
    - theme: brand
      text: 快速开始（5 分钟）
      link: /getting-started
    - theme: alt
      text: 能力矩阵
      link: /capability-matrix
    - theme: alt
      text: 官方示例库
      link: /examples

features:
  - icon: 🧩
    title: 双 SDK 完全对齐
    details: 回调契约（CallbackItemDto）、per-execution token 鉴权链、fail-closed 禁用语义逐项对齐——差异逐条留档，见能力矩阵。
    link: /capability-matrix
    linkText: 查看 23 项逐项对照
  - icon: 📦
    title: 两套参考任选
    details: Node.js（@autocodeflow/sdk，npm）与 Python（autoflow-sdk，PyPI）各自完整的安装、凭据 env、HTTP / 日志 / 回调 API 表。
    link: /sdk-node
    linkText: Node.js 参考
  - icon: 🗂️
    title: 可复制即跑的示例
    details: 回调上报（能力探测 + 成功/失败双路径）与私服依赖（PYPI_REGISTRY_URL / NPM_REGISTRY_URL）四组官方示例。
    link: /examples
    linkText: 浏览示例库
  - icon: 🔒
    title: 契约单一事实源
    details: 四客户端包（CLI / MCP / 双 SDK）共享同一份 contract.json 契约向量，信封拆包行为不再漂移。
    link: /contract
    linkText: 阅读契约
---
