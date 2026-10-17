# 安全加固优化计划

**优先级**: 高  
**预计工作量**: 3-5 人天  
**目标**: 在已修复 P1 安全缺陷基础上，进一步提升系统安全性

---

## 1. 限流器白名单自动化校验

### 背景
当前 P1-1 的修复引入了 EXECUTOR_MACHINE_PATH_PATTERNS 白名单，但依赖开发者手动维护，易遗漏。

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

### 优化方案

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

### 优化方案

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

### 优化方案

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

## 实施路线图

### 阶段 1（本月）- 高优先级
- [ ] 1.1 限流白名单静态检查（纳入 CI）
- [ ] 1.2 限流白名单运行时警告
- [ ] 2.1 SSE ticket 使用审计日志
- [ ] 3.1 密码强度实时反馈（admin-web）

### 阶段 2（下月）- 中优先级
- [ ] 2.2 异常票据告警（Prometheus）
- [ ] 3.3 账户活动时间线（admin-web）
- [ ] 4.1 DNS rebinding 防护

### 阶段 3（下季度）- 低优先级
- [ ] 3.2 泄露密码检查
- [ ] 4.2 请求出口代理隔离
- [ ] 5.1-5.3 API 密钥权限细化
- [ ] 6.1-6.2 审计日志签名链

---

## 依赖项

- `zxcvbn`: 密码强度检测
- `squid`: 出口代理（docker 镜像）
- Prometheus/Grafana: 指标与告警

## 验收标准

- [ ] 所有新增代码有单元测试覆盖
- [ ] CI 新增检查全部通过
- [ ] 文档更新（README / 运维手册）
- [ ] 安全审计报告更新
