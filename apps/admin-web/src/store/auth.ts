import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface AuthUser {
  id: number;
  username: string;
  email?: string;
}

interface AuthState {
  token: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  _hasHydrated: boolean;
  setToken: (token: string) => void;
  setRefreshToken: (refreshToken: string) => void;
  setAuth: (token: string, refreshToken: string, user: AuthUser) => void;
  setUser: (user: AuthUser) => void;
  logout: () => void;
  setHasHydrated: (state: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      refreshToken: null,
      user: null,
      _hasHydrated: false,
      setToken: (token) => set({ token }),
      setRefreshToken: (refreshToken) => set({ refreshToken }),
      setAuth: (token, refreshToken, user) => set({ token, refreshToken, user }),
      setUser: (user) => set({ user }),
      logout: () => { set({ token: null, refreshToken: null, user: null }); },
      setHasHydrated: (state) => set({ _hasHydrated: state }),
    }),
    {
      name: 'autoflow-auth',
      storage: createJSONStorage(() => localStorage),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);
