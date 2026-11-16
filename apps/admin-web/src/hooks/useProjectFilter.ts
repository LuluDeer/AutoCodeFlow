import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * P1-2：全局「当前项目」上下文——四个工作面（Dashboard / 任务 / 执行 / 应用）
 * 共用同一个 URL 查询参数 `?project=<id|all|default>`。
 *
 * ## 取值契约
 *
 * | URL 值        | 语义                                   | 后端 projectId            |
 * |---------------|----------------------------------------|---------------------------|
 * | 缺省 / `all`  | 全部项目（默认口径）                   | `undefined`（不传）       |
 * | `default`     | 默认项目视图：未分配 + 默认项目两类行  | `"default"`（字面量）     |
 * | 项目 UUID     | 具体项目                               | 该 UUID                   |
 *
 * 与任务/执行/应用/metrics 后端过滤口径同源；切换器在 MainLayout 写入，
 * 各页面只读本 hook，不各自维护项目状态——深链、刷新、面包屑跳转都不丢上下文。
 *
 * ## 为什么是 URL 而不是全局 store
 *
 * 项目上下文必须可分享（深链直达某项目的任务列表）、刷新保持、从任务详情跳
 * 执行详情时不丢——URL 是唯一天然满足这三点的载体；store 还得额外做持久化
 * 与跨路由同步。本 hook 不碰其他筛选参数（各页面自己的 useUrlStateSync 受控键
 * 互不重叠），只 set/delete `project` 这一个键。
 */

export const PROJECT_FILTER_PARAM = 'project';
export const PROJECT_FILTER_ALL = 'all';
export const PROJECT_FILTER_DEFAULT = 'default';

export type ProjectFilterValue = typeof PROJECT_FILTER_ALL | typeof PROJECT_FILTER_DEFAULT | string;

/** UUID 形状（含后端 version-0 的默认项目 UUID；不做版本位校验，见 constants/project.ts 头注）。 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 非法/残留脏值回落「全部项目」，不把用户卡在空态。 */
function normalize(raw: string | null): ProjectFilterValue {
  if (raw === null || raw === '' || raw === PROJECT_FILTER_ALL) return PROJECT_FILTER_ALL;
  if (raw === PROJECT_FILTER_DEFAULT) return PROJECT_FILTER_DEFAULT;
  return UUID_SHAPE.test(raw) ? raw : PROJECT_FILTER_ALL;
}

export interface ProjectFilter {
  /** 视图层当前选中值（'all' | 'default' | 项目 UUID）。 */
  projectId: ProjectFilterValue;
  /** 透传给后端的 projectId：'all' → undefined（不传参数）；其余原样。 */
  backendProjectId: string | undefined;
  /** 是否选中了具体项目（'all' 之外）。 */
  isScoped: boolean;
  /** 切换项目；传 'all' 时从 URL 删除该参数。其余查询参数原样保留。 */
  setProjectId: (value: ProjectFilterValue) => void;
}

export function useProjectFilter(): ProjectFilter {
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = useMemo(
    () => normalize(searchParams.get(PROJECT_FILTER_PARAM)),
    [searchParams],
  );

  const setProjectId = useCallback(
    (value: ProjectFilterValue) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === PROJECT_FILTER_ALL) next.delete(PROJECT_FILTER_PARAM);
          else next.set(PROJECT_FILTER_PARAM, value);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const backendProjectId = projectId === PROJECT_FILTER_ALL ? undefined : projectId;

  return {
    projectId,
    backendProjectId,
    isScoped: projectId !== PROJECT_FILTER_ALL,
    setProjectId,
  };
}
