import type { components } from '../types/generated/api-types';
import { client as apiClient } from './client';

// N-12（2026-10-07）：请求 DTO 切生成类型（此前手写副本与契约漂移两处——
// role 被渲染成必填、currentPassword 根本不在契约里，均已修后端+生成器）。
// 读模型 User 保持手写（前端读模型是唯一事实源，见 api/tasks.ts 头注同款决策）。
export type CreateUserDto = components['schemas']['CreateUserDto'];
// P1-1（对齐后端 ad5bdef4）：isActive 启用/禁用写面。后端 UpdateUserDto 是
// PartialType(CreateUserDto)——所有字段可选；生成类型对带 default 的枚举字段
// 误标必填，这里按后端契约整体 Partial 校正（只修类型消费，不改请求行为）。
export type UpdateUserDto = Partial<components['schemas']['UpdateUserDto']> & {
  /** 账号启用/禁用（ADMIN-only；禁用后在途会话与 API-Key 立即失效） */
  isActive?: boolean;
};

export interface User {
  id: number;
  username: string;
  email: string;
  role: string;
  createdAt: string;
  updatedAt: string;
  // WEB-TYPE-FIELD-DRIFT 收缩：读面字段逐项从 UserResponseDto 派生（与 api/tasks.ts
  // 的 Task/TaskExecution 同款先例）。optional 只表达「旧响应可能缺席」，类型语义
  // 仍由生成 schema 单一持有；页面据此直接读 isActive/totpEnabled，不再用本地
  // interface 扩展或 `as { totpEnabled?: boolean }` 断言绕过契约。
  isActive?: components['schemas']['UserResponseDto']['isActive'];
  totpEnabled?: components['schemas']['UserResponseDto']['totpEnabled'];
  lastTotpCounter?: components['schemas']['UserResponseDto']['lastTotpCounter'];
  lockedUntil?: components['schemas']['UserResponseDto']['lockedUntil'];
  loginFailCount?: components['schemas']['UserResponseDto']['loginFailCount'];
  sessionVersion?: components['schemas']['UserResponseDto']['sessionVersion'];
}


export const usersApi = {
  // USER-SEARCH-01：可选 search——后端 ListUsersDto 对 username/email 做
  // ILIKE 模糊匹配（前端只传参，不再前端 filter 当页数据）。
  list: (page = 1, pageSize = 20, signal?: AbortSignal, search?: string) => {
    // 后端 PageQueryDto 对 pageSize 有 @Max(100)；超出会 400
    // "Validation failed: pageSize must not be greater than 100"。
    // 在此夹紧而不是信任调用方——契约违规应在 API 层被挡住，而不是让
    // 页面拿到一个 400 后只显示泛化错误（成员面板曾因此整块不可用）。
    const safePageSize = Math.min(Math.max(1, Math.trunc(pageSize) || 20), 100);
    const url = `/users?page=${page}&pageSize=${safePageSize}${
      search ? `&search=${encodeURIComponent(search)}` : ''
    }`;
    return signal
      ? apiClient.get<{ list: User[]; total: number; page: number; pageSize: number }>(
          url, { signal },
        )
      : apiClient.get<{ list: User[]; total: number; page: number; pageSize: number }>(
          url,
        );
  },

  /**
   * 取全部用户（跨页），供"需要完整候选清单"的选择器使用。
   *
   * 为什么需要它：单次请求上限 100（见上），而成员面板此前写死
   * `list(1, 200)` 想一次拿 200 个——既必然 400，又即便放宽也仍会在
   * 用户数 >200 时静默截断。这里按 total 翻页取全，调用方无需关心分页。
   *
   * 对齐 tasksApi.listAll 的既有约定：先校验首请求的 total，再按 total
   * 逐页取；`maxPages` 兜底避免 total 异常大时无限翻页打爆后端。
   */
  listAll: async (signal?: AbortSignal, maxPages = 20): Promise<User[]> => {
    const PAGE_SIZE = 100; // 后端 @Max(100) 上限，取满以减少往返
    const first = await usersApi.list(1, PAGE_SIZE, signal);
    const all = [...(first.list ?? [])];
    const total = first.total ?? all.length;
    if (!Number.isInteger(total) || total < 0) {
      // total 不可信时不做翻页猜测——返回已拿到的这一页，好过空转或抛错，
      // 毕竟这是"选人"的辅助清单，不是关键数据面。
      return all;
    }
    const totalPages = Math.min(Math.ceil(total / PAGE_SIZE), maxPages);
    for (let page = 2; page <= totalPages; page++) {
      if (signal?.aborted) break;
      const next = await usersApi.list(page, PAGE_SIZE, signal);
      const batch = next.list ?? [];
      if (batch.length === 0) break; // total 虚高时提前收敛
      all.push(...batch);
    }
    return all;
  },

  create: (data: CreateUserDto) =>
    apiClient.post<User>('/users', data),

  update: (id: number, data: UpdateUserDto) =>
    apiClient.patch<User>(`/users/${id}`, data),

  remove: (id: number) =>
    apiClient.delete<{ deleted: boolean }>(`/users/${id}`),
};
