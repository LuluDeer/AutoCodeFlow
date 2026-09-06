# ADR-008: 真机冒烟是调度/队列/迁移的验收要件

状态：Accepted（N2/N1/迁移链/分步表单 四次前科）

## 背景

- N2（P0）：PG enum 列运行时返回字符串 label，原样传 BullMQ → **所有调度入队 100% 失败**——单测全 mock queue 从未暴露；
- N1：全新库迁移链 3 处断裂（历史靠 DB_SYNCHRONIZE=true 掩盖，空库纯迁移链任务创建 500）；
- 分步表单 P0：validateFields 只回当前挂载字段 → 创建 UI 完全不可用（vitest 难覆盖真实分步挂载）。

## 决策

调度器/BullMQ/迁移/复杂表单的改动，验收标准必须包含 compose 真机冒烟（docs/VERIFY-MATRIX.md §三按变更类型必跑表）；"mock 一切不等于能跑"。

## 后果

- 迁移链双轮幂等 job + 实体↔迁移漂移守卫进 CI（第十五轮 e2e-full 教训固化）。
- 真机验证的断言场景直接转化为可观测分类（autoflow_execution_callback_auth_total 七分类 = 验证脚本的 401 场景一一对应）。
