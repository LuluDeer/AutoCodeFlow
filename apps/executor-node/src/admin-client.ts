import axios, { AxiosInstance, AxiosResponse, AxiosError } from 'axios';
import { config } from './config';
import { logger } from './logger';
import { getCurrentToken } from './middleware/auth';

let adminUrls: string[] = [];
let currentIndex = 0;

export function initAdminClients(urls: string[]): void {
  adminUrls = urls.filter(url => url.trim());
  if (adminUrls.length === 0) {
    throw new Error('No admin URLs configured');
  }
  logger.info(`Initialized ${adminUrls.length} admin server(s): ${adminUrls.join(', ')}`);
}

export function getCurrentAdminUrl(): string {
  return adminUrls[currentIndex];
}

export function getAllAdminUrls(): string[] {
  return [...adminUrls];
}

export function failover(): void {
  currentIndex = (currentIndex + 1) % adminUrls.length;
  logger.warn(`Failed over to admin server: ${adminUrls[currentIndex]}`);
}

export async function request<T = any>(
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  data?: Record<string, any>,
  retryCount: number = adminUrls.length,
): Promise<AxiosResponse<T>> {
  const token = await getCurrentToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  for (let i = 0; i < retryCount; i++) {
    try {
      const client: AxiosInstance = axios.create({
        baseURL: adminUrls[currentIndex],
        timeout: 10_000,
        headers,
      });

      const response = await client.request({
        method,
        url: path,
        data,
      });

      return response;
    } catch (error: any) {
      logger.warn(`Request to admin ${adminUrls[currentIndex]} failed: ${error.message}`);
      
      if (i < retryCount - 1) {
        failover();
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        throw new Error(`All ${adminUrls.length} admin servers are unavailable`);
      }
    }
  }

  throw new Error('Request failed after all retries');
}

export async function get<T = any>(path: string): Promise<AxiosResponse<T>> {
  return request('get', path);
}

export async function post<T = any>(path: string, data?: Record<string, any>): Promise<AxiosResponse<T>> {
  return request('post', path, data);
}

export async function put<T = any>(path: string, data?: Record<string, any>): Promise<AxiosResponse<T>> {
  return request('put', path, data);
}

export async function del<T = any>(path: string): Promise<AxiosResponse<T>> {
  return request('delete', path);
}