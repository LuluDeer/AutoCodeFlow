import { client } from './client';

// B-5（私有包仓库域审计）：PypiPackage / PypiFile / getPypiPackage 已删除——
// 该函数是坏契约的潜伏代码（裸 fetch 直连 registry-pypi:8003：不带凭据——
// 索引面 S9 起要求 Basic、无 resp.ok 检查、name 未编码、catch 吞错返回 []），
// 且全仓无页面调用。将来若需要包详情，走 admin-api 代理（同 listPypiPackages
// 的先例），不要直连仓库端口。

export interface NpmPackage {
  name: string;
  versions: string[];
  description?: string;
  latest?: string;
}

// PyPI registry
export const registryApi = {
  // List all PyPI packages — proxied through admin-api to avoid CORS/auth issues.
  // UI-16：不再 try/catch 吞错返回 []（失败与空态语义分离），错误透出给页面
  // StateError 呈现（对齐 taskTemplatesApi.list 透出先例）。
  listPypiPackages: async (signal?: AbortSignal): Promise<string[]> => {
    const resp = signal
      ? await client.get('/registry/pypi/packages', { signal }) as { packages: string[] }
      : await client.get('/registry/pypi/packages') as { packages: string[] };
    return resp.packages ?? [];
  },

  // Upload PyPI package through admin-api proxy
  // F-5（UIUX 审计 P2-4）：PyPI 包上传是 multipart 大包传输（弱网下可达数十
  // 上百 MB），30s 全局超时会掐断在途上传——服务端可能仍在接收，重传造成
  // 重复包。显式 timeout:0 不限时（上传期间 RegistryPage 有 uploading 态）。
  uploadPypiPackage: async (form: FormData): Promise<void> => {
    await client.post('/registry/pypi/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 0,
    });
  },

  // List npm packages — proxied through admin-api（UI-16：同 PyPI，错误透出）
  listNpmPackages: async (signal?: AbortSignal): Promise<NpmPackage[]> => {
    const resp = signal
      ? await client.get('/registry/npm/packages', { signal }) as { packages: NpmPackage[] }
      : await client.get('/registry/npm/packages') as { packages: NpmPackage[] };
    return resp.packages ?? [];
  },
};
