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
      setToken: (token) => set({ token }),
      setUser: (user) => set({ user }),
      logout: () => { set({ token: null, user: null }); },
    }),
    {
      name: 'autoflow-auth',
      // FE-01: Only persist user metadata, NOT the access token.
      // The token is kept in memory only; on page refresh the app silently
      // re-fetches a new token via the /auth/refresh endpoint.
      // Keeping the token out of localStorage prevents XSS token theft.
      partialize: (s) => ({ user: s.user }),
    },
  ),
);
