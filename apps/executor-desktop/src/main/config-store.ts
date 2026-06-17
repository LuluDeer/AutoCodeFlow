import Store from 'electron-store';
import * as os from 'os';
import { app } from 'electron';
import * as path from 'path';

export interface AppConfig {
  configured: boolean;
  adminApiUrl: string;
  executorName: string;
  executorHost: string;
  executorPort: number;
  executorAddressPublic: string;
  executorToken: string;
  workDir: string;
  maxConcurrentTasks: number;
  autoStart: boolean;
  autoStartExecutor: boolean;
  logLevel: 'info' | 'debug' | 'error';
}

const schema = {
  configured: { type: 'boolean', default: false },
  adminApiUrl: { type: 'string', default: '' },
  executorName: { type: 'string', default: os.hostname() },
  executorHost: { type: 'string', default: '0.0.0.0' },
  executorPort: { type: 'number', default: 8002 },
  executorAddressPublic: { type: 'string', default: '' },
  executorToken: { type: 'string', default: '' },
  workDir: { type: 'string', default: '' },
  maxConcurrentTasks: { type: 'number', default: 10 },
  autoStart: { type: 'boolean', default: false },
  autoStartExecutor: { type: 'boolean', default: true },
  logLevel: { type: 'string', default: 'info' },
} as const;

export class ConfigStore {
  private store: Store<AppConfig>;

  constructor() {
    this.store = new Store<AppConfig>({ schema: schema as any });
    // 初始化 workDir 默认值
    if (!this.store.get('workDir')) {
      this.store.set('workDir', path.join(app.getPath('userData'), 'tasks'));
    }
  }

  getAll(): AppConfig {
    return this.store.store as AppConfig;
  }

  save(config: Partial<AppConfig>): void {
    for (const [k, v] of Object.entries(config)) {
      this.store.set(k as keyof AppConfig, v);
    }
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.store.get(key) as AppConfig[K];
  }
}
