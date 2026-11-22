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
 * 分组只是给下拉一个可读的结构；`label` 直接用 token，不新增 i18n key（resource 是
 * 后端写入的机器码，翻译它反而让「知道 CSV 里那个 code」的人找不到）。
 */
export type ResourceOptionGroup = {
  label: string;
  options: { value: string; label: string }[];
};

/** 按域分组、组内字母序。resources 数组的字符串字面量是守卫的扫描对象，勿改成模板。 */
export const AUDIT_RESOURCE_GROUPS: readonly { label: string; resources: readonly string[] }[] = [
  { label: '任务', resources: ['task', 'task_execution', 'task_template'] },
  { label: '应用', resources: ['application', 'app_deployment', 'artifact'] },
  { label: 'SOP', resources: ['sop', 'sop_assignment', 'sop_clarification'] },
  { label: '认证与密钥', resources: ['api_key', 'auth', 'user'] },
  { label: '项目', resources: ['project', 'project_member'] },
  {
    label: '通知',
    resources: [
      'notification',
      'notification_channel',
      'notification_digest',
      'notification_fanout',
      'notification_silence',
    ],
  },
  { label: '事件订阅', resources: ['event_subscription', 'event_subscription_dead_letter'] },
  { label: '配置与执行器', resources: ['config', 'executor'] },
  { label: '制品库', resources: ['registry', 'registry-package'] },
];

/** antd `<Select options>` 的分组形状（label=域名，options=该域的 resource token）。 */
export const RESOURCE_OPTIONS: ResourceOptionGroup[] = AUDIT_RESOURCE_GROUPS.map((group) => ({
  label: group.label,
  options: group.resources.map((value) => ({ value, label: value })),
}));
