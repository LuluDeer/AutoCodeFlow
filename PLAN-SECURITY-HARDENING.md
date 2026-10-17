# 安全加固优化计划

**优先级**: 高  
**预计工作量**: 3-5 人天  
**目标**: 在已修复 P1 安全缺陷基础上，进一步提升系统安全性

> ## ⚠️ 实施前必读（2026-10-17 核验结论）
>
> 本计划的部分条目在编写时**基于假设**，经 CodeGraph 逐项核验后与实际代码不符。
> 下表是核验后的事实状态，**动手前先看这里**，否则会重复实现或写出回归。
>
> | 条目 | 真实状态 | 说明 |
> |---|---|---|
> | §1 限流白名单 | ✅ **已实现（本次）** | 静态守卫 `scripts/check-throttler-whitelist.mjs` + 运行时告警。**并修掉一处真实漏登记**（见下） |
> | §2 SSE 票据可观测性 | ✅ **已实现（本次）** | `autoflow_sse_ticket_rejected_total{reason}` + 告警规则 |
> | §3.1 密码强度反馈 | ⬜ 未实现 | 后端强度校验**已有**（`users.service.ts` validatePasswordStrength）；前端 zxcvbn 缺失 |
> | §4.1 DNS rebinding 防护 | ✅ **已实现，且强于本计划** | **切勿按本文实现**——见下方警告 |
> | §5 API 密钥权限细化 | ✅ **早已实现，无需动工** | 三级矩阵 + `task:trigger` 域 |
> | §6 审计日志防篡改 | ⚠️ 部分 | 已有 **append-only 触发器**；哈希链未实现，且与既有决策冲突 |
>
> **§4.1 警告**：计划建议的「两次 DNS 解析比对 + 100ms 延迟」**比现状更弱**。
> `safe-http.util.ts` 已实现 **DNS pinning**（`assertAndPinHttpUrl` +
> `pinnedAxiosConfig` 的自定义 `lookup`，永远返回已校验的 IP），从结构上关闭了
> rebinding 窗口。按计划文本实现将是**安全回归**。§4.2 出口代理隔离仍缺。
>
> **§5 结论**：`api-key-scope.util.ts` + `api-key-auth.helper.ts` 已实现
> readonly/trigger/manage × method × path 的完整矩阵，并有 4 个 spec 覆盖。
> 计划里的 `scopes: string[]` 四段式只是形态差异，不构成安全缺口。
>
> **§6 结论**：迁移 `1790000000006-AuditLogsAppendOnlyGuard` 已在 DB 层用触发器
> 禁止 UPDATE/DELETE，并留下「append-only vs 哈希链」的取舍记录——**先读那段
> 注释再决定是否引入哈希链**。另注意计划里的 `findOne({order:{id:'DESC'}})` +
> `save()` 在并发下**不是安全的链式写入**，需要串行化或 advisory lock。

---

## 1. 限流器白名单自动化校验 ✅ 已实施

### 背景
当前 P1-1 的修复引入了 EXECUTOR_MACHINE_PATH_PATTERNS 白名单，但依赖开发者手动维护，易遗漏。

### 实施结果（2026-10-17）

**核验中发现一处真实缺陷（SEC-THROTTLE-WHITELIST-GAP）**：白名单漏登记了两条
真实的执行器机器面路由——

- `GET /api/executors/config`（executor-node `pull.ts:229` 的配置热更新）
- `GET /api/executors/:address/terminal-states`（`callback.ts:633` 的死信对账）

两者都会带 `x-executor-address` 头，漏登记的后果是**静默退回按出口 IP 计桶**，
多执行器共享 NAT 出口时被叠加限流——正是该守卫当初要修的 B-2 故障形态。

**1.1 静态检查** → `scripts/check-throttler-whitelist.mjs`（零依赖，含 `--selftest`）
- 判据①：源码锚点（常量名 / 消费函数）仍在，防「找不到就静默放行」
- 判据②：`KNOWN_EXECUTOR_MACHINE_ROUTES` 每条真实路由都被白名单正则命中
- 判据③：正则可编译、白名单非空
- 集成：`npm run check:throttler-whitelist` + CI `selftests` job
- **反证已验**：删掉 `/executors/config` 那条正则 → 守卫立即报红

> 关于计划草案「从 controller 自动提取路由」：**静态不可判定**。
> `/executors/pull` 与 `/executors/picker`、`/executors/config` 与
> `/executors/runtime-config` 在装饰器形态上完全同型，「是不是机器面」只有
> 出站调用点知道。故判据锚在人工核对的出站调用点清单上，每条附 `caller` + `why`。

**1.2 运行时告警** → `executor-aware-throttler.guard.ts`
- 带机器面头却落在非白名单路径 → `warn` + 10 分钟节流 + 给出应加的正则模板
- **刻意不 throw**（计划草案建议开发环境抛错）：`getTracker` 在每个请求的限流
  路径上，灰度期新执行器版本先行上报就会把**新版本**变成硬故障；且漏登记的
  代价是可用性降级（退回 IP 桶），不是安全漏洞——绕过面已由路由白名单关闭。

### 优化方案

#### 1.1 编译时静态检查（推荐）
```typescript
// scripts/check-throttler-whitelist.mjs
import { glob } from 'glob';
import { readFileSync } from 'fs';

// 从 executor.controller.ts 提取所有 @Post/@Get 路由
const controllerRoutes = extractExecutorRoutes('apps/admin-api/src/modules/executor/executor.controller.ts');

// 从 throttler guard 读取白名单
const whitelist = extractWhitelist('apps/admin-api/src/common/guards/executor-aware-throttler.guard.ts');

// 比对：controller 里的路由是否全在白名单中
const missing = controllerRoutes.filter(r => !whitelist.some(w => w.test(r)));
if (missing.length > 0) {
  console.error('ERROR: 以下执行器路由未登记在限流白名单中：');
  missing.forEach(r => console.error(`  - ${r}`));
  process.exit(1);
}
```

**集成点**: 
- `package.json`: `"check:throttler-whitelist": "node scripts/check-throttler-whitelist.mjs"`
- `.github/workflows/ci.yml`: 在 admin-api typecheck 后执行

#### 1.2 运行时 fail-fast 警告
```typescript
// executor-aware-throttler.guard.ts
getTracker(context: ExecutionContext): string | Promise<string> {
  const req = context.switchToHttp().getRequest();
  const path = req.path || req.url;
  const execAddr = req.headers?.['x-executor-address'];
  
  if (execAddr) {
    const isWhitelisted = EXECUTOR_MACHINE_PATH_PATTERNS.some(p => p.test(path));
    if (!isWhitelisted) {
      // 新增：生产环境记 warn，开发环境抛错
      const msg = `Executor header on non-whitelisted path: ${path}`;
      if (process.env.NODE_ENV === 'production') {
        this.logger.warn(msg + ' (fallback to IP-based throttling)');
      } else {
        throw new Error(msg + ' - Please add this path to EXECUTOR_MACHINE_PATH_PATTERNS');
      }
    }
    return isWhitelisted ? `executor:${execAddr}` : this.defaultTracker(req);
  }
  return this.defaultTracker(req);
}
```

---

## 2. JWT 凭据生命周期可观测性

### 背景
P1-2 修复了 SSE ticket 提权，但没有监控手段追踪票据使用情况。

### ✅ 2.2 已实施（2026-10-17）

新增计数器 `autoflow_sse_ticket_rejected_total{reason="wrong_path"}`，埋点在
`jwt.strategy.ts` 的 `assertTicketOnlyOnStreamPath` 拒绝分支，配告警
`AUTOFLOW_SSE_TICKET_REJECTED`（`config/monitoring/alerts.yml`，阈值 >0 / 15m）。

**为什么这是最高价值的一项**：P1-2 把泄漏面关掉了，但**修复本身零可观测性**
——一枚泄漏的 30 秒票据被拿去打 REST 端点时，系统只是静默 401，没有计数器、
没有审计、没有告警。这条 counter 是「票据正在被试探复用」的唯一信号。

阈值取 **>0 而非速率**：合法前端从不会把票据放进 Authorization 头
（EventSource 只在三条 `/stream` 路由的 `?ticket=` 上带），故任何一次拒绝
都意味着有人拿到了票据文件。误报面极低，宁可一次就报。

**2.1（票据使用审计）未实施，理由**：`AuditService.log()` 每次调用是一次 DB
写入，而 SSE 重连（前端断线重连、多标签页、刷新页面）会高频触发——给每条
合法的流建立都写一条审计，会把审计表变成连接日志噪声，反而淹没真正的安全
事件。**拒绝路径**（异常行为）才值得记账，这正是 2.2 落地的东西。
若后续确实需要「谁在何时建了流」，更合适的是采样 + 独立轻量表，而非塞进
append-only 的审计表。

### 优化方案（原始草案，供参考）

#### 2.1 票据使用审计日志
```typescript
// jwt.strategy.ts validate() 方法末尾
if (payload.type === 'sse_ticket') {
  this.auditService.log({
    action: 'SSE_TICKET_USED',
    userId: user.id,
    path: requestPath(req),
    ticketId: payload.jti,
    expiresAt: new Date(payload.exp * 1000),
  });
}
```

#### 2.2 异常票据使用告警
```typescript
// 新增 Prometheus 指标
this.metricsService.counter('auth_sse_ticket_rejected_total', {
  reason: 'wrong_path',
  attempted_path: requestPath(req),
});

// 告警规则（Prometheus/Grafana）
// 当 5 分钟内同一用户的票据被拒次数 > 10 时触发
rate(auth_sse_ticket_rejected_total[5m]) > 10
```

---

## 3. 密码策略与账户安全增强

### 背景
P1-3 修复了用户名枚举，但密码策略本身还可加强。

### 核验结论（2026-10-17）

- **后端强度校验已存在**：`apps/admin-api/src/modules/users/users.service.ts`
  的 `validatePasswordStrength`（≥8 位 + 大写 + 数字 + 特殊字符），错误码
  `PASSWORD_TOO_SHORT` / `PASSWORD_NEEDS_UPPERCASE` / `PASSWORD_NEEDS_DIGIT` /
  `PASSWORD_NEEDS_SPECIAL`，create 与 update 两条路径都已接入。
- **前端已有同规则校验**：`SecuritySettings.tsx` 与 `UserManagementPage.tsx`
  有对应的 regex 规则（与后端同口径），但**没有**强度计/反馈。
- **3.3 账户活动时间线实际已存在**：`SecuritySettings.tsx` 的 `SessionsCard`
  已展示设备/登录时间/当前会话标记/撤销操作（形态是表格而非 Timeline，
  功能等价）。

故 **3.1（zxcvbn 强度计）是唯一真正缺失的项**，3.2（HIBP）为可选项，
3.3 无需再做。

> **实施 3.1 的注意事项**：新增依赖 `zxcvbn` + `@types/zxcvbn`；所有新增
> 文案必须走 i18n（`lint:i18n` / `i18n-scan.mjs` 是 CI 门禁，硬编码字符串会红）；
> 强度计**只能增加提示，不得改变提交阻断规则**——现有 spec
> （`security-password.test.tsx`、`user-management-page.test.tsx`）钉住了
> 校验消息与提交流程。

### 优化方案（原始草案，供参考）

#### 3.1 密码强度实时反馈（admin-web）
```typescript
// components/PasswordStrengthMeter.tsx
import zxcvbn from 'zxcvbn';

export function PasswordStrengthMeter({ password }: { password: string }) {
  const result = zxcvbn(password);
  const strength = ['很弱', '弱', '中等', '强', '很强'][result.score];
  const color = ['red', 'orange', 'yellow', 'lime', 'green'][result.score];
  
  return (
    <div>
      <Progress percent={(result.score + 1) * 20} strokeColor={color} />
      <div>强度: {strength}</div>
      {result.feedback.warning && <Alert type="warning" message={result.feedback.warning} />}
      {result.feedback.suggestions.map(s => <div key={s}>💡 {s}</div>)}
    </div>
  );
}
```

**集成点**: UserFormPage / ChangePasswordPage

#### 3.2 泄露密码检查（可选）
集成 [Have I Been Pwned API](https://haveibeenpwned.com/API/v3) 的 k-anonymity 模式：
```typescript
// auth.service.ts
async checkPasswordPwned(password: string): Promise<boolean> {
  const hash = sha1(password).toUpperCase();
  const prefix = hash.substring(0, 5);
  const suffix = hash.substring(5);
  
  const resp = await axios.get(`https://api.pwnedpasswords.com/range/${prefix}`);
  return resp.data.split('\n').some(line => line.startsWith(suffix));
}
```

#### 3.3 账户活动时间线（admin-web）
```typescript
// pages/UserDetailPage.tsx 新增 tab
<Tabs.TabPane tab="活动时间线" key="timeline">
  <Timeline>
    {sessions.map(s => (
      <Timeline.Item color={s.isActive ? 'green' : 'gray'}>
        {s.createdAt} - {s.userAgent} - {s.ipAddress}
        {s.isActive && <Tag>当前会话</Tag>}
      </Timeline.Item>
    ))}
  </Timeline>
</Tabs.TabPane>
```

---

## 4. SSRF 防护升级

### 背景
当前 assertSafeHttpUrl 已有基础防护，但可进一步加强。

### ⛔ 核验结论（2026-10-17）：4.1 已实现且强于本计划，**请勿按本文实施**

`safe-http.util.ts` 的实际防护**超过**计划描述：

- 统一拒绝表 `IPV4_DENY_SEGMENTS` / IPv6 段表：RFC1918、CGNAT `100.64/10`、
  loopback、link-local `169.254/16`（含云 metadata 端点）、benchmarking、
  multicast、reserved；含 IPv4-mapped 归一化（`classifyAddressRisk`）。
- `assertSafeHttpUrl`：协议白名单、拒绝 userinfo、**逐条校验每个 DNS 应答**。
- **DNS pinning 已存在**：`assertAndPinHttpUrl` 解析后钉住一个 IPv4 优先的 IP，
  `pinnedAxiosConfig` 用自定义 `http(s).Agent.lookup` **永远返回已校验的 IP**
  ——从结构上关闭了 rebinding 窗口。36 处调用点在用。
- 测试：`safe-http.util.spec.ts`（pinning / `all:true` 数组形态）+
  `ssrf-deny-matrix.spec.ts`。

> **本计划的 4.1 是回归风险**：两次 `resolve4` + 100ms 延迟的比对，比 pinning
> **严格更弱**（TOCTOU 窗口只是变窄，没有消失）。**不要实现它。**

**4.2（出口代理隔离）仍是真实缺口**：三个 compose 文件都没有 `egress-proxy`
服务，也没有 `HTTP_PROXY` / `HTTPS_PROXY`。实施时注意：

- `scripts/check-compose-sandbox.mjs`、`scripts/ha-compose-selftest.mjs`、
  `scripts/check-env-drift.mjs` 都解析 compose 文件，改动会触发它们；
- `NO_PROXY` **必须**覆盖 `postgres,redis,executor-*`，否则执行器与私有
  registry 流量会被塞进代理而中断。

### 优化方案（原始草案，供参考——见上方结论）

#### 4.1 DNS rebinding 防护
```typescript
// safe-http.util.ts
export async function assertSafeHttpUrl(url: string): Promise<void> {
  // 现有检查...
  
  // 新增：双重解析防 DNS rebinding
  const firstResolve = await dns.promises.resolve4(parsed.hostname);
  await new Promise(r => setTimeout(r, 100)); // 延迟 100ms
  const secondResolve = await dns.promises.resolve4(parsed.hostname);
  
  if (!arraysEqual(firstResolve, secondResolve)) {
    throw new AppError('SSRF_DNS_REBINDING_DETECTED', { hostname: parsed.hostname });
  }
  
  // 检查每个解析出的 IP
  for (const ip of firstResolve) {
    if (isPrivateIp(ip)) {
      throw new AppError('SSRF_PRIVATE_IP_DETECTED', { ip });
    }
  }
}
```

#### 4.2 请求出口代理隔离（部署层）
```yaml
# docker-compose.yml 新增 egress-proxy 服务
egress-proxy:
  image: squid:6-alpine
  volumes:
    - ./squid.conf:/etc/squid/squid.conf:ro
  networks:
    - internal

# admin-api 通过代理访问外部
admin-api:
  environment:
    HTTP_PROXY: http://egress-proxy:3128
    HTTPS_PROXY: http://egress-proxy:3128
    NO_PROXY: "postgres,redis,executor-*"
```

---

## 5. API 密钥权限细化

### 背景
当前 API Key 只有全局开关，没有细粒度权限。

### 优化方案

#### 5.1 引入 scope 字段
```typescript
// entities/api-key.entity.ts
@Entity('api_keys')
export class ApiKey {
  // ... 现有字段
  
  @Column('simple-array', { nullable: true })
  scopes?: string[]; // ['tasks:read', 'tasks:write', 'executions:read']
}
```

#### 5.2 守卫层校验
```typescript
// decorators/api-scopes.decorator.ts
export const ApiScopes = (...scopes: string[]) => SetMetadata('apiScopes', scopes);

// guards/api-scope.guard.ts
@Injectable()
export class ApiScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const requiredScopes = this.reflector.get<string[]>('apiScopes', context.getHandler());
    if (!requiredScopes) return true;
    
    const req = context.switchToHttp().getRequest();
    const apiKey = req.user as ApiKeyUser;
    if (!apiKey.scopes) return false; // 旧 key 无 scopes 视为无权限
    
    return requiredScopes.every(s => apiKey.scopes.includes(s));
  }
}

// 使用示例
@Get()
@ApiScopes('tasks:read')
async list() { ... }
```

#### 5.3 admin-web UI
```typescript
// pages/ApiKeysSettings.tsx
<Form.Item label="权限范围">
  <Checkbox.Group>
    <Checkbox value="tasks:read">读取任务</Checkbox>
    <Checkbox value="tasks:write">创建/更新任务</Checkbox>
    <Checkbox value="executions:read">读取执行记录</Checkbox>
    <Checkbox value="executors:read">读取执行器状态</Checkbox>
  </Checkbox.Group>
</Form.Item>
```

---

## 6. 审计日志不可篡改性

### 背景
当前审计日志在 PostgreSQL 中，理论上可被 ADMIN 修改。

### 优化方案

#### 6.1 引入审计日志签名链
```typescript
// entities/audit-log.entity.ts
@Entity('audit_logs')
export class AuditLog {
  // ... 现有字段
  
  @Column({ type: 'text', nullable: true })
  previousHash?: string; // 前一条日志的 SHA256
  
  @Column({ type: 'text' })
  selfHash: string; // 本条日志的 SHA256（含 previousHash）
}

// audit.service.ts
async log(entry: AuditLogDto): Promise<void> {
  const latest = await this.repo.findOne({ order: { id: 'DESC' } });
  const previousHash = latest?.selfHash || '0000000000000000000000000000000000000000000000000000000000000000';
  
  const payload = JSON.stringify({ ...entry, previousHash });
  const selfHash = createHash('sha256').update(payload).digest('hex');
  
  await this.repo.save({ ...entry, previousHash, selfHash });
}
```

#### 6.2 完整性校验脚本
```typescript
// scripts/verify-audit-log-integrity.mjs
const logs = await db.query('SELECT * FROM audit_logs ORDER BY id');
let expectedHash = '0000...';

for (const log of logs) {
  const payload = JSON.stringify({ ...log, selfHash: undefined });
  const computedHash = createHash('sha256').update(payload).digest('hex');
  
  if (computedHash !== log.selfHash) {
    console.error(`INTEGRITY BREACH: Log #${log.id} has been tampered`);
    process.exit(1);
  }
  expectedHash = log.selfHash;
}
```

---

## 实施路线图（2026-10-17 核验后重排）

### ✅ 已完成
- [x] **1.1 限流白名单静态检查**（`scripts/check-throttler-whitelist.mjs`，已纳入 CI）
- [x] **1.2 限流白名单运行时警告**（含节流 + 正则模板提示）
- [x] **1.1b 白名单漏登记修复**（`/executors/config`、`/executors/:address/terminal-states`）
- [x] **2.2 异常票据计数 + 告警**（`autoflow_sse_ticket_rejected_total` + `AUTOFLOW_SSE_TICKET_REJECTED`）
- [x] **4.1 DNS rebinding 防护**——**早已实现且强于计划**（DNS pinning），无需动工
- [x] **5.1-5.3 API 密钥权限细化**——**早已实现**（三级矩阵 + `task:trigger`）
- [x] **3.3 账户活动时间线**——**已存在**（`SecuritySettings.tsx` SessionsCard）

### ⬜ 仍然待办（按建议优先级）
1. ~~**3.1 密码强度实时反馈**~~ ✅ **已完成（2026-10-17 第三轮）**——**未采用
   zxcvbn**（约 800KB，且它是**第二套真值源**：其 "strength" 判定与后端**策略
   合规性**是两件事，会出现"zxcvbn 说 strong、后端 400"的错配）。改为：
   · `apps/admin-web/src/utils/passwordPolicy.ts` = 后端 `validatePasswordStrength`
     的**语义镜像**（最小长度 + uppercase/digit/special 三规则 + 单条合取正则）；
   · `components/PasswordStrengthMeter.tsx` 实时强度 + 逐条规则清单，**强度受合规性
     封顶**（不合规绝不显示 good/strong——单测在 600+ 探针上核验该不变量）；
   · **顺带修掉一个真实缺陷**：`UserManagementPage` 的新建/重置密码两处内联正则
     含 `(?=.*[a-z])`，**比后端更严**（后端不要求小写），会拒绝后端本可接受的密码
     如 `ADMIN2026!`；`users.field.passwordPattern` 文案同步去掉"小写字母"；
   · 新增跨组件守卫 `scripts/check-password-policy-sync.mjs`（已进 CI）：把前后端
     正则**从源码抽出来真正执行**——ASCII 全域 + 若干 Unicode 逐字符核验字符集一致
     + 517 个探针上行为等价 + 前端合并正则与其四规则合取同义；含 5 条反证自检
     （含「抄漏一个字符」「合并正则不跨换行」）。
2. **4.2 请求出口代理隔离**——⚠️ **本轮评估后判定「不建议盲接」**（决策已备齐，
   留给维护者）：squid 只有做成 **deny-by-default 白名单**才谈得上"隔离"，而本仓
   出站面包含**用户可配置**的目标（多 AI provider、SMTP、通知 webhook、注册表
   镜像），盲接 = 先把可用性打死；且它**纯配置层、离线不可验证**（计划原文亦警告
   `NO_PROXY` 必须覆盖 `postgres,redis,executor-*`，漏一个就断执行器流量）。
   前置条件：① 先盘点并固化出站白名单（含用户可配项的取舍）；② 明确代理故障时的
   降级姿态（fail-closed 会让告警/AI 全部不可用）；③ 需要真实环境验证。
3. **3.2 泄露密码检查**（可选，HIBP k-anonymity；注意出网依赖与隐私口径）
4. **6.1-6.2 审计日志哈希链**（**先读迁移 `1790000000006` 的取舍注释**；
   计划里的 `findOne` + `save` 在并发下不安全，需串行化或 advisory lock）
5. **2.1 票据使用审计**（低价值，见 §2 理由——高频 SSE 重连会淹没审计表）

---

## 依赖项

- `zxcvbn`: 密码强度检测（**尚未引入**）
- `squid`: 出口代理（docker 镜像，**尚未引入**）
- Prometheus/Grafana: 指标与告警（**已有**，`config/monitoring/`）

## 验收标准

- [x] 所有新增代码有单元测试覆盖（限流白名单 12 例 / 票据计数 4 例）
- [x] CI 新增检查全部通过（`check:throttler-whitelist` + `check-alerts-rules` 30 条规则）
- [x] 文档更新（README / 运维手册）——`docs/observability/README.md` 的
      runbook 锚点 `#autoflow_sse_ticket_rejected` 正文**已于 2026-10-17
      第二轮复核确认存在**（该文件 §3.6「Runbook：本轮新增的四条告警」，含
      触发条件、为何「正常恒为 0」、四步处置）。此前勾选项为过期状态。
- [ ] 安全审计报告更新
