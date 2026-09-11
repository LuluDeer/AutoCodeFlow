// UI-10 中文文案（默认 + fallback）。扁平 key，逐页迁移时把该页文案搬进来；
// 未迁移页仍为页面内硬编码中文，本文件只承载已迁移面 + 公共项。
export default {
  // ── 公共品牌 ──
  'brand.tagline': '企业级任务调度平台',
  'brand.edition': 'AutoCodeFlow v1.0 · 企业版',

  // ── 登录页 ──
  'login.account': '登录账号',
  'login.twoFactor': '两步验证',
  'login.username': '用户名',
  'login.password': '密码',
  'login.password.placeholder': '密码',
  'login.username.required': '请输入用户名',
  'login.password.required': '请输入密码',
  'login.username.aria': '用户名',
  'login.password.aria': '密码',
  'login.username.placeholder': 'admin',
  'login.submit': '登录',
  'login.verifySubmit': '验证并登录',
  'login.credentialsMissing': '登录响应缺少凭据',
  'login.badCredentials': '用户名或密码错误',
  'login.totpCode': '动态验证码',
  'login.totpCode.required': '请输入 6 位动态验证码',
  'login.totpCode.placeholder': '6 位动态码',
  'login.totpCode.aria': '动态验证码',
  'login.totpCode.invalid': '动态验证码错误',
  'login.totpHint': '请打开验证器应用获取动态码',
  'login.forgotHint': '如忘记密码请联系管理员重置',
} as const;