import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AuthUser {
  id: number;
  username: string;
  email?: string;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  setToken: (token: string) => void;
  setUser: (user: AuthUser) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      // Q-02: token is persisted via zustand persist to key 'autoflow-auth'.
      // Do NOT also write to a separate 'token' key — client.ts reads from 'autoflow-auth'.
      setToken: (token) => set({ token }),
      setUser: (user) => set({ user }),
      logout: () => { set({ token: null, user: null }); },
    }),
    { name: 'autoflow-auth', partialize: (s) => ({ token: s.token, user: s.user }) },
  ),
);
