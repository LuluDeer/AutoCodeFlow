import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  token: string | null;
  user: any | null;
  setToken: (token: string) => void;
  setUser: (user: any) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setToken: (token) => { set({ token }); localStorage.setItem('token', token); },
      setUser: (user) => set({ user }),
      logout: () => { set({ token: null, user: null }); localStorage.removeItem('token'); },
    }),
    { name: 'autoflow-auth', partialize: (s) => ({ token: s.token, user: s.user }) },
  ),
);
