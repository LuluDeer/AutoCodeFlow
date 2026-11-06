// ⚠️ 生成物，勿手改 —— 由 scripts/generate-executor-protocol.mjs 生成。
// 来源：packages/executor-protocol/protocol.json 的 networkPolicy.categories（ADR-034 步骤 1）。
// 语义：类别单一事实源；CATEGORY_ORDER = 契约类别；ALLOWED_UNDER_PRIVATE = 开关唯一可解锁的类别；
//        END_LABELS.admin = admin 侧的历史标签映射（不参与判定，只改名）。
export const CATEGORY_ORDER: readonly string[] = ["loopback","privateIPv4","linkLocal","cgnat","unspecified","multicast","reserved"];
export const ALLOWED_UNDER_PRIVATE: readonly string[] = ["privateIPv4"];
export const END_LABELS_ADMIN: Readonly<Record<string, string>> = {"loopback":"loopback","privateIPv4":"private-lan","linkLocal":"link-local","cgnat":"restricted","unspecified":"unspecified","multicast":"multicast","reserved":"reserved"};
