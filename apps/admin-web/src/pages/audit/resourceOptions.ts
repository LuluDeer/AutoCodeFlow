/**
 * 审计页 resource 过滤器的**完整选项集**。
 *
 * 为什么需要它：后端 `applyAuditFilters` 对 resource 是**精确匹配**，DTO 接受任意
 * 字符串；实际写入的 resource 有 20+ 种（sop / api_key / app_deployment /
 * task_execution / event_subscription* / artifact …），而旧页面只硬编码了 5 个
 * `<Option>`。用户在列表里看得到 `resource=sop` 的行，下拉里却选不到 sop ——
 * 「能查到、筛不到」。
 *
 * 控件本身用 `mode="tags"`（与同页 action 过滤器同构）：既能从这份完整清单里点选，
 * 也能直接输入任意 token（后端接受任意字符串，不该被前端清单绑死）。这份清单负责
 * 「可发现」，tags 负责「不设限」，二者互补。
 *
 * 外提成独立文件有两个好处：
 *   · `pages/audit/index.tsx` 已双顶格（size-caps 棘轮），清单放进去必然破顶；
 *   · __tests__/audit-action-labels.test.ts 的 resource 守卫可以直接对这份文件做 AST
 *     扫描（选项与后端写入集合求差），新增 resource 写入而清单没跟上 ⇒ 测试红。
 *
 * 分组只是给下拉一个可读的结构；`label` 是 **i18n key**（不硬编码中文），由消费方
 * 用 `t(label)` 翻译。组内 `resources` 仍是后端机器码 token（保持原样，翻译反而让
 * 「知道 CSV 里那个 code」的人找不到）。
 */
export type ResourceOptionGroup = {
  label: string;
  options: { value: string; label: string }[];
};
type Translate = (key: string) => string;

/** 按域分组、组内字母序。resources 数组的字符串字面量是守卫的扫描对象，勿改成模板。 */
export const AUDIT_RESOURCE_GROUPS: readonly { labelKey: string; resources: readonly string[] }[] = [
  { labelKey: 'audit.group.task', resources: ['task', 'task_execution', 'task_template'] },
  { labelKey: 'audit.group.application', resources: ['application', 'app_deployment', 'artifact'] },
  { labelKey: 'audit.group.sop', resources: ['sop', 'sop_assignment', 'sop_clarification'] },
  { labelKey: 'audit.group.auth', resources: ['agent_approval', 'api_key', 'auth', 'user'] },
  { labelKey: 'audit.group.project', resources: ['project', 'project_member'] },
  {
    labelKey: 'audit.group.notification',
    resources: [
      'notification',
      'notification_channel',
      'notification_digest',
      'notification_fanout',
      'notification_silence',
    ],
  },
  { labelKey: 'audit.group.eventSubscription', resources: ['event_subscription', 'event_subscription_dead_letter'] },
  { labelKey: 'audit.group.configExecutor', resources: ['config', 'executor', 'capability', 'workbench', 'ai_provider', 'im_identity'] },
  { labelKey: 'audit.group.registry', resources: ['registry', 'registry-package'] },
];

/** antd `<Select options>` 的分组形状（label=翻译后的域名，options=该域的 resource token）。 */
export function buildResourceOptions(t: Translate): ResourceOptionGroup[] {
  return AUDIT_RESOURCE_GROUPS.map((group) => ({
    label: t(group.labelKey),
    options: group.resources.map((value) => ({ value, label: value })),
  }));
}

const KNOWN_AUDIT_RESOURCES = new Set<string>(
  AUDIT_RESOURCE_GROUPS.flatMap((group) => group.resources),
);

/**
 * 审计列表资源类型展示名：对已收录的 25 项，按 `audit.resource.` 前缀拼接 token
 * 组成 key 交给 t() 翻译，输出中英文；未知 token 原样回退（保留可检索性，不抹成"未知资源"）。
 */
export function formatAuditResource(v: string | null | undefined, t: Translate): string {
  if (!v) return '—';
  if (!KNOWN_AUDIT_RESOURCES.has(v)) return v;
  const key = `audit.resource.${v}`;
  const label = t(key);
  return label && label !== key ? label : v;
}

/**
 * 审计 IP 展示格式化：剥离 IPv4-mapped IPv6 前缀 `^::ffff:`，完整原值交由外层 Tooltip 保留。
 */
export function formatAuditIp(ip: string | null | undefined): string {
  if (!ip) return '';
  return ip.replace(/^::ffff:/i, '');
}
