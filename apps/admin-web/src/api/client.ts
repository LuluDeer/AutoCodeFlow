import axios from 'axios';
import { useAuthStore } from '../store/auth';

const API_URL_INTERNAL = import.meta.env.VITE_API_URL_INTERNAL || '/api';
const API_URL_EXTERNAL = import.meta.env.VITE_API_URL_EXTERNAL || '';

function getApiBaseUrl(): string {
  const useExternal = localStorage.getItem('autoflow_use_external_api') === 'true';
  if (useExternal && API_URL_EXTERNAL) {
    return API_URL_EXTERNAL;
  }
  return API_URL_INTERNAL;
}

export const client = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: 30000,
});

export function setApiEnvironment(useExternal: boolean): void {
  localStorage.setItem('autoflow_use_external_api', String(useExternal));
  client.defaults.baseURL = useExternal && API_URL_EXTERNAL ? API_URL_EXTERNAL : API_URL_INTERNAL;
}

export function getApiEnvironment(): boolean {
  return localStorage.getItem('autoflow_use_external_api') === 'true';
}

export function getAvailableEnvironments(): { internal: string; external: string | null } {
  return {
    internal: API_URL_INTERNAL,
    external: API_URL_EXTERNAL || null,
  };
}

// Q-02: read token from the Zustand auth store — single source of truth.
client.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Track in-flight refresh to avoid concurrent refresh storms
let refreshPromise: Promise<string> | null = null;

async function tryRefreshToken(): Promise<string> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const { refreshToken, setToken, setRefreshToken } = useAuthStore.getState();
    if (!refreshToken) throw new Error('No refresh token');

    // Use a plain axios call to bypass our own response interceptor
    // and avoid an infinite 401 retry loop on the refresh endpoint itself.
    const resp = await axios.post(
      `${getApiBaseUrl()}/auth/refresh`,
      { refreshToken },
      { timeout: 10_000 },
    );
    // axios wraps the body in resp.data; our interceptor unwraps to resp.data for client calls
    const body = resp.data ?? resp;
    const accessToken: string = body.data?.accessToken ?? body.accessToken;
    const newRefresh: string | undefined = body.data?.refreshToken ?? body.refreshToken;
    if (!accessToken) throw new Error('Refresh response missing accessToken');
    setToken(accessToken);
    if (newRefresh) setRefreshToken(newRefresh);
    return accessToken;
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

client.interceptors.response.use(
  // Unwrap both axios layer (res.data) and the API envelope ({ code, data, message })
  (res) => {
    const body = res.data;
    if (body && typeof body === 'object' && 'code' in body && 'data' in body) {
      return body.data;
    }
    return body;
  },
  async (err) => {
    const originalRequest = err.config;
    // Avoid infinite retry loop on the refresh endpoint itself
    if (err.response?.status === 401 && !originalRequest._retried && !originalRequest.url?.includes('/auth/refresh')) {
      originalRequest._retried = true;
      try {
        const newToken = await tryRefreshToken();
        originalRequest.headers = originalRequest.headers ?? {};
        originalRequest.headers['Authorization'] = `Bearer ${newToken}`;
        return client(originalRequest);
      } catch {
        useAuthStore.getState().logout();
        window.location.href = '/login';
      }
    } else if (err.response?.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = '/login';
    }
    return Promise.reject(err.response?.data || err);
  },
);
