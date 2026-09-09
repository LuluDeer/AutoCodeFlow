# ADR-006: RBAC 收紧与前端门控同批发布

状态：Accepted（N11/W2 两次前科）

## 背景

后端把端点收紧 ADMIN 后，普通用户的前端入口仍然可见 → "可见但点击 403" 的体验回退。N11（notification/ai config 收紧）拖延了一轮才补前端；W2（执行器管理写面）第一轮就同批补齐。

## 决策

任何 @Roles 收紧与 admin-web 的对应门控（RequireAdmin 路由守卫 / 组件内 isAdminUser 条件渲染 / 菜单隐藏）**同 commit 或同轮同批**，Playwright 角色用例同步修正；发布注记固定披露 RBAC 行为变更。

## 后果

- W2 闭环（747ea40 + f0c5f32）成为标准姿势样板。
- 角色的唯一来源是 GET /auth/profile（登录响应无 user 字段）——前端不得从别处推断。
