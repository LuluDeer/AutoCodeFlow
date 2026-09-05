import axios from 'axios';
import { getApiBaseUrl } from './client';
import { useAuthStore } from '../store/auth';

export async function logoutRemote(): Promise<void> {
  const token = useAuthStore.getState().token;
  try {
    if (token) {
      await axios.post(`${getApiBaseUrl()}/auth/logout`, undefined, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 4000,
      });
    }
  } catch {
    // Remote revocation is best-effort; local logout must always complete.
  } finally {
    useAuthStore.getState().logout();
  }
}
