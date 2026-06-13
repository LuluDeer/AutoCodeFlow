import { client } from './client';

export interface PypiPackage {
  name: string;
  files: PypiFile[];
}

export interface PypiFile {
  filename: string;
  url: string;
  sha256: string;
}

export interface NpmPackage {
  name: string;
  versions: string[];
  description?: string;
  latest?: string;
}

// PyPI registry
export const registryApi = {
  // List all PyPI packages — proxied through admin-api to avoid CORS/auth issues
  listPypiPackages: async (): Promise<string[]> => {
    try {
      const resp = await client.get('/registry/pypi/packages') as { packages: string[] };
      return resp.packages ?? [];
    } catch {
      return [];
    }
  },

  // Get files for a PyPI package (direct link; same origin in prod behind nginx)
  getPypiPackage: async (name: string): Promise<PypiFile[]> => {
    const pypiUrl = (import.meta.env.VITE_PYPI_URL as string | undefined) || 'http://localhost:8003';
    try {
      const resp = await fetch(`${pypiUrl}/simple/${name}/`);
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return Array.from(doc.querySelectorAll('a')).map(a => {
        const href = a.getAttribute('href') ?? '';
        return {
          url: href.split('#')[0],
          sha256: href.includes('#sha256=') ? href.split('#sha256=')[1] : '',
          filename: a.textContent ?? '',
        };
      }).filter(f => f.filename);
    } catch {
      return [];
    }
  },

  // Upload PyPI package through admin-api proxy
  uploadPypiPackage: async (form: FormData): Promise<void> => {
    await client.post('/registry/pypi/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  // List npm packages — proxied through admin-api
  listNpmPackages: async (): Promise<NpmPackage[]> => {
    try {
      const resp = await client.get('/registry/npm/packages') as { packages: NpmPackage[] };
      return resp.packages ?? [];
    } catch {
      return [];
    }
  },
};
