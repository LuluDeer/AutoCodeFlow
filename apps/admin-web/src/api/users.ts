import { apiClient } from './client';

export interface User {
  id: number;
  username: string;
  email: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserDto {
  username: string;
  email: string;
  password: string;
  role?: string;
}

export interface UpdateUserDto {
  username?: string;
  email?: string;
  password?: string;
  role?: string;
}

export const usersApi = {
  list: (page = 1, pageSize = 20) =>
    apiClient.get<{ list: User[]; total: number; page: number; pageSize: number }>(
      `/users?page=${page}&pageSize=${pageSize}`,
    ),

  create: (data: CreateUserDto) =>
    apiClient.post<User>('/users', data),

  update: (id: number, data: UpdateUserDto) =>
    apiClient.patch<User>(`/users/${id}`, data),

  remove: (id: number) =>
    apiClient.delete<{ deleted: boolean }>(`/users/${id}`),
};
