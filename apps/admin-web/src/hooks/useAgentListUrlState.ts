/**
 * R199 · Agent 会话列表的 **URL 深链同步**（筛选 / 分页 ⇄ 查询参数）。
 *
 * ## 为什么要抽出来（不是「为了少写几行」）
 *
 * ① `AgentSessionsPage` 在 `check:size-caps` 的**逐文件只减不增**基线上**双顶格**
 *    （`nonCommentLines` 1042/1042、`functionLines` 1029/1029）⇒ R199 要给页面加
 *    「卡住」徽标与筛选，若不外提就**必然破顶**。本模块是页面里**最独立的一块职责**
 *    （不碰任何会话数据、只碰 URL），抽出去最干净。
 * ② URL 同步是**容易出错**的一段（非法深链值要回落、默认值不写进 URL、
 *    回写要用 `replace` 不制造历史记录）⇒ 独立成模块后**可以单独测**。
 *
 * ## 语义（**必须保持不变** —— URL-SYNC-01 既有契约）
 *
 * · **读（初始源）**：`?page` / `?pageSize` / `?kind` / `?status`。
 *   非法深链值（`?page=abc`、负数、浮点）**回落默认值**，**不空屏不报错**。
 * · **写（回写）**：只用 `replace`（不制造历史记录）；**默认值不写入**
 *   （`page=1` / `pageSize=20` / 无筛选 ⇒ URL 保持干净）。
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

export interface AgentListUrlState {
  page: number;
  setPage: (n: number) => void;
  pageSize: number;
  setPageSize: (n: number) => void;
  kindFilter: string | undefined;
  setKindFilter: (v: string | undefined) => void;
  statusFilter: string | undefined;
  setStatusFilter: (v: string | undefined) => void;
}

/** 合法正整数才认；否则回落 `fallback`（非法深链不空屏、不报错）。 */
function readPositiveInt(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function useAgentListUrlState(): AgentListUrlState {
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(() =>
    readPositiveInt(searchParams.get("page"), 1),
  );
  const [pageSize, setPageSize] = useState(() =>
    readPositiveInt(searchParams.get("pageSize"), 20),
  );
  const [kindFilter, setKindFilter] = useState<string | undefined>(
    () => searchParams.get("kind") || undefined,
  );
  const [statusFilter, setStatusFilter] = useState<string | undefined>(
    () => searchParams.get("status") || undefined,
  );

  useEffect(() => {
    const next = new URLSearchParams();
    if (page !== 1) next.set("page", String(page));
    if (pageSize !== 20) next.set("pageSize", String(pageSize));
    if (kindFilter) next.set("kind", kindFilter);
    if (statusFilter) next.set("status", statusFilter);
    setSearchParams(next, { replace: true });
  }, [page, pageSize, kindFilter, statusFilter, setSearchParams]);

  return {
    page,
    setPage,
    pageSize,
    setPageSize,
    kindFilter,
    setKindFilter,
    statusFilter,
    setStatusFilter,
  };
}
