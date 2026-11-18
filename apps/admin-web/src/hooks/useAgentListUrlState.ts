import { useSearchParams } from 'react-router-dom';
import { agentSessionTab } from '../utils/agentSessionUrl';

function positiveInt(raw: string | null, fallback: number, max: number): number {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

/** Read directly from the router, including Back/Forward and links on the same route.
 * Each gesture changes all its fields in one navigation: setSearchParams does not
 * queue multiple functional updates the way React state setters do. */
export function useAgentListUrlState() {
  const [params, setParams] = useSearchParams();
  const pageSize = positiveInt(params.get('pageSize'), 20, 100);
  const patch = (fields: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(fields)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  };
  return {
    page: positiveInt(params.get('page'), 1, 10000), pageSize,
    kindFilter: params.get('kind') || undefined,
    statusFilter: params.get('status') || undefined,
    stalledOnly: params.get('stalled') === '1',
    sessionId: params.get('session'), tab: agentSessionTab(params.get('tab')),
    approvalKey: params.get('tab') === 'approvals' ? params.get('approvalKey') : null,
    paginate: (page: number, size: number) => patch({
      page: page > 1 && size === pageSize ? String(page) : undefined,
      pageSize: size === 20 ? undefined : String(size),
    }),
    filterKind: (kind?: string) => patch({ kind, page: undefined }),
    filterStatus: (status?: string) => patch({ status, stalled: undefined, page: undefined }),
    showStalled: () => patch({ stalled: '1', status: undefined, page: undefined }),
    clearStalled: () => patch({ stalled: undefined, page: undefined }),
    clearFilters: () => patch({ kind: undefined, status: undefined, stalled: undefined, page: undefined }),
    selectSession: (id?: string) => patch({ session: id, tab: undefined, approvalKey: undefined }),
    selectTab: (key: string) => patch({ tab: key === 'steps' ? undefined : agentSessionTab(key), approvalKey: undefined }),
  };
}
