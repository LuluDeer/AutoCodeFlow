import { client } from './client';

export interface Executor {
  id: string;
  appName: string;
  address: string;
  status: string;
  type?: string;
  version?: string;
  cpuUsage: number;
  memUsage: number;
  runningTaskCount: number;
  lastHeartbeat: string;
}

export const executorsApi = {
  list: () => client.get<any, Executor[]>('/executors'),
};
