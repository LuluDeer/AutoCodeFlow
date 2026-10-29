/**
 * NF-02: 任务上游依赖（编排）表单的纯逻辑层。
 * 独立成文件与 executor-mode.ts 同理由：react-refresh（组件文件只导出组件）
 * 与可测性。
 *
 * ## 后端契约：两端各读一半（FIX-1.1 定死，G6 第二步补全 key 的语义）
 *
 * tasks.dependencies jsonb = **Record<显示名快照, 上游任务id>**：
 *
 *  - **value = 上游依赖的任务 ID**，唯一的**语义位**。后端环检测
 *    （checkCircularDependency/detectCycle）、依赖满足判定（checkDependencies）、
 *    上游 SUCCESS 扇出匹配（triggerDependentTasks 的
 *    `Object.values(...).includes(completedTaskId)`）与前端 DAG 图
 *    （dag-layout.ts）全部按 **value=id** 消费。
 *  - **key = 展示名快照 + G6 的依赖别名本身**——**key 参与语义**，不是装饰。
 *    `$upstream("别名")` / `$upstream("别名").result.foo` 里的别名就是**本任务
 *    dependencies 映射的键**：admin-api `task.service.ts` 侧由
 *    `UPSTREAM_ALIAS_SENTINEL_RE` 解析出别名，扇出时按
 *    `Object.entries(task.dependencies)` 逐键建 aliasCtxs（本次触发的那一个上游
 *    直接用刚终态的执行行，其余按"各自最新一次执行"）。改 key = 改下游脚本
 *    能引用的别名；契约里**没有**独立的 alias 字段，别名只存在于这个键上。
 *    所以"把 key 当纯展示别名随手改"会直接改坏下游脚本的取数。
 *
 * 别名形态约束（后端正则，解析期**不做**"别名必须存在"的校验——dependencies
 * 与 params 可分次 PATCH）：1–64 字符、不含 `"` 与 `\`、**大小写敏感**；未知
 * 别名运行期解析为 **null**（不报错、不保留哨兵原串）。而任务名上限 255 码点
 * 且允许任意语言——**名字超过 64 字符或含 `"` 的上游无法被
 * `$upstream("名字")` 引到**，只能落到 id 形态的 key（见下方降级分支）。
 *
 * 前端快照行为（决定别名什么时候"跑掉"；读代码确认，不是猜测）：
 *  - key 取自 `depNameSnapshotRef`：候选列表播种 + 编辑态回填（**存量的键**）
 *    + 模板预填三路，**加载时定格**；
 *  - **上游改名不会回写下游已存的 key**——编辑态回填用存量键整体覆盖快照，
 *    候选播种只补缺失 id 且不覆盖已有键，所以"上游改名 → 下游再保存"仍把
 *    旧名写回去。于是"改名后别名失效"是**真的**：`$upstream("旧名")` 继续命中，
 *    `$upstream("新名")` 得到 null。要跟新名字，必须在下游表单里取消再重选该
 *    上游（或直接改 API 的 key）；
 *  - 快照缺失（任务刚被删除等竞态）/ 两个上游同名（key 冲突）时 key 降级为
 *    **taskId**：value 语义位不丢，但该上游的"显示名形态"别名随之不可用
 *    （此时 `$upstream("<taskId>")` 反而命中）；
 *  - UI 既不展示也不可编辑已存的 key（Select 只显示任务**当前**名）——排查
 *    别名问题请直接读该任务的 `dependencies` 键，不要按界面上看到的名字猜。
 *
 * 旧实现把映射写成 {taskId: taskName}（value=名字），导致扇出匹配/环检测/DAG
 * 图对 UI 建链静默失效——本文件已随契约翻转，存量 {uuid→name} 行由迁移
 * 1790000000048 幂等翻转。
 *
 * 上游全部最近执行 SUCCESS 时由 task.service.triggerDependentTasks
 * 自动扇出触发下游。
 */

/** 表单控件值：Select 的 value=taskId，label 由 options 提供（taskName）。 */
export type DependencySelection = string[];

/**
 * 提交序列化：选中 taskId 列表 → 后端 dependencies 映射。
 *  - **value 恒为上游任务 id**（后端按 value 做环检测与扇出——见文件头契约）；
 *  - key 取加载时的显示名快照（nameSnapshot）：它既是人读标签，**也是
 *    `$upstream("key")` 的别名**（G6）。快照是加载时定格的，上游改名后这里
 *    仍写回旧名（改名不刷新别名，见文件头「前端快照行为」）——想在脚本里用
 *    新名字取数的人必须先在表单里重选该上游；
 *    快照缺失（任务刚被删除等竞态）时 key 与 value 同用 taskId——该上游于是
 *    只剩 id 形态的别名可用。这里**不再**做「value 兜底为 id」的反向兜底
 *    （旧实现 value=名字会让后端扇出静默失效）；
 *  - 同名上游任务（key 冲突）时后者降级为 key=id，保证 value（语义位）永不丢；
 *  - 空集必须**显式 null** 而非缺省/delete——PATCH 是 Object.assign 语义
 *    （N28 教训：缺省字段=保留旧值），清空全部依赖不发 null 会
 *    「界面已清空、后端仍保留旧依赖链」。
 */
export function buildDependenciesPayload(
  selected: DependencySelection | undefined,
  nameSnapshot: Record<string, string>,
): Record<string, string> | null {
  if (!Array.isArray(selected) || selected.length === 0) return null;
  const map: Record<string, string> = {};
  for (const id of selected) {
    // key = 显示名（缺省回退 id），同时是 $upstream("key") 的别名来源；
    // value 恒为任务 id（后端语义位）。
    const key = nameSnapshot[id] ?? id;
    // key 冲突（两个上游同名）：别名可牺牲、语义位不可——降级 key=id
    //（该上游此后只能用 $upstream("<taskId>") 引，名字形态的别名不再命中）。
    if (map[key] !== undefined && map[key] !== id) {
      map[id] = id;
    } else {
      map[key] = id;
    }
  }
  return map;
}

/**
 * 提交序列化（完整版）：读取表单载体字段 upstreamDependencies（Select 值 =
 * taskId 列表），写入 DTO 声明的 dependencies 映射，并**删除载体字段本身**。
 *
 * 删除载体是硬性要求（QA-01 / e2e 例 23-24 连红根因）：全局 ValidationPipe 开启
 * whitelist + forbidNonWhitelisted，而 CreateTaskDto 只声明 dependencies、未声明
 * upstreamDependencies。编辑态 setFieldValue 恒把该字段置为数组（无依赖时 []），
 * 未删除则 PATCH 请求体携带未声明键 -> 后端 400 -> 前端弹「更新失败」，表现为
 * 「界面已切换、服务端旧值不变」（例 23/24 的 executeMode 断言超时是次生症状）。
 *
 * 必须 delete 而非置 null/undefined：whitelist 按 Object.keys 判定键是否声明，
 * 值为 null 的未声明键同样触发 400；只有 delete 才能让键彻底不出现在请求体里。
 */
export function applyDependenciesPayload(
  values: Record<string, unknown>,
  nameSnapshot: Record<string, string>,
): Record<string, unknown> {
  const payload = { ...values };
  payload.dependencies = buildDependenciesPayload(
    payload.upstreamDependencies as DependencySelection | undefined,
    nameSnapshot,
  );
  delete payload.upstreamDependencies;
  return payload;
}

/**
 * 编辑态回填：后端 dependencies 映射（Record<显示名, 上游任务id>）→
 * Select 值（taskId 列表，取 **value**）+ 名称快照（taskId → 显示名，
 * 供提交时重建映射，避免再拉一次任务列表）。
 *
 * 快照里的 key 是**上次保存时的显示名**，不是上游**现在**的名字：这里刻意
 * 不查任务列表刷新名称（省一次往返），所以"上游改名 → 下游再保存"会把旧名
 * 原样写回，别名保持不变——`$upstream("旧名")` 仍命中、新名不命中。要迁移到
 * 新名字只能重选上游（见文件头「前端快照行为」）。
 */
export function dependenciesFormValues(
  deps: Record<string, string> | null | undefined,
): { selected: DependencySelection; nameSnapshot: Record<string, string> } {
  if (!deps) return { selected: [], nameSnapshot: {} };
  const selected: DependencySelection = [];
  const nameSnapshot: Record<string, string> = {};
  for (const [displayName, id] of Object.entries(deps)) {
    // value=id 是语义位（Select 的值）；key=显示名进快照，提交时既是展示名
    // 也是 $upstream("key") 的别名（G6，见文件头）。
    selected.push(id);
    nameSnapshot[id] = displayName;
  }
  return { selected, nameSnapshot };
}

/** UUID v4 形态（大小写不敏感）——后端依赖类错误消息里裸拼的 taskId 形态。 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * F-8（本轮审计）：把错误消息里裸拼的 taskId（UUID）替换为任务名。
 *
 * 后端依赖类校验（循环依赖/依赖不存在等，task.service 循环依赖分支）把
 * taskId 原样拼进 message——用户看到一串 UUID 无从对上是哪个任务。表单持有
 * id→显示名快照（depNameSnapshotRef：依赖候选列表 + 编辑态回填两路播种），
 * 提交失败 toast 前做一次替换；映射不到（任务刚被删除/快照未含）保持原文，
 * 绝不编造。
 */
export function humanizeDependencyTaskIds(
  msg: string,
  nameSnapshot: Record<string, string> | null | undefined,
): string {
  if (!msg || !nameSnapshot) return msg;
  return msg.replace(UUID_RE, (uuid) => {
    // 快照键与消息中 UUID 的大小写可能不同（后端小写、展示源原样），三态兜底。
    const hit =
      nameSnapshot[uuid] ??
      nameSnapshot[uuid.toLowerCase()] ??
      nameSnapshot[uuid.toUpperCase()];
    return hit ?? uuid;
  });
}
