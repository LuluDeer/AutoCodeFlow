# ADR-014: OIDC SSO 单点登录

- 状态：Accepted
- 日期：2026-09-13
- 关联：AUTH-04、SEC-03（TOTP）、SEC-02（refresh token）、ADR-013 前档（授权面）

## 背景

平台面向企业部署，用户要求支持以企业既有 IdP（Keycloak / Entra ID / Okta 等）
登录，避免为每位成员手工建号与记密码。此前登录面只有「用户名 + 密码（+ 可选
TOTP）」；Auth 模块（SEC-02/03）已有成熟的 JWT 对签发、refresh 持久化与会话管理。

## 决策

1. **协议形态：OIDC Authorization Code Flow，confidential client**。
   admin-api 为机密客户端（client_secret_post 换 token），服务端完成 code
   交换与 ID Token 验签——浏览器/前端永不接触 IdP 凭据。不实现 PKCE
   （confidential client + 服务端保管 state 已覆盖其威胁面；启用 PKCE 留后续
   兼容性扩展）。不支持 implicit / 密码模式（已被 OIDC 工作组废弃）。

2. **验证面：RS256 + JWKS，node:crypto 零新依赖**。ID Token 验签覆盖
   iss（尾斜杠归一）/ aud / exp（±60s 时钟偏移）/ iat（拒未来）/ nonce；
   alg 白名单仅 RS256（防 `alg=none` 与 HS256 混淆攻击）。JWKS 与
   discovery 文档进程内缓存（10min / 1h），kid 未知时整体验证失败（不自动
   轮换重取，属可接受的运维边界）。

3. **多实例友好的无状态 state**：state+nonce 打包 JSON 后以 HMAC-SHA256
   （密钥=JWT_REFRESH_SECRET，部署必配）签名放 HttpOnly SameSite=Lax cookie
   （Path 收窄到 callback，10 分钟）。不引入服务端会话存储，双实例/多实例
   下任一回调实例都可独立校验。callback 同时比对 query state 与 cookie 内
   state（防跨流程注入）；所有比较走 timingSafeEqual。

4. **身份绑定三级**（ADR 核心裁定）：
   - ① `users.oidcSub` 精确匹配（迁移 1790000000016，可空 + 唯一部分索引）；
   - ② username 声明匹配（`OIDC_USERNAME_CLAIM`，默认 preferred_username）
     且未绑定 → **首登写入 sub 完成绑定**；已绑定其他 sub → 拒绝（不静默
     换绑，防账号接管）；
   - ③ JIT 自动建号：仅当 `OIDC_AUTO_PROVISION=true`（默认 false）——建
     USER 角色账号、随机占位密码（SSO 账号不走密码面，直接 repo.create
     绕过密码强度校验——占位密码不参与认证）。默认关闭是刻意的保守姿态：
     防止公网可达的登录页被未授权 IdP 成员批量建号。
   - email 不作为身份主键（可变且可重定向）；仅作 JIT 建号资料。

5. **令牌回传：URL `#fragment`**。callback 签发平台 JWT 对后 302 到
   `OIDC_WEB_REDIRECT_URL`（前端落地页 `/auth/sso/complete`），token 放
   fragment——浏览器不向服务器发送 fragment，不进服务器/反代访问日志；
   前端落地页解析后立即 `history.replaceState` 抹除。SSO 用户与本地登录
   共用同一会话面（SEC-02 refresh 持久化 / SEC-03 TOTP 互不影响——TOTP
   仅作用于密码登录链路，SSO 身份由 IdP MFA 责任面承担）。

6. **出站态势对齐**：issuer/discovery/token/JWKS 出站走 assertSafeHttpUrl
   姿态闸——默认拒内网；自建内网 IdP 用 `OIDC_ALLOW_PRIVATE_NETWORK=true`
   显式放行（云元数据段恒拒），与 AI/executor/事件订阅豁免开关同形态。

## 后果

- 本地密码登录为默认且零变化（`OIDC_ENABLED=false` 时 SSO 端点整体关闭，
  status 除外）。
- SSO 与 TOTP 正交：IdP 侧启用 MFA 的企业不再需要平台侧 TOTP；本地账号
  仍可独立开启 TOTP。
- 已知边界（如实）：JWKS 轮换需等 10min 缓存过期或重启；单 IdP（不做多
  IdP 路由）；不做 SCIM/组同步——角色仍是平台侧管理（SSO 用户恒 USER，
  提权走管理员）。

### 修订（2026-09-13，R20）：组→角色映射

- 新增 `OIDC_GROUPS_CLAIM`（默认 `groups`）与 `OIDC_ADMIN_GROUPS`（逗号分隔
  清单，默认空）：**仅在 JIT 自动建号时生效**——命中清单内任一组即建 ADMIN
  账号，否则 USER；清单为空恒 USER（与未配置一致）。
- 明确不做的两件事（安全边界）：① 已绑定/存量账号的**角色不随 IdP 组变化
  反向改写**——角色由平台管理员管理，避免 IdP 侧误配直接提权、也避免
  「IdP 降级 vs 平台管理员提权」的打架；② 绑定（sub 写入）仍只在首登时
  发生，不随组变化重绑。
- 生效前提仍是 `OIDC_AUTO_PROVISION=true`——两个开关必须**同时显式打开**
  才可能出现 SSO 自动建出的 ADMIN，进一步压缩误配置面。

## 验证

- 单测 24 例（oidc.service.spec 17 + oidc.controller.spec 7）：真 RS256
  签发/验签矩阵（错签/错 nonce/错 iss/错 aud/过期/错 alg/未知 kid）、
  state HMAC 篡改与过期、绑定三级与 JIT 开关矩阵、controller 302/错误码面。
- 真机套件 `npm run test:oidc-sso` **13/13**：内置 loopback mock IdP
  （discovery/JWKS/authorize/token 四端点，RS256 真签）+ 真实 admin-api，
  断言 status 开关、login 302+cookie、完整回调链发令牌、令牌真实访问
  /auth/profile、二次登录 sub 稳定绑定不重复建号、code 重放拒绝、state
  篡改拒绝、JIT 建号恰好一行。
